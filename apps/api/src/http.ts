import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { hintKinds, type MovieMedia } from "../../../packages/game-engine/src/model.ts";
import type { Catalog } from "./catalog.ts";
import { pool } from "./db.ts";
import { ApiError, Games } from "./game.ts";
import { MediaCatalog } from "./media.ts";
import { guestSession, guestVisitor, localGameOwner, TelegramSessions } from "./sessions.ts";
import type { TelegramConfig } from "./telegram.ts";

const uuid = z.uuid();
const hintBody = z.object({ kind: z.enum(hintKinds) }).strict();
const guessBody = z.object({ movieId: z.string().min(1).max(120) }).strict();
const dailyGuessBody = guessBody.extend({ gameId: uuid.optional() });
const archiveDate = z.iso.date().refine((date) => !date.startsWith("0000"));
const archiveOpenBody = z.strictObject({});
const archiveGuessBody = guessBody.extend({ gameId: uuid });
const archiveHintBody = hintBody.extend({ gameId: uuid });
const oidcStartBody = z.strictObject({ returnTo: z.string().max(128) });
const miniAppBody = z.strictObject({ initData: z.string().min(1).max(8192) });
const unlimitedBody = z
  .object({
    difficulty: z.enum(["easy", "normal", "hard"]).default("normal"),
    pack: z.string().max(80).default("popular"),
  })
  .strict();
async function body(req: Request, limit = 4096) {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new ApiError(415, "json_required");
  const chunks: Buffer[] = [];
  let size = 0;
  if (!req.body) throw new ApiError(400, "invalid_json");
  for await (const chunk of req.body) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, "body_too_large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};
export function createHandler(
  catalog: Catalog,
  secret: string,
  options: {
    media?: Record<string, MovieMedia>;
    origin?: string;
    secureCookies?: boolean;
    staticRoot?: string;
    rateLimit?: number;
    telegram?: TelegramConfig;
  } = {},
) {
  const games = new Games(catalog, secret);
  const media = new MediaCatalog(catalog, undefined, options.media);
  const telegram = options.telegram ? new TelegramSessions(options.telegram) : null;
  return async (req: Request, clientIp: string): Promise<Response> => {
    const headers = new Headers();
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "same-origin");
    headers.set("X-Frame-Options", "DENY");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://telegram.org/js/telegram-web-app.js; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://image.tmdb.org https://upload.wikimedia.org https://thumb.wikimedia.org; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    const send = (status: number, value: unknown) => {
      headers.set("Content-Type", "application/json; charset=utf-8");
      headers.set("Cache-Control", "no-store");
      return new Response(JSON.stringify(value), { status, headers });
    };
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      if (!path.startsWith("/api/")) {
        if (method !== "GET" || !options.staticRoot) throw new ApiError(404, "not_found");
        const root = resolve(options.staticRoot);
        let file = resolve(root, `.${decodeURIComponent(path)}`);
        if (file !== root && !file.startsWith(root + sep)) throw new ApiError(404, "not_found");
        try {
          if (!(await stat(file)).isFile()) file = resolve(root, "index.html");
        } catch {
          file = resolve(root, "index.html");
        }
        headers.set("Content-Type", mime[extname(file)] ?? "application/octet-stream");
        headers.set(
          "Cache-Control",
          file.includes(`${sep}assets${sep}`) ? "public,max-age=31536000,immutable" : "no-cache",
        );
        return new Response(await readFile(file), { headers });
      }
      if (method === "GET" && path === "/api/health") {
        await pool.query("SELECT 1");
        return send(200, { status: "ok", movies: catalog.movies.length });
      }
      const mediaRoute = path.match(/^\/api\/media\/([^/]+)$/);
      if (method === "GET" && mediaRoute) {
        const result = media.get(decodeURIComponent(mediaRoute[1]));
        if (!result) throw new ApiError(404, "not_found");
        headers.set("Content-Type", "application/json; charset=utf-8");
        headers.set("Cache-Control", "private,max-age=900");
        return new Response(JSON.stringify(await result), { headers });
      }
      if (method !== "GET" && method !== "POST") throw new ApiError(405, "method_not_allowed");
      if (method === "POST") {
        if (req.headers.get("origin") && req.headers.get("origin") !== options.origin)
          throw new ApiError(403, "invalid_origin");
        if (req.headers.get("sec-fetch-site") === "cross-site")
          throw new ApiError(403, "invalid_origin");
        if (!isIP(clientIp)) throw new ApiError(503, "client_identity_unavailable");
        const key = `${clientIp}:${Math.floor(Date.now() / 60000)}`;
        const limited = (
          await pool.query(
            "INSERT INTO rate_limit(key,expires_at) VALUES($1,now()+interval '2 minutes') ON CONFLICT(key) DO UPDATE SET hits=rate_limit.hits+1 RETURNING hits",
            [key],
          )
        ).rows[0];
        if (limited.hits > (options.rateLimit ?? 60)) {
          headers.set("Retry-After", "60");
          throw new ApiError(429, "rate_limited");
        }
      }
      const guest = guestVisitor(req, headers, Boolean(telegram || options.secureCookies));
      if (method === "GET" && path === "/api/movies/search") {
        const q = z
          .string()
          .max(160)
          .parse(url.searchParams.get("q") ?? "");
        return send(200, { movies: catalog.search(q) });
      }
      if (method === "GET" && path === "/api/packs") {
        return send(200, {
          packs: catalog.packs.map((p) => ({
            ...p,
            count: catalog.candidates("hard", p.id).length,
            counts: Object.fromEntries(
              (["easy", "normal", "hard"] as const).map((difficulty) => [
                difficulty,
                catalog.candidates(difficulty, p.id).length,
              ]),
            ),
            category:
              p.id === "popular"
                ? "all"
                : p.rules.countryIds
                  ? "country"
                  : p.rules.directorIds
                    ? "director"
                    : p.rules.yearMin || p.rules.yearMax
                      ? "era"
                      : "genre",
          })),
          catalogSize: catalog.movies.length,
          dataSources: catalog.sources,
        });
      }
      if (telegram && method === "GET" && path === "/api/auth/telegram/callback") {
        return await telegram.callback(req, headers, guest, url);
      }
      const session = (await telegram?.read(req, guest)) ?? { player: null };
      const { player } = session;
      const expectedPlayer = req.headers.get("x-cineclue-player");
      if (expectedPlayer !== null && expectedPlayer !== (player?.key ?? "guest")) {
        throw new ApiError(409, "session_changed");
      }
      if (method === "GET" && path === "/api/session") {
        return send(
          200,
          telegram ? { ...(await telegram.describe(player, guest)), ...session } : guestSession,
        );
      }
      if (telegram && method === "POST") {
        if (path === "/api/auth/telegram/start") {
          const { returnTo } = oidcStartBody.parse(await body(req));
          return send(200, await telegram.start(headers, guest, returnTo));
        }
        if (path === "/api/auth/telegram/mini-app") {
          const { initData } = miniAppBody.parse(await body(req, 8192));
          return send(200, await telegram.miniApp(headers, guest, initData));
        }
        if (path === "/api/auth/telegram/mini-app/resume") {
          const { initData } = miniAppBody.parse(await body(req, 8192));
          return send(200, await telegram.resumeMiniApp(req, guest, initData));
        }
        if (path === "/api/auth/logout") {
          archiveOpenBody.parse(await body(req));
          return send(
            200,
            player
              ? await telegram.logout(req, headers, guest)
              : await telegram.describe(null, guest),
          );
        }
      }
      const visitor = localGameOwner(guest, player?.key);
      const dailyVisitor = player?.key ?? guest;
      if (method === "GET" && path === "/api/daily") {
        return send(200, await games.daily(dailyVisitor));
      }
      if (method === "POST" && path === "/api/daily/guess") {
        const b = dailyGuessBody.parse(await body(req));
        const game = await games.daily(dailyVisitor);
        // Prefer JSON identity: conditional headers may be consumed by hosting proxies.
        // Retain If-Match for clients loaded before this deployment.
        const matches =
          b.gameId !== undefined
            ? b.gameId === game.id
            : req.headers.get("if-match") === `"${game.id}"`;
        if (!matches) throw new ApiError(409, "daily_expired");
        return send(200, await games.guess(game.id, dailyVisitor, b.movieId));
      }
      if (method === "GET" && path === "/api/archive") {
        const before = archiveDate.optional().parse(url.searchParams.get("before") ?? undefined);
        return send(200, await games.archiveDates(before));
      }
      const archiveRoute = path.match(/^\/api\/archive\/([^/]+)(?:\/(guess|hints))?$/);
      if (method === "POST" && archiveRoute) {
        const date = archiveDate.parse(archiveRoute[1]);
        const input = await body(req);
        if (archiveRoute[2] === "guess") {
          const b = archiveGuessBody.parse(input);
          return send(200, await games.guess(b.gameId, visitor, b.movieId, date));
        }
        if (archiveRoute[2] === "hints") {
          const b = archiveHintBody.parse(input);
          return send(200, await games.hint(b.gameId, visitor, b.kind, date));
        }
        archiveOpenBody.parse(input);
        return send(200, await games.archive(date, visitor));
      }
      const hintRoute = path.match(/^\/api\/games\/([^/]+)\/hints$/);
      if (method === "POST" && hintRoute) {
        const id = uuid.parse(hintRoute[1]);
        const b = hintBody.parse(await body(req));
        return send(200, await games.hint(id, visitor, b.kind, undefined, player?.key));
      }
      if (method === "POST" && path === "/api/challenges") {
        const b = guessBody.parse(await body(req));
        if (!catalog.byId.has(b.movieId)) throw new ApiError(422, "unknown_movie");
        const { rows } = await pool.query(
          "INSERT INTO challenge(target_id) VALUES($1) RETURNING id",
          [b.movieId],
        );
        return send(201, { id: rows[0].id, path: `/challenge/${rows[0].id}` });
      }
      if (method === "POST" && path === "/api/unlimited") {
        const b = unlimitedBody.parse(await body(req));
        return send(201, await games.unlimited(visitor, b.difficulty, b.pack));
      }
      const challenge = path.match(/^\/api\/challenges\/([^/]+)(\/guess)?$/);
      if (challenge) {
        const id = uuid.parse(challenge[1]);
        if (method === "GET" && !challenge[2]) {
          return send(200, await games.challenge(id, visitor));
        }
        if (method === "POST" && challenge[2]) {
          const b = guessBody.parse(await body(req));
          const game = await games.challenge(id, visitor);
          return send(200, await games.guess(game.id, visitor, b.movieId));
        }
      }
      const unlimited = path.match(/^\/api\/unlimited\/([^/]+)(\/guess)?$/);
      if (unlimited) {
        const id = uuid.parse(unlimited[1]);
        const game = await games.view(id, visitor);
        if (game.mode !== "unlimited") throw new ApiError(404, "not_found");
        if (method === "GET" && !unlimited[2]) {
          return send(200, game);
        }
        if (method === "POST" && unlimited[2]) {
          const b = guessBody.parse(await body(req));
          return send(200, await games.guess(id, visitor, b.movieId));
        }
      }
      throw new ApiError(404, "not_found");
    } catch (error) {
      if (error instanceof z.ZodError) {
        return send(400, { error: "invalid_input" });
      } else if (error instanceof ApiError) {
        return send(error.status, { error: error.code });
      } else {
        console.error(error);
        return send(500, { error: "internal_error" });
      }
    }
  };
}

// The Node transport keeps proxy trust at the socket boundary. Functions pass
// platform context.ip directly to the same handler instead of trusting headers.
export function app(
  catalog: Catalog,
  secret: string,
  options: NonNullable<Parameters<typeof createHandler>[2]> & { trustedProxyIp?: string } = {},
) {
  const handle = createHandler(catalog, secret, options);
  return createServer(async (req, res) => {
    const remote = req.socket.remoteAddress ?? "";
    const forwarded = req.headers["x-real-ip"];
    const ip =
      options.trustedProxyIp === remote && typeof forwarded === "string" && isIP(forwarded)
        ? forwarded
        : remote;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    try {
      const init: RequestInit & { duplex: "half" } = {
        method: req.method,
        headers,
        duplex: "half",
      };
      if (req.method !== "GET" && req.method !== "HEAD")
        init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
      const response = await handle(new Request(new URL(req.url ?? "/", "http://local"), init), ip);
      const outgoing: Record<string, string | string[]> = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing["set-cookie"] = cookies;
      res.writeHead(response.status, outgoing);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error);
      res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "internal_error" }));
    }
  });
}
