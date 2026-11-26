import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool, transaction } from "./db.ts";
import { ApiError, utcDate } from "./game.ts";
import {
  authorizationUrl,
  type TelegramConfig,
  TelegramOidcFailure,
  telegramOidc,
  verifyInitData,
} from "./telegram.ts";

const visitorCookie = "cineclue_visitor";
const sessionCookie = "__Host-cineclue_session";
const attemptCookie = "__Host-cineclue_login";
const miniAppHeader = "x-cineclue-mini-app";
const sessionLifetime = 14 * 86_400;
const attemptLifetime = 600;
const randomToken = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuidv4 = z.uuidv4();

function readCookie(req: Request, name: string) {
  const prefix = `${name}=`;
  return req.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

function setCookie(headers: Headers, name: string, value: string, age: number, secure = true) {
  headers.append(
    "Set-Cookie",
    `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure ? "; Secure" : ""}`,
  );
}

export function guestVisitor(req: Request, headers: Headers, secure: boolean) {
  const cookie = uuidv4.safeParse(readCookie(req, visitorCookie));
  if (cookie.success) return cookie.data;
  const visitor = randomUUID();
  setCookie(headers, visitorCookie, visitor, 31_536_000, secure);
  return visitor;
}

function tokenHash(req: Request, name: string) {
  const value = readCookie(req, name);
  return value && /^[\w-]{43}$/.test(value) ? hash(value) : null;
}

function scopedUuid(parts: string[]) {
  // Keep authenticated owners in the UUIDv8 namespace. Existing guest cookies use UUIDv4.
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex", 0, 16);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function localGameOwner(visitor: string, player?: string) {
  return player ? scopedUuid(["local", visitor, player]) : visitor;
}

const playerPath =
  /^\/(?:archive(?:\/\d{4}-\d{2}-\d{2})?\/?|(?:challenge|unlimited)(?:\/[a-f\d-]{36})?)?$/i;
type Player = { key: string; expiresInMs: number };
type Session = { player: Player | null; miniAppProof?: string; resumeMiniApp?: boolean };
type LoginAttempt = { nonce: string; verifier: string; return_path: string };
export const guestSession = { telegramBot: null, player: null, guestDaily: false };

export class TelegramSessions {
  readonly config: TelegramConfig;
  readonly exchange: ReturnType<typeof telegramOidc>;

  constructor(config: TelegramConfig) {
    this.config = config;
    this.exchange = telegramOidc(config);
  }

  private async lookup(hash: string, visitor: string) {
    const { rows } = await pool.query<Player & { mini_app: boolean }>(
      `SELECT player_id AS key, CEIL(EXTRACT(EPOCH FROM (expires_at-now()))*1000)::int AS "expiresInMs", mini_app
       FROM telegram_session WHERE visitor_id=$1 AND token_hash=$2 AND bot_id=$3 AND expires_at>now()`,
      [visitor, hash, this.config.clientId],
    );
    return rows[0] ?? null;
  }

  private miniAppProof(hash: string) {
    return createHmac("sha256", this.config.botToken)
      .update(`cineclue:mini-app:${hash}`)
      .digest("base64url");
  }

  async read(req: Request, visitor: string): Promise<Session> {
    const hash = tokenHash(req, sessionCookie);
    const row = hash ? await this.lookup(hash, visitor) : null;
    if (!row || !hash) return { player: null };
    const { mini_app: miniApp, ...player } = row;
    const supplied = req.headers.get(miniAppHeader);
    if (!miniApp) return { player: supplied === null ? player : null };
    if (supplied === "guest") return { player: null, resumeMiniApp: true };
    const proof = this.miniAppProof(hash);
    if (
      !supplied ||
      !/^[\w-]{43}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(proof), Buffer.from(supplied))
    ) {
      return { player: null };
    }
    return { player, miniAppProof: proof };
  }

  private async guestPlayedDaily(visitor: string) {
    const { rows } = await pool.query<{ played: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM daily_puzzle p JOIN game_session s ON s.puzzle_id=p.id
         WHERE p.puzzle_date=$1 AND s.visitor_id=$2 AND EXISTS (SELECT 1 FROM guess g WHERE g.game_id=s.id)
       ) AS played`,
      [utcDate(), visitor],
    );
    return rows[0].played;
  }

  async describe(player: Player | null, visitor: string) {
    const guestDaily = player ? await this.guestPlayedDaily(visitor) : false;
    return { telegramBot: this.config.botUsername, player, guestDaily };
  }

  async start(headers: Headers, visitor: string, returnTo: string) {
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    await pool.query(
      `INSERT INTO telegram_login_attempt(visitor_id,state_hash,nonce,verifier,return_path,expires_at)
       VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 second')
       ON CONFLICT(visitor_id) DO UPDATE SET
         state_hash=EXCLUDED.state_hash, nonce=EXCLUDED.nonce, verifier=EXCLUDED.verifier,
         return_path=EXCLUDED.return_path, expires_at=EXCLUDED.expires_at, claimed=false`,
      [
        visitor,
        hash(state),
        nonce,
        verifier,
        playerPath.test(returnTo) ? returnTo : "/",
        attemptLifetime,
      ],
    );
    setCookie(headers, attemptCookie, state, attemptLifetime);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { url: authorizationUrl(this.config, state, nonce, challenge) };
  }

  async callback(req: Request, headers: Headers, visitor: string, url: URL) {
    const redirect = (path: string, result: "signed-in" | "cancelled" | "failed") => {
      headers.set("Location", `${path}?telegram=${result}`);
      headers.set("Cache-Control", "no-store");
      headers.set("Referrer-Policy", "no-referrer");
      return new Response(null, { status: 303, headers });
    };
    const fail = (path: string, reason: string, failure?: TelegramOidcFailure) => {
      // Log fixed codes and HTTP status, never provider bodies or credentials.
      console.warn(
        JSON.stringify({
          event: "telegram_oidc_failed",
          reason,
          upstreamStatus: failure?.upstreamStatus,
          upstreamCode: failure?.upstreamCode,
        }),
      );
      return redirect(path, "failed");
    };
    const states = url.searchParams.getAll("state");
    const state = states[0];
    if (
      states.length !== 1 ||
      !/^[\w-]{43}$/.test(state) ||
      state !== readCookie(req, attemptCookie)
    ) {
      return fail("/", "callback_state");
    }
    const stateHash = hash(state);
    // Claim the code once, while keeping the attempt cancellable during the exchange.
    const { rows } = await pool.query<LoginAttempt>(
      `UPDATE telegram_login_attempt SET claimed=true
       WHERE visitor_id=$1 AND state_hash=$2 AND NOT claimed AND expires_at>now()
       RETURNING nonce,verifier,return_path`,
      [visitor, stateHash],
    );
    const attempt = rows[0];
    if (!attempt) return fail("/", "attempt_unavailable");
    const issuers = url.searchParams.getAll("iss");
    const codes = url.searchParams.getAll("code");
    const errors = url.searchParams.getAll("error");
    if (
      issuers.length > 1 ||
      (issuers.length === 1 && issuers[0] !== "https://oauth.telegram.org")
    ) {
      return fail(attempt.return_path, "callback_issuer");
    }
    if (errors.length === 1 && errors[0] === "access_denied" && codes.length === 0) {
      return redirect(attempt.return_path, "cancelled");
    }
    if (errors.length || codes.length !== 1 || !codes[0] || codes[0].length > 2048) {
      return fail(attempt.return_path, "callback_code");
    }
    let stage = "code_exchange";
    try {
      const id = await this.exchange(codes[0], attempt.verifier, attempt.nonce);
      stage = "session_creation";
      await this.signIn(headers, visitor, id, stateHash);
    } catch (error) {
      return error instanceof TelegramOidcFailure
        ? fail(attempt.return_path, error.reason, error)
        : fail(attempt.return_path, stage);
    }
    return redirect(attempt.return_path, "signed-in");
  }

  async miniApp(headers: Headers, visitor: string, initData: string) {
    const id = verifyInitData(initData, this.config.botToken);
    const guestDaily = await this.guestPlayedDaily(visitor);
    const session = await this.signIn(headers, visitor, id);
    return { telegramBot: this.config.botUsername, ...session, guestDaily };
  }

  async resumeMiniApp(req: Request, visitor: string, initData: string) {
    const hash = tokenHash(req, sessionCookie);
    const row = hash ? await this.lookup(hash, visitor) : null;
    if (!row?.mini_app || !hash) return this.describe(null, visitor);
    let id: number;
    try {
      id = verifyInitData(initData, this.config.botToken);
    } catch {
      return this.describe(null, visitor);
    }
    if (row.key !== this.playerId(id)) return this.describe(null, visitor);
    return {
      ...(await this.describe({ key: row.key, expiresInMs: row.expiresInMs }, visitor)),
      miniAppProof: this.miniAppProof(hash),
    };
  }

  private playerId(id: number) {
    return scopedUuid(["telegram", this.config.clientId, String(id)]);
  }

  private async signIn(headers: Headers, visitor: string, id: number, stateHash?: string) {
    const key = this.playerId(id);
    const token = randomToken();
    const tokenDigest = hash(token);
    const miniApp = stateHash === undefined;
    await transaction(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM telegram_login_attempt WHERE visitor_id=$1
         AND ($2::text IS NULL OR (state_hash=$2 AND claimed AND expires_at>now()))`,
        [visitor, stateHash ?? null],
      );
      if (!miniApp && rowCount !== 1) throw new ApiError(401, "telegram_invalid");
      // Only the current cookie for this browser can remain valid after a switch.
      await client.query(
        `INSERT INTO telegram_session(visitor_id,token_hash,bot_id,player_id,mini_app,expires_at)
         VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 second')
         ON CONFLICT(visitor_id) DO UPDATE SET
           token_hash=EXCLUDED.token_hash, bot_id=EXCLUDED.bot_id, player_id=EXCLUDED.player_id,
           mini_app=EXCLUDED.mini_app, expires_at=EXCLUDED.expires_at`,
        [visitor, tokenDigest, this.config.clientId, key, miniApp, sessionLifetime],
      );
    });
    setCookie(headers, sessionCookie, token, sessionLifetime);
    return {
      player: { key, expiresInMs: sessionLifetime * 1000 },
      ...(miniApp ? { miniAppProof: this.miniAppProof(tokenDigest) } : {}),
    };
  }

  async logout(req: Request, headers: Headers, visitor: string) {
    await transaction(async (client) => {
      await client.query("DELETE FROM telegram_login_attempt WHERE visitor_id=$1", [visitor]);
      await client.query(
        "DELETE FROM telegram_session WHERE visitor_id=$1 AND token_hash=$2 AND bot_id=$3",
        [visitor, tokenHash(req, sessionCookie), this.config.clientId],
      );
    });
    setCookie(headers, sessionCookie, "", 0);
    setCookie(headers, attemptCookie, "", 0);
    return this.describe(null, visitor);
  }
}

export async function cleanupTelegramSessions() {
  await pool.query(
    "DELETE FROM telegram_login_attempt WHERE expires_at<=now(); DELETE FROM telegram_session WHERE expires_at<=now()",
  );
}
