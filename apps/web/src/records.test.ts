import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyHistoryImport,
  historyFileLimit,
  planHistoryImport,
  readHistoryFile,
  readRecords,
  recordsKey,
  saveRecord,
  serializeHistory,
} from "./records.ts";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());
it("merges concurrent saves under a shared Web Lock and deduplicates dates", async () => {
  let tail = Promise.resolve();
  const request = vi.fn((_name: string, work: () => unknown) => {
    const next = tail.then(work);
    tail = next.then(() => {});
    return next;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  await Promise.all([
    saveRecord({ date: "2026-10-20", won: true, attempts: 2 }),
    saveRecord({ date: "2026-10-21", won: true, attempts: 3 }),
  ]);
  await saveRecord({ date: "2026-10-20", won: true, attempts: 2 });
  expect(readRecords()).toHaveLength(2);
  expect(request).toHaveBeenCalledTimes(3);
});
it("reports unavailable storage without throwing", async () => {
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  try {
    expect((await saveRecord({ date: "2026-10-20", won: false, attempts: 8 })).saved).toBe(false);
  } finally {
    fail.mockRestore();
  }
});

it("falls back to a fresh merge when Web Locks is denied", async () => {
  localStorage.setItem(
    "cineclue:records",
    JSON.stringify([{ date: "2026-10-19", won: true, attempts: 1 }]),
  );
  vi.stubGlobal("navigator", {
    locks: { request: vi.fn().mockRejectedValue(new Error("SecurityError")) },
  });
  const result = await saveRecord({ date: "2026-10-20", won: true, attempts: 2 });
  expect(result.saved).toBe(true);
  expect(result.records).toHaveLength(2);
});

const leapDay = { date: "2024-02-29", won: true, attempts: 8 };
const loss = { date: "2026-10-20", won: false, attempts: 8 };
const historyFile = (records: unknown[]) =>
  new File(
    [JSON.stringify({ format: "cineclue:daily-history", version: 1, records })],
    "history.json",
  );

it("accepts leap days and final-attempt wins, sorting and collapsing identical duplicates", async () => {
  expect(await readHistoryFile(historyFile([loss, leapDay, loss]))).toEqual({
    records: [leapDay, loss],
  });
});

it.each([
  { ...loss, date: "2026-02-29" },
  { ...loss, date: "2026-04-31" },
  { ...loss, date: "0000-01-01" },
  { ...loss, date: "2026-10-20T00:00:00Z" },
  { ...loss, won: "false" },
  { ...loss, attempts: 7 },
  { ...leapDay, attempts: 0 },
  { ...leapDay, attempts: 9 },
  { ...leapDay, attempts: 2.5 },
  { ...leapDay, guesses: [] },
])("rejects an invalid completed result %j", async (record) => {
  expect(await readHistoryFile(historyFile([leapDay, record]))).toEqual({
    error: "historyInvalidRecord",
  });
});

it("rejects an oversized file before reading it", async () => {
  const file = new File([new Uint8Array(historyFileLimit + 1)], "oversized.json");
  const read = vi.spyOn(file, "text");
  expect(await readHistoryFile(file)).toEqual({ error: "historyFileTooLarge" });
  expect(read).not.toHaveBeenCalled();
});

it("accepts today's UTC puzzle but rejects a result dated tomorrow", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T23:59:59Z"));
  try {
    const tomorrow = { date: "2026-10-21", won: true, attempts: 1 };
    expect(await readHistoryFile(historyFile([loss]))).toEqual({ records: [loss] });
    expect(await readHistoryFile(historyFile([loss, tomorrow]))).toEqual({
      error: "historyInvalidRecord",
    });
    const exported = new File([serializeHistory([loss, tomorrow])], "history.json");
    expect(await readHistoryFile(exported)).toEqual({ records: [loss] });
  } finally {
    vi.useRealTimers();
  }
});

it("can restore a merged export larger than either imported backup", async () => {
  const records = Array.from({ length: 24_000 }, (_, day) => ({
    date: new Date(Date.UTC(1960, 0, day + 1)).toISOString().slice(0, 10),
    won: true,
    attempts: 1,
  }));
  for (const part of [records.slice(0, 12_000), records.slice(12_000)]) {
    const parsed = await readHistoryFile(historyFile(part));
    if ("error" in parsed) throw new Error(parsed.error);
    const merged = await applyHistoryImport(
      parsed.records,
      planHistoryImport(parsed.records, readRecords()),
    );
    expect(merged.status).toBe("saved");
  }
  const exported = new File([serializeHistory(readRecords())], "history.json");
  expect(exported.size).toBeGreaterThan(1024 * 1024);
  const restored = await readHistoryFile(exported);
  if ("error" in restored) throw new Error(restored.error);
  expect(restored.records).toEqual(records);
});

it("uses the Daily save lock and accounts for writes queued ahead of confirmation", async () => {
  let tail = Promise.resolve();
  const request = vi.fn((_name: string, work: () => unknown) => {
    const next = tail.then(work);
    tail = next.then(() => {});
    return next;
  });
  vi.stubGlobal("navigator", { locks: { request } });
  const incoming = [leapDay, loss];
  const preview = planHistoryImport(incoming, []);
  const localWin = { ...loss, won: true, attempts: 2 };
  const [saved, imported] = await Promise.all([
    saveRecord(localWin),
    applyHistoryImport(incoming, preview),
  ]);
  expect(saved.saved).toBe(true);
  expect(imported).toEqual({
    status: "changed",
    plan: { additions: [leapDay], matching: 0, conflicts: [{ local: localWin, incoming: loss }] },
  });
  expect(request.mock.calls.map(([name]) => name)).toEqual([recordsKey, recordsKey]);
  expect(readRecords()).toEqual([localWin]);
});

it("merges an intervening result outside the import without changing the preview", async () => {
  const plan = planHistoryImport([leapDay], []);
  await saveRecord(loss);
  expect(await applyHistoryImport([leapDay], plan)).toEqual({
    status: "saved",
    records: [leapDay, loss],
  });
  expect(readRecords()).toEqual([leapDay, loss]);
});
