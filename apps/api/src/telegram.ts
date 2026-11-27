import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./game.ts";

const issuer = "https://oauth.telegram.org";
const callbackPath = "/api/auth/telegram/callback";
const initDataMaxAge = 600;
const clockSkew = 30;
const telegramId = z
  .number()
  .int()
  .positive()
  .max(2 ** 52 - 1);

export type TelegramConfig = {
  botToken: string;
  botUsername: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export function telegramConfig(origin: string, env = process.env): TelegramConfig | undefined {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const botUsername = env.TELEGRAM_BOT_USERNAME;
  const clientId = env.TELEGRAM_OIDC_CLIENT_ID;
  const clientSecret = env.TELEGRAM_OIDC_CLIENT_SECRET;
  if (!botToken && !botUsername && !clientId && !clientSecret) return undefined;
  if (
    !botToken ||
    !botUsername ||
    !/^[a-z0-9_]{5,32}$/i.test(botUsername) ||
    !clientId ||
    !/^[1-9]\d{0,15}$/.test(clientId) ||
    botToken.split(":", 1)[0] !== clientId ||
    !clientSecret
  ) {
    throw new Error("Configure the Telegram bot token, username and OIDC credentials for one bot");
  }
  if (!origin.startsWith("https://") || new URL(origin).origin !== origin) {
    throw new Error("Telegram requires an exact HTTPS PUBLIC_ORIGIN");
  }
  return { botToken, botUsername, clientId, clientSecret, redirectUri: origin + callbackPath };
}

export function verifyInitData(
  data: string,
  botToken: string,
  now = Math.floor(Date.now() / 1000),
) {
  const invalid = () => new ApiError(401, "telegram_invalid");
  const params = new URLSearchParams(data);
  const fields = new Map<string, string>();
  for (const [name, value] of params) {
    if (fields.has(name) || !/^[a-z][a-z_0-9]*$/.test(name) || /[\r\n]/.test(value)) {
      throw invalid();
    }
    fields.set(name, value);
  }
  const hash = fields.get("hash");
  if (!hash || !/^[a-f\d]{64}$/i.test(hash)) throw invalid();
  fields.delete("hash");
  const check = [...fields.keys()]
    .sort()
    .map((name) => `${name}=${fields.get(name)}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) throw invalid();

  const authDate = Number(fields.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate <= 0 || authDate > now + clockSkew) {
    throw invalid();
  }
  if (authDate < now - initDataMaxAge) throw new ApiError(401, "telegram_init_expired");
  let user: unknown;
  try {
    user = JSON.parse(fields.get("user") ?? "null");
  } catch {
    throw invalid();
  }
  const parsed = z.object({ id: telegramId }).safeParse(user);
  if (!parsed.success) throw invalid();
  return parsed.data.id;
}

const jwtHeader = z.object({ alg: z.literal("RS256"), kid: z.string().min(1).max(128) });
const claims = z.object({
  iss: z.literal(issuer),
  aud: z.string(),
  sub: z.string().min(1),
  // Telegram OIDC also serializes the profile ID as a decimal string.
  id: z.union([
    telegramId,
    z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/)
      .transform(Number)
      .pipe(telegramId),
  ]),
  nonce: z.string().optional(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  nbf: z.number().int().positive().optional(),
});
const rsaKey = z.object({
  kty: z.literal("RSA"),
  kid: z.string(),
  alg: z.literal("RS256").optional(),
  use: z.literal("sig").optional(),
  n: z.string(),
  e: z.string(),
});

type OidcFailureReason =
  | "token_request"
  | "token_response"
  | "jwks"
  | "id_token_header"
  | "id_token_key"
  | "id_token_signature"
  | "id_token_claims"
  | "id_token_nonce";

const tokenErrorCode = z.enum([
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);

const claimFields = claims.keyof();
type ClaimIssue = {
  field: z.infer<typeof claimFields> | "payload";
  code: string;
  receivedType?: string;
};

export class TelegramOidcFailure extends ApiError {
  constructor(
    readonly reason: OidcFailureReason,
    readonly details: {
      upstreamStatus?: number;
      upstreamCode?: z.infer<typeof tokenErrorCode>;
      claimIssues?: ClaimIssue[];
    } = {},
  ) {
    super(401, "telegram_invalid");
  }
}

function invalidClaims(...claimIssues: ClaimIssue[]) {
  return new TelegramOidcFailure("id_token_claims", { claimIssues });
}

function parseIdTokenClaims(encoded: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw invalidClaims({ field: "payload", code: "invalid_json" });
  }
  const parsed = claims.safeParse(payload);
  if (parsed.success) return parsed.data;
  throw invalidClaims(
    ...parsed.error.issues.map(({ path, code }): ClaimIssue => {
      const field = claimFields.safeParse(path[0]);
      if (path.length !== 1 || !field.success || payload === null || typeof payload !== "object") {
        return { field: "payload", code };
      }
      if (!Object.hasOwn(payload, field.data)) return { field: field.data, code: "missing" };
      const value: unknown = Reflect.get(payload, field.data);
      const receivedType = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
      return { field: field.data, code, receivedType };
    }),
  );
}

export function verifyIdToken(
  token: string,
  keys: unknown[],
  clientId: string,
  nonce: string,
  now = Math.floor(Date.now() / 1000),
) {
  let reason: OidcFailureReason = "id_token_header";
  try {
    if (token.length > 16_384 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
      throw new TelegramOidcFailure(reason);
    }
    const [header, payload, signature] = token.split(".");
    const { kid } = jwtHeader.parse(JSON.parse(Buffer.from(header, "base64url").toString("utf8")));
    reason = "id_token_key";
    const key = keys.find((value) => {
      const parsed = rsaKey.safeParse(value);
      return parsed.success && parsed.data.kid === kid;
    });
    if (!key) throw new TelegramOidcFailure(reason);
    const { n, e } = rsaKey.parse(key);
    const publicKey = createPublicKey({ key: { kty: "RSA", n, e }, format: "jwk" });
    reason = "id_token_signature";
    if (
      !verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      )
    ) {
      throw new TelegramOidcFailure(reason);
    }
    reason = "id_token_claims";
    const data = parseIdTokenClaims(payload);
    if (data.aud !== clientId) throw invalidClaims({ field: "aud", code: "mismatch" });
    if (data.exp <= now) throw invalidClaims({ field: "exp", code: "expired" });
    if (data.iat > now + clockSkew) throw invalidClaims({ field: "iat", code: "in_future" });
    if (data.exp <= data.iat) throw invalidClaims({ field: "exp", code: "not_after_iat" });
    if (data.nbf !== undefined && data.nbf > now + clockSkew) {
      throw invalidClaims({ field: "nbf", code: "in_future" });
    }
    if (data.nonce === undefined || data.nonce !== nonce) {
      throw new TelegramOidcFailure("id_token_nonce");
    }
    // Telegram documents the numeric user ID in profile separately from the OIDC subject.
    return data.id;
  } catch (error) {
    if (error instanceof TelegramOidcFailure) throw error;
    throw new TelegramOidcFailure(reason);
  }
}

export function authorizationUrl(
  config: TelegramConfig,
  state: string,
  nonce: string,
  challenge: string,
) {
  const url = new URL(`${issuer}/auth`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.href;
}

export function telegramOidc(config: TelegramConfig) {
  let cached: { keys: unknown[]; expires: number } | undefined;
  let pending: Promise<unknown[]> | undefined;
  async function loadKeys() {
    pending ??= fetch(`${issuer}/.well-known/jwks.json`, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new TelegramOidcFailure("jwks", { upstreamStatus: response.status });
        }
        const { keys } = z.object({ keys: z.array(z.unknown()) }).parse(await response.json());
        cached = { keys, expires: Date.now() + 3_600_000 };
        return keys;
      })
      .catch((error) => {
        if (error instanceof TelegramOidcFailure) throw error;
        throw new TelegramOidcFailure("jwks");
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }

  return async (code: string, verifier: string, nonce: string) => {
    let reason: OidcFailureReason = "token_request";
    try {
      const response = await fetch(`${issuer}/token`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: config.redirectUri,
          client_id: config.clientId,
          code_verifier: verifier,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const error = z.object({ error: tokenErrorCode }).safeParse(body);
        throw new TelegramOidcFailure(reason, {
          upstreamStatus: response.status,
          upstreamCode: error.data?.error,
        });
      }
      reason = "token_response";
      const { id_token } = z.object({ id_token: z.string() }).parse(await response.json());
      if (!cached || cached.expires <= Date.now()) {
        return verifyIdToken(id_token, await loadKeys(), config.clientId, nonce);
      }
      // Retry with fresh keys when Telegram rotates its signing key.
      try {
        return verifyIdToken(id_token, cached.keys, config.clientId, nonce);
      } catch {
        return verifyIdToken(id_token, await loadKeys(), config.clientId, nonce);
      }
    } catch (error) {
      if (error instanceof TelegramOidcFailure) throw error;
      throw new TelegramOidcFailure(reason);
    }
  };
}
