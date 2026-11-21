import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GameView } from "../../../packages/game-engine/src/model.ts";
import App from "./App.tsx";
import { dictionaries } from "./i18n.ts";
import { historyFileLimit, recordsKey } from "./records.ts";
import type { DailyRecord } from "./results.ts";

const t = dictionaries.en;
const format = "cineclue:daily-history";
const history = [
  { date: "2026-10-18", won: true, attempts: 1 },
  { date: "2026-10-19", won: true, attempts: 2 },
  { date: "2026-10-20", won: true, attempts: 3 },
  { date: "2026-10-22", won: true, attempts: 4 },
  { date: "2026-10-23", won: false, attempts: 8 },
  { date: "2026-10-24", won: true, attempts: 8 },
] satisfies DailyRecord[];
const playing: GameView = {
  id: "current-daily",
  mode: "daily",
  date: "2026-10-24",
  status: "playing",
  guesses: [],
  maxAttempts: 8,
  difficulty: "normal",
  hints: { unlocked: 0, remaining: 0, nextUnlock: 3, options: [], used: [] },
  nextPuzzleAt: "2026-10-25T00:00:00Z",
};
const fetch = vi.fn((url: string) =>
  Promise.resolve(
    new Response(JSON.stringify(url.endsWith("/packs") ? { packs: [], catalogSize: 1 } : playing)),
  ),
);
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("cineclue:locale", '"en"');
  window.history.replaceState({}, "", "/");
  fetch.mockClear();
  vi.stubGlobal("fetch", fetch);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
});

afterEach(() => {
  cleanup();
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShow);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openStatistics() {
  await screen.findByRole("combobox", { name: t.search });
  fireEvent.click(screen.getByRole("button", { name: t.stats }));
  return screen.getByRole("dialog", { name: t.stats });
}

function historyFile(records: DailyRecord[], version = 1) {
  return new File([JSON.stringify({ format, version, records })], "cineclue-daily-history.json", {
    type: "application/json",
  });
}

async function chooseFile(dialog: HTMLElement, file: File) {
  const input = within(dialog).getByLabelText<HTMLInputElement>(t.importHistory);
  const chooser = vi.spyOn(input, "click");
  fireEvent.click(within(dialog).getByRole("button", { name: t.importHistory }));
  expect(chooser).toHaveBeenCalledOnce();
  chooser.mockRestore();
  await userEvent.setup().upload(input, file);
}

const button = (dialog: HTMLElement, name: string) => within(dialog).getByRole("button", { name });
const value = (dialog: HTMLElement, label: string) => within(dialog).getByText(label).parentElement;
const storedHistory = () => JSON.parse(localStorage.getItem(recordsKey) ?? "[]");

it("downloads only sorted Daily results and restores the same statistics through the statistics screen", async () => {
  localStorage.setItem(
    recordsKey,
    JSON.stringify([{ ...history[0], answer: "private" }, ...history.slice(1)].reverse()),
  );
  const createObjectURL = vi.fn((_blob: Blob) => "blob:http://localhost/history");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    },
  );
  const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.download).toBe("cineclue-daily-history.json");
  });

  const source = render(<App />);
  const sourceDialog = await openStatistics();
  fireEvent.click(button(sourceDialog, t.exportHistory));
  expect(download).toHaveBeenCalledOnce();
  const blob = createObjectURL.mock.calls[0][0];
  expect(JSON.parse(await blob.text())).toEqual({ format, version: 1, records: history });
  const sourceStats = sourceDialog.querySelector(".stats-grid")?.textContent;
  const distribution = (dialog: HTMLElement) =>
    Array.from(dialog.querySelectorAll(".distribution > div > div"), (bar) =>
      Number(bar.textContent),
    );
  const sourceDistribution = distribution(sourceDialog);
  expect(sourceDistribution).toEqual([1, 1, 1, 1, 0, 0, 0, 1]);
  source.unmount();

  localStorage.clear();
  localStorage.setItem("cineclue:locale", '"en"');
  render(<App />);
  const dialog = await openStatistics();
  const search = screen.getByRole("combobox", { name: t.search });
  const file = new File([blob], "cineclue-daily-history.json", { type: blob.type });
  fetch.mockClear();

  await chooseFile(dialog, file);
  await within(dialog).findByRole("heading", { name: t.historyPreview });
  expect(value(dialog, t.historyToAdd)?.textContent).toBe(`${t.historyToAdd}6`);
  expect(storedHistory()).toEqual([]);
  fireEvent.click(button(dialog, t.confirmImport));
  await within(dialog).findByText(t.historyImported);
  expect(storedHistory()).toEqual(history);
  expect(dialog.querySelector(".stats-grid")?.textContent).toBe(sourceStats);
  expect(value(dialog, t.streak)?.textContent).toBe(`1${t.streak}`);
  expect(value(dialog, t.best)?.textContent).toBe(`3${t.best}`);
  expect(distribution(dialog)).toEqual(sourceDistribution);

  await chooseFile(dialog, file);
  await within(dialog).findByRole("heading", { name: t.historyPreview });
  expect(value(dialog, t.historyToAdd)?.textContent).toBe(`${t.historyToAdd}0`);
  expect(value(dialog, t.historyMatching)?.textContent).toBe(`${t.historyMatching}6`);
  const writes = vi.spyOn(Storage.prototype, "setItem");
  fireEvent.click(button(dialog, t.confirmImport));
  await within(dialog).findByText(t.historyImported);
  expect(writes).not.toHaveBeenCalled();
  expect(storedHistory()).toEqual(history);
  expect(dialog.querySelector(".stats-grid")?.textContent).toBe(sourceStats);
  expect(screen.getByRole("combobox", { name: t.search })).toBe(search);
  expect(screen.getByText("0 / 8")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it("shows both results before confirming, supports cancel, and adds only the missing date", async () => {
  const [first, second, third] = history;
  const localLoss = { ...second, won: false, attempts: 8 };
  localStorage.setItem(recordsKey, JSON.stringify([first, localLoss]));
  render(<App />);
  const dialog = await openStatistics();
  const file = historyFile([third, second, first]);
  await chooseFile(dialog, file);
  await within(dialog).findByRole("heading", { name: t.historyPreview });
  expect(value(dialog, t.historyToAdd)?.textContent).toBe(`${t.historyToAdd}1`);
  expect(value(dialog, t.historyMatching)?.textContent).toBe(`${t.historyMatching}1`);
  expect(value(dialog, t.historyConflicting)?.textContent).toBe(`${t.historyConflicting}1`);
  const conflict = within(dialog).getByRole("listitem");
  expect(conflict.textContent).toContain(second.date);
  expect(conflict.textContent).toContain(`${t.historyLocalResult} ${t.historyLoss} (8/8)`);
  expect(conflict.textContent).toContain(`${t.historyFileResult} ${t.historyWin} (2/8)`);
  expect(storedHistory()).toEqual([first, localLoss]);
  fireEvent.click(button(dialog, t.cancelImport));
  expect(within(dialog).queryByRole("heading", { name: t.historyPreview })).toBeNull();
  expect(storedHistory()).toEqual([first, localLoss]);

  await chooseFile(dialog, file);
  fireEvent.click(await within(dialog).findByRole("button", { name: t.confirmImport }));
  await within(dialog).findByText(t.historyImported);
  expect(storedHistory()).toEqual([first, localLoss, third]);
});

it.each([
  ["unsupported version", () => historyFile(history, 2), t.historyUnsupportedVersion],
  [
    "invalid date",
    () => historyFile([{ ...history[0], date: "2026-02-30" }]),
    t.historyInvalidRecord,
  ],
  ["a malformed file", () => new File(["{"], "invalid.json"), t.historyInvalidFile],
  [
    "oversized file",
    () => new File([new Uint8Array(historyFileLimit + 1)], "big.json"),
    t.historyFileTooLarge,
  ],
  [
    "conflicting duplicates",
    () => historyFile([history[0], { ...history[0], attempts: 2 }]),
    t.historyDuplicateDate,
  ],
] as const)("reports %s before enabling confirmation", async (_name, makeFile, message) => {
  render(<App />);
  const dialog = await openStatistics();
  await chooseFile(dialog, makeFile());
  expect((await within(dialog).findByRole("alert")).textContent).toBe(message);
  expect(within(dialog).queryByRole("button", { name: t.confirmImport })).toBeNull();
  expect(storedHistory()).toEqual([]);
});

it.each(["getItem", "setItem"] as const)(
  "keeps the last confirmed statistics after a storage %s failure",
  async (method) => {
    const [first, second] = history;
    localStorage.setItem(recordsKey, JSON.stringify([first]));
    render(<App />);
    const dialog = await openStatistics();
    await chooseFile(dialog, historyFile([second]));
    const confirm = await within(dialog).findByRole("button", { name: t.confirmImport });
    const blocked = vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    fireEvent.click(confirm);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(t.localUnavailable);
    blocked.mockRestore();
    expect(storedHistory()).toEqual([first]);
    expect(value(dialog, t.played)?.textContent).toBe(`1${t.played}`);

    fireEvent.click(confirm);
    await within(dialog).findByText(t.historyImported);
    expect(storedHistory()).toEqual([first, second]);
  },
);

it("requires a new confirmation when a conflicting result changes with the same counts", async () => {
  const [first, second] = history;
  const original = { ...first, attempts: 3 };
  const replacement = { ...first, won: false, attempts: 8 };
  localStorage.setItem(recordsKey, JSON.stringify([original]));
  render(<App />);
  const dialog = await openStatistics();
  await chooseFile(dialog, historyFile([first, second]));
  const confirm = await within(dialog).findByRole("button", { name: t.confirmImport });
  expect(within(dialog).getByRole("listitem").textContent).toContain(`${t.historyWin} (3/8)`);
  localStorage.setItem(recordsKey, JSON.stringify([replacement]));
  fireEvent.click(confirm);
  await within(dialog).findByText(t.historyChanged);
  expect(storedHistory()).toEqual([replacement]);
  expect(within(dialog).getByRole("listitem").textContent).toContain(`${t.historyLoss} (8/8)`);

  fireEvent.click(confirm);
  await within(dialog).findByText(t.historyImported);
  expect(storedHistory()).toEqual([replacement, second]);
});
