export class HttpError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  options: {
    signal?: AbortSignal;
    credentials?: RequestCredentials;
    player?: string;
    miniApp?: string;
  } = {},
): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: options.credentials ?? "same-origin",
    signal: options.signal,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.player === undefined ? {} : { "X-CineClue-Player": options.player }),
      ...(options.miniApp === undefined ? {} : { "X-CineClue-Mini-App": options.miniApp }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) {
    const b = await r.json().catch(() => ({ error: "error" }));
    throw new HttpError(b.error ?? "error");
  }
  return r.json() as Promise<T>;
}
export function publicRead<T>(path: string, signal?: AbortSignal) {
  return api<T>(path, undefined, { signal, credentials: "omit" });
}
export async function withBrowserLock<T>(key: string, run: () => T | Promise<T>): Promise<T> {
  let started = false;
  try {
    const locks = navigator.locks;
    if (locks) {
      return await locks.request(key, () => {
        started = true;
        return run();
      });
    }
  } catch (error) {
    if (started) throw error;
  }
  return run();
}
export type PlayerSession = {
  telegramBot: string | null;
  player: { key: string; expiresInMs: number } | null;
  guestDaily: boolean;
  miniAppProof?: string;
  resumeMiniApp?: boolean;
};

export function establishVisitor(miniApp?: { initData: string; proof?: string }) {
  return withBrowserLock("cineclue:visitor", async () => {
    const options = { miniApp: miniApp ? (miniApp.proof ?? "guest") : undefined };
    const session = await api<PlayerSession>("/session", undefined, options);
    if (session.resumeMiniApp && miniApp?.initData) {
      // Refused or unavailable resume still leaves guest play available.
      return api<PlayerSession>(
        "/auth/telegram/mini-app/resume",
        { initData: miniApp.initData },
        options,
      ).catch(() => session);
    }
    return session;
  });
}
export function readStorage<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}
export function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
