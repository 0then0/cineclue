import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  compareMovies,
  type GameView,
  type Movie,
  publicMovie,
} from "../../../packages/game-engine/src/index.ts";
import App from "./App.tsx";
import { dictionaries } from "./i18n.ts";
import { recordsKey } from "./records.ts";
import {
  initializeMiniApp,
  invalidMiniAppChallenge,
  isMiniApp,
  miniAppPath,
  telegramGameLink,
} from "./telegram.ts";

const t = dictionaries.en;
const challengeId = "d50c8495-8649-43f1-abaa-08dcfc7de0a3";
const movie: Movie = {
  id: "movie-1",
  title: "Account Film",
  originalTitle: "Account Film",
  titles: {},
  releaseYear: 2020,
  runtime: 90,
  directors: [],
  actors: [],
  genres: [],
  countries: [],
  studios: [],
  aliases: [],
  externalIds: {},
  provenance: [],
  popularityScore: 50,
};
const guestGame: GameView = {
  id: "guest-daily",
  mode: "daily",
  status: "playing",
  date: "2026-10-21",
  guesses: [],
  maxAttempts: 8,
  difficulty: "normal",
  hints: { unlocked: 0, remaining: 0, nextUnlock: 3, options: [], used: [] },
};
const guest = { player: null, telegramBot: "CineClueFixtureBot", guestDaily: false };
const finishedDaily = {
  ...guestGame,
  id: "account-daily",
  status: "won",
  answer: movie,
  guesses: [{ movie: publicMovie(movie), comparison: compareMovies(movie, movie) }],
} satisfies GameView;
const account = {
  ...guest,
  player: { key: "account-key", expiresInMs: 600_000 },
  guestDaily: true,
  miniAppProof: "test-proof",
};

function mockBridge(data: string) {
  vi.stubGlobal("Telegram", {
    WebApp: { platform: "ios", initData: data, ready: vi.fn(), expand: vi.fn() },
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("cineclue:locale", '"en"');
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("accepts only a bounded Challenge payload and builds an opaque Main Mini App link", () => {
  expect(miniAppPath(undefined)).toBe("/");
  expect(miniAppPath("")).toBe("/");
  expect(miniAppPath(`challenge_${challengeId.toUpperCase()}`)).toBe(`/challenge/${challengeId}`);
  expect(telegramGameLink(guest.telegramBot, `/challenge/${challengeId}`)).toBe(
    `https://t.me/${guest.telegramBot}?startapp=challenge_${challengeId}`,
  );
  for (const input of [
    `challenge_${challengeId}/guess`,
    `challenge_${challengeId}\n`,
    "a".repeat(513),
    "https://example.com",
    { id: challengeId },
  ]) {
    expect(miniAppPath(input)).toBe(invalidMiniAppChallenge);
  }
});

it("preserves Mini App context after removing the launch fragment on a playable route", async () => {
  mockBridge("fixture-init-data");
  window.history.replaceState({}, "", `/challenge/${challengeId}#tgWebAppData=fixture`);
  await initializeMiniApp();
  vi.unstubAllGlobals();
  expect(window.location.hash).toBe("");
  expect(window.location.pathname).toBe(`/challenge/${challengeId}`);
  expect(isMiniApp()).toBe(true);
});

it.each(["invalid", `challenge_${challengeId}`])(
  "shows an unavailable Challenge with a route back to Daily for %s",
  async (payload) => {
    mockBridge("");
    window.history.replaceState({}, "", `/telegram?tgWebAppStartParam=${payload}`);
    await initializeMiniApp();
    const fetch = vi.fn(async (path: string) => {
      if (path === "/api/session") return Response.json(guest);
      if (path === "/api/daily") return Response.json(guestGame);
      if (path === "/api/packs") return Response.json({ packs: [], catalogSize: 1 });
      return Response.json({ error: "not_found" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    expect(await screen.findByText(t.challenge_unavailable)).toBeTruthy();
    const requests = fetch.mock.calls
      .map(([path]) => path)
      .filter((path) => path.startsWith("/api/challenges/"));
    expect(requests).toEqual(payload === "invalid" ? [] : [`/api/challenges/${challengeId}`]);
    fireEvent.click(screen.getByRole("link", { name: t.backToDaily }));
    expect(await screen.findByRole("combobox", { name: t.search })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  },
);

it("requires an explicit Mini App sign-in, swaps the visible player, and keeps Daily history local", async () => {
  mockBridge("fixture-init-data");
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    if (path === "/api/session") return Response.json(guest);
    if (path === "/api/packs") return Response.json({ packs: [], catalogSize: 1 });
    if (path === "/api/auth/telegram/mini-app") {
      expect(JSON.parse(String(options?.body))).toEqual({ initData: "fixture-init-data" });
      expect(headers.get("x-cineclue-mini-app")).toBe("guest");
      return Response.json(account);
    }
    if (path === "/api/auth/logout") return Response.json(guest);
    if (path === "/api/daily" && headers.get("x-cineclue-player") === "account-key") {
      expect(headers.get("x-cineclue-mini-app")).toBe("test-proof");
      return Response.json(finishedDaily);
    }
    return Response.json(guestGame);
  });
  vi.stubGlobal("fetch", fetch);
  localStorage.setItem(
    recordsKey,
    JSON.stringify([{ date: "2026-10-20", won: true, attempts: 2 }]),
  );
  render(<App />);
  await screen.findByRole("combobox", { name: t.search });
  expect(fetch.mock.calls.some(([path]) => path.includes("/auth/"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: t.telegram_continue }));
  expect(await screen.findByText(t.telegram_guest_daily)).toBeTruthy();
  expect(await screen.findByRole("heading", { name: t.won })).toBeTruthy();
  expect(localStorage.getItem(`${recordsKey}:account-key`)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: t.telegram_sign_out }));
  await screen.findByRole("combobox", { name: t.search });
  expect(screen.queryByText(movie.title)).toBeNull();
  expect(JSON.parse(localStorage.getItem(recordsKey) ?? "[]")).toHaveLength(1);
});

it("hides the previous player's board while a browser-cached page revalidates its session", async () => {
  const session = Promise.withResolvers<Response>();
  let returning = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options?: RequestInit) => {
      if (path === "/api/session") return returning ? session.promise : Response.json(account);
      if (path === "/api/daily") {
        const key = new Headers(options?.headers).get("x-cineclue-player");
        return Response.json(key === account.player.key ? finishedDaily : guestGame);
      }
      return Response.json({ packs: [], catalogSize: 1 });
    }),
  );
  render(<App />);
  await screen.findByRole("heading", { name: t.won });
  returning = true;
  fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true }));
  fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
  expect(screen.queryByText(movie.title)).toBeNull();
  expect(screen.queryByRole("button", { name: t.telegram_sign_out })).toBeNull();
  session.resolve(Response.json(guest));
  await screen.findByRole("combobox", { name: t.search });
  expect(screen.queryByText(movie.title)).toBeNull();
});

it("reuses the current Mini App proof after a transient session fetch fails", async () => {
  mockBridge("expired-init-data");
  let fail = false;
  let established = false;
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/api/session") {
      if (fail) {
        fail = false;
        throw new TypeError("Connection lost");
      }
      const proof = new Headers(options?.headers).get("x-cineclue-mini-app");
      const valid = !established || proof === account.miniAppProof;
      established = true;
      return Response.json(valid ? account : { ...guest, resumeMiniApp: true });
    }
    if (path === "/api/auth/telegram/mini-app/resume") return Response.json(guest);
    if (path === "/api/daily") return Response.json(guestGame);
    return Response.json({ packs: [], catalogSize: 1 });
  });
  vi.stubGlobal("fetch", fetch);
  render(<App />);
  await screen.findByRole("combobox", { name: t.search });
  fail = true;
  fireEvent(window, new PageTransitionEvent("pageshow"));
  fireEvent.click(await screen.findByRole("button", { name: t.retry }));
  await screen.findByRole("combobox", { name: t.search });
  expect(screen.getByRole("button", { name: t.telegram_sign_out })).toBeTruthy();
  const sessionRequests = fetch.mock.calls.filter(([path]) => path === "/api/session");
  expect(new Headers(sessionRequests.at(-1)?.[1]?.headers).get("x-cineclue-mini-app")).toBe(
    account.miniAppProof,
  );
});
