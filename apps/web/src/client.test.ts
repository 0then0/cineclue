import { afterEach, expect, it, vi } from "vitest";
import { establishVisitor, publicRead } from "./client.ts";

afterEach(() => vi.unstubAllGlobals());

it("coordinates first visitor requests and lets public reads run without updating the cookie", async () => {
  const cookieResponse = Promise.withResolvers<Response>();
  const firstRequest = Promise.withResolvers<void>();
  const fetch = vi.fn((url: string) => {
    if (url === "/api/movies/search?q=") {
      firstRequest.resolve();
      return cookieResponse.promise;
    }
    return Promise.resolve(Response.json({ packs: [] }));
  });
  vi.stubGlobal("fetch", fetch);
  const queues = new Map<string, Promise<unknown>>();
  const request = (key: string, run: () => Promise<unknown>) => {
    const result = (queues.get(key) ?? Promise.resolve()).then(run);
    queues.set(key, result);
    return result;
  };
  vi.stubGlobal("navigator", { locks: { request } });

  const first = establishVisitor();
  const second = establishVisitor();
  await firstRequest.promise;
  await publicRead("/packs");
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/movies/search?q=", "/api/packs"]);
  expect(fetch).toHaveBeenCalledWith(
    "/api/packs",
    expect.objectContaining({ credentials: "omit" }),
  );
  expect(fetch).toHaveBeenCalledWith(
    "/api/movies/search?q=",
    expect.objectContaining({ credentials: "same-origin" }),
  );
  // Each tab receives its own response after the browser cookie jar has been updated.
  fetch.mockImplementation(() => Promise.resolve(Response.json({ movies: [] })));
  cookieResponse.resolve(Response.json({ movies: [] }));
  await Promise.all([first, second]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/movies/search?q=",
    "/api/packs",
    "/api/movies/search?q=",
  ]);
});
