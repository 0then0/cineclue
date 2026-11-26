import { randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { normalizeCountry } from "../../../packages/game-engine/src/countries.ts";
import { createHint, hintAllowance } from "../../../packages/game-engine/src/hints.ts";
import {
  type ArchivePage,
  compareMovies,
  type Difficulty,
  type GameHint,
  type GameView,
  type GuessView,
  type HintKind,
  hintKinds,
  movieSchema,
  publicMovie,
} from "../../../packages/game-engine/src/index.ts";
import type { Catalog } from "./catalog.ts";
import { selectDaily } from "./daily.ts";

export { dailyIndex } from "./daily.ts";

import { pool, transaction } from "./db.ts";
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export const utcDate = (date = new Date()) => date.toISOString().slice(0, 10);
export const nextMidnight = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString();
const archivePageSize = 30;
const sessionById =
  "SELECT s.*,to_char(p.puzzle_date,'YYYY-MM-DD') date FROM game_session s LEFT JOIN daily_puzzle p ON p.id=COALESCE(s.puzzle_id,s.archive_puzzle_id) WHERE s.id=$1";
const sessionByVisitor = `${sessionById} AND s.visitor_id=$2`;

function requirePastDate(date: string) {
  if (date >= utcDate()) throw new ApiError(404, "archive_unavailable");
}

async function lockPlayableSession(
  client: PoolClient,
  id: string,
  visitor: string,
  archiveDate?: string,
  dailyVisitor?: string,
) {
  if (archiveDate !== undefined) requirePastDate(archiveDate);
  const { rows } = dailyVisitor
    ? await client.query(
        `${sessionById} AND s.visitor_id=CASE WHEN s.mode='daily' THEN $3::uuid ELSE $2::uuid END FOR UPDATE OF s`,
        [id, visitor, dailyVisitor],
      )
    : await client.query(`${sessionByVisitor} FOR UPDATE OF s`, [id, visitor]);
  const session = rows[0];
  if (
    !session ||
    (archiveDate === undefined
      ? session.mode === "archive"
      : session.mode !== "archive" || session.date !== archiveDate)
  ) {
    throw new ApiError(404, "not_found");
  }
  if (session.status !== "playing") throw new ApiError(409, "game_finished");
  if (session.mode === "daily" && session.date !== utcDate()) {
    throw new ApiError(409, "daily_expired");
  }
  return session;
}

export class Games {
  readonly catalog: Catalog;
  readonly secret: string;
  constructor(catalog: Catalog, secret: string) {
    this.catalog = catalog;
    this.secret = secret;
  }
  async daily(visitor: string): Promise<GameView> {
    const date = utcDate();
    let puzzle = (
      await pool.query(
        "SELECT id,target_id,target_snapshot FROM daily_puzzle WHERE puzzle_date=$1",
        [date],
      )
    ).rows[0];
    if (!puzzle) {
      const history = (
        await pool.query(
          "SELECT to_char(puzzle_date,'YYYY-MM-DD') date,target_id,target_snapshot FROM daily_puzzle WHERE puzzle_date < $1::date AND puzzle_date >= $1::date - 180 ORDER BY puzzle_date DESC",
          [date],
        )
      ).rows.map((r) => ({
        date: r.date as string,
        movieId: r.target_id as string,
        directorIds:
          (r.target_snapshot
            ? movieSchema.parse(r.target_snapshot)
            : this.catalog.byId.get(r.target_id)
          )?.directors.map((d) => d.id) ?? [],
      }));
      const target = selectDaily(this.catalog.dailyCandidates(), history, date, this.secret);
      if (!target) throw new ApiError(503, "no_candidates");
      await pool.query(
        "INSERT INTO daily_puzzle(puzzle_date,target_id,target_snapshot) VALUES($1,$2,$3) ON CONFLICT(puzzle_date) DO NOTHING",
        [date, target.id, JSON.stringify(target)],
      );
      puzzle = (
        await pool.query(
          "SELECT id,target_id,target_snapshot FROM daily_puzzle WHERE puzzle_date=$1",
          [date],
        )
      ).rows[0];
    }
    return transaction(async (client) => {
      await client.query(
        "INSERT INTO game_session(visitor_id,mode,puzzle_id,target_id,target_snapshot) VALUES($1,'daily',$2,$3,$4) ON CONFLICT(visitor_id,puzzle_id) DO NOTHING",
        [
          visitor,
          puzzle.id,
          puzzle.target_id,
          JSON.stringify(puzzle.target_snapshot ?? this.catalog.byId.get(puzzle.target_id)),
        ],
      );
      const { rows } = await client.query(
        "SELECT id FROM game_session WHERE visitor_id=$1 AND puzzle_id=$2 FOR SHARE",
        [visitor, puzzle.id],
      );
      return this.view(rows[0].id, visitor, client);
    });
  }
  async archiveDates(before?: string): Promise<ArchivePage> {
    const today = utcDate();
    const { rows } = await pool.query<{ date: string }>(
      "SELECT to_char(puzzle_date,'YYYY-MM-DD') date FROM daily_puzzle WHERE puzzle_date < $1::date ORDER BY puzzle_date DESC LIMIT $2",
      [before && before < today ? before : today, archivePageSize + 1],
    );
    const dates = rows.slice(0, archivePageSize).map((r) => r.date);
    return { dates, nextBefore: rows.length > archivePageSize ? dates[archivePageSize - 1] : null };
  }
  async archive(date: string, visitor: string): Promise<GameView> {
    requirePastDate(date);
    return transaction(async (client) => {
      const puzzle = (
        await client.query(
          "SELECT id,target_id,target_snapshot FROM daily_puzzle WHERE puzzle_date=$1",
          [date],
        )
      ).rows[0];
      if (!puzzle) throw new ApiError(404, "archive_unavailable");
      await client.query(
        "INSERT INTO game_session(visitor_id,mode,archive_puzzle_id,target_id,target_snapshot) VALUES($1,'archive',$2,$3,$4) ON CONFLICT(visitor_id,archive_puzzle_id) DO NOTHING",
        [
          visitor,
          puzzle.id,
          puzzle.target_id,
          JSON.stringify(puzzle.target_snapshot ?? this.catalog.byId.get(puzzle.target_id)),
        ],
      );
      // Keep the restored view consistent if a guess or hint is being saved in another tab.
      const { rows } = await client.query(
        "SELECT id FROM game_session WHERE visitor_id=$1 AND archive_puzzle_id=$2 FOR SHARE",
        [visitor, puzzle.id],
      );
      return this.view(rows[0].id, visitor, client);
    });
  }
  async unlimited(visitor: string, difficulty: Difficulty, pack: string) {
    const recent = (
      await pool.query(
        "SELECT target_id FROM game_session WHERE visitor_id=$1 AND mode='unlimited' ORDER BY created_at DESC LIMIT 20",
        [visitor],
      )
    ).rows.map((r) => r.target_id as string);
    const all = this.catalog.candidates(difficulty, pack);
    if (!all.length) throw new ApiError(422, "no_candidates");
    let available = all.filter((m) => !recent.includes(m.id));
    if (!available.length) {
      const last = recent[0];
      available = all.filter((m) => m.id !== last);
      if (!available.length) available = all;
    }
    const target = available[randomInt(available.length)];
    const { rows } = await pool.query(
      "INSERT INTO game_session(visitor_id,mode,target_id,difficulty,target_snapshot) VALUES($1,'unlimited',$2,$3,$4) RETURNING id",
      [visitor, target.id, difficulty, JSON.stringify(target)],
    );
    return this.view(rows[0].id, visitor);
  }
  async challenge(id: string, visitor: string) {
    const ch = (await pool.query("SELECT target_id FROM challenge WHERE id=$1", [id])).rows[0];
    if (!ch) throw new ApiError(404, "not_found");
    await pool.query(
      "INSERT INTO game_session(visitor_id,mode,challenge_id,target_id,target_snapshot) VALUES($1,'challenge',$2,$3,$4) ON CONFLICT(visitor_id,challenge_id) DO NOTHING",
      [visitor, id, ch.target_id, JSON.stringify(this.catalog.byId.get(ch.target_id))],
    );
    const { rows } = await pool.query(
      "SELECT id FROM game_session WHERE visitor_id=$1 AND challenge_id=$2",
      [visitor, id],
    );
    return this.view(rows[0].id, visitor);
  }
  async view(
    id: string,
    visitor: string,
    client: PoolClient | typeof pool = pool,
  ): Promise<GameView> {
    const { rows } = await client.query(sessionByVisitor, [id, visitor]);
    const s = rows[0];
    if (!s) throw new ApiError(404, "not_found");
    const guesses: GuessView[] = (
      await client.query(
        "SELECT movie_id,comparison FROM guess WHERE game_id=$1 ORDER BY ordinal",
        [id],
      )
    ).rows.map((g) => {
      const m = this.catalog.byId.get(g.movie_id);
      if (!m) throw new Error("Catalog missing guess");
      return {
        movie: publicMovie(m),
        comparison: {
          ...g.comparison,
          countries: {
            ...g.comparison.countries,
            values: g.comparison.countries.values.map(normalizeCountry),
            matches: g.comparison.countries.matches.map(normalizeCountry),
          },
        },
      };
    });
    const savedTarget = s.target_snapshot
      ? movieSchema.parse(s.target_snapshot)
      : this.catalog.byId.get(s.target_id);
    if (!savedTarget) throw new ApiError(503, "catalog_unavailable");
    const target = { ...savedTarget, countries: savedTarget.countries.map(normalizeCountry) };
    const used: GameHint[] = (
      await client.query("SELECT content FROM game_hint WHERE game_id=$1 ORDER BY ordinal", [id])
    ).rows.map((r) => r.content);
    const misses = guesses.length - (s.status === "won" ? 1 : 0);
    const unlocked = hintAllowance(misses);
    const options = hintKinds.filter(
      (kind) =>
        !used.some((h) => h.kind === kind) &&
        createHint(kind, target, this.catalog.movies, guesses) !== null,
    );
    return {
      hints: {
        unlocked,
        remaining: s.status === "playing" ? Math.max(0, unlocked - used.length) : 0,
        nextUnlock: misses < 3 ? 3 : misses < 7 ? 7 : null,
        options,
        used,
      },
      id: s.id,
      mode: s.mode,
      date: s.date,
      maxAttempts: 8,
      status: s.status,
      guesses,
      difficulty: s.difficulty,
      ...(s.mode === "daily" && s.date ? { nextPuzzleAt: nextMidnight(s.date) } : {}),
      ...(s.status !== "playing" ? { answer: target } : {}),
    };
  }
  async hint(
    id: string,
    visitor: string,
    kind: HintKind,
    archiveDate?: string,
    dailyVisitor?: string,
  ): Promise<GameView> {
    return transaction(async (client) => {
      const s = await lockPlayableSession(client, id, visitor, archiveDate, dailyVisitor);
      const view = await this.view(id, s.visitor_id, client);
      if (view.hints.used.some((h) => h.kind === kind)) throw new ApiError(409, "hint_used");
      if (view.hints.remaining === 0) throw new ApiError(409, "hints_locked");
      const target = s.target_snapshot
        ? movieSchema.parse(s.target_snapshot)
        : this.catalog.byId.get(s.target_id);
      if (!target) throw new ApiError(503, "catalog_unavailable");
      const content = createHint(kind, target, this.catalog.movies, view.guesses);
      if (!content) throw new ApiError(422, "hint_unavailable");
      await client.query(
        "INSERT INTO game_hint(game_id,ordinal,kind,content) VALUES($1,$2,$3,$4)",
        [id, view.hints.used.length + 1, kind, content],
      );
      return this.view(id, s.visitor_id, client);
    });
  }
  async guess(id: string, visitor: string, movieId: string, archiveDate?: string) {
    const movie = this.catalog.byId.get(movieId);
    if (!movie) throw new ApiError(422, "unknown_movie");
    return transaction(async (client) => {
      const s = await lockPlayableSession(client, id, visitor, archiveDate);
      const previous = (await client.query("SELECT movie_id FROM guess WHERE game_id=$1", [id]))
        .rows;
      if (previous.some((g) => g.movie_id === movieId)) throw new ApiError(409, "already_guessed");
      const target = s.target_snapshot
        ? movieSchema.parse(s.target_snapshot)
        : this.catalog.byId.get(s.target_id);
      if (!target) throw new ApiError(503, "catalog_unavailable");
      const ordinal = previous.length + 1;
      if (ordinal > 8) throw new ApiError(409, "game_finished");
      await client.query(
        "INSERT INTO guess(game_id,ordinal,movie_id,comparison) VALUES($1,$2,$3,$4)",
        [id, ordinal, movieId, compareMovies(movie.id === target.id ? target : movie, target)],
      );
      const status = movieId === s.target_id ? "won" : ordinal === 8 ? "lost" : "playing";
      await client.query("UPDATE game_session SET status=$1 WHERE id=$2", [status, id]);
      return this.view(id, visitor, client);
    });
  }
}
