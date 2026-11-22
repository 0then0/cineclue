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
  signal?: AbortSignal,
  credentials: RequestCredentials = "same-origin",
): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials,
    signal,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
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
  return api<T>(path, undefined, signal, "omit");
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
export function establishVisitor() {
  return withBrowserLock("cineclue:visitor", async () => {
    // An empty search issues the visitor cookie without creating a game.
    await api("/movies/search?q=");
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
