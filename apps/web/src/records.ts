import { withBrowserLock, writeStorage } from "./client.ts";
import { type DailyRecord, dailyAttemptLimit } from "./results.ts";

export const recordsKey = "cineclue:records";
export const historyFileLimit = 6 * 1024 * 1024;
const historyFormat = "cineclue:daily-history";
const historyVersion = 1;

const compareDates = (a: DailyRecord, b: DailyRecord) => a.date.localeCompare(b.date);
const recordsByDate = (records: DailyRecord[]) => new Map(records.map((r) => [r.date, r]));
const recordFields = ({ date, won, attempts }: DailyRecord): DailyRecord => ({
  date,
  won,
  attempts,
});
const sameResult = (a: DailyRecord, b: DailyRecord) => a.won === b.won && a.attempts === b.attempts;
const utcToday = () => new Date().toISOString().slice(0, 10);

function isDailyRecord(value: unknown): value is DailyRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "date" in value &&
    typeof value.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
    "won" in value &&
    typeof value.won === "boolean" &&
    "attempts" in value &&
    typeof value.attempts === "number" &&
    Number.isInteger(value.attempts) &&
    value.attempts >= 1 &&
    value.attempts <= dailyAttemptLimit
  );
}

function isCompletedRecord(record: unknown, today: string): record is DailyRecord {
  if (!isDailyRecord(record)) return false;
  const date = new Date(`${record.date}T00:00:00Z`);
  return (
    !record.date.startsWith("0000-") &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === record.date &&
    record.date <= today &&
    (record.won || record.attempts === dailyAttemptLimit)
  );
}

export function readStoredRecords(): DailyRecord[] | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(recordsKey);
  } catch {
    return null;
  }
  try {
    const data: unknown = raw ? JSON.parse(raw) : [];
    // Keep the existing storage format and its tolerant reader for older data.
    return Array.isArray(data) ? data.filter(isDailyRecord) : [];
  } catch {
    return [];
  }
}

export function readRecords(): DailyRecord[] {
  return readStoredRecords() ?? [];
}

export function saveRecord(record: DailyRecord) {
  return withBrowserLock(recordsKey, () => {
    const current = readStoredRecords();
    if (!current) return { records: [], saved: false };
    const records = current.some((r) => r.date === record.date)
      ? current
      : [...current, record].sort(compareDates);
    return { records, saved: writeStorage(recordsKey, records) };
  });
}

export function serializeHistory(records: DailyRecord[]) {
  const today = utcToday();
  const ordered = [...recordsByDate(records).values()]
    .filter((record) => isCompletedRecord(record, today))
    .sort(compareDates);
  return JSON.stringify({
    format: historyFormat,
    version: historyVersion,
    records: ordered.map(recordFields),
  });
}

type HistoryFileError =
  | "historyFileTooLarge"
  | "historyFileReadFailed"
  | "historyInvalidFile"
  | "historyUnsupportedVersion"
  | "historyInvalidRecord"
  | "historyDuplicateDate";

export async function readHistoryFile(
  file: File,
): Promise<{ records: DailyRecord[] } | { error: HistoryFileError }> {
  if (file.size > historyFileLimit) return { error: "historyFileTooLarge" };
  let contents: string;
  try {
    contents = await file.text();
  } catch {
    return { error: "historyFileReadFailed" };
  }
  let data: unknown;
  try {
    data = JSON.parse(contents);
  } catch {
    return { error: "historyInvalidFile" };
  }
  if (
    typeof data !== "object" ||
    data === null ||
    !("format" in data) ||
    data.format !== historyFormat ||
    !("version" in data) ||
    !Number.isInteger(data.version)
  ) {
    return { error: "historyInvalidFile" };
  }
  if (data.version !== historyVersion) return { error: "historyUnsupportedVersion" };
  if (!("records" in data) || !Array.isArray(data.records) || Object.keys(data).length !== 3) {
    return { error: "historyInvalidFile" };
  }
  const byDate = new Map<string, DailyRecord>();
  const today = utcToday();
  for (const record of data.records) {
    if (!isCompletedRecord(record, today) || Object.keys(record).length !== 3) {
      return { error: "historyInvalidRecord" };
    }
    const previous = byDate.get(record.date);
    if (previous && !sameResult(previous, record)) return { error: "historyDuplicateDate" };
    byDate.set(record.date, recordFields(record));
  }
  return { records: [...byDate.values()].sort(compareDates) };
}

export type HistoryImportPlan = {
  additions: DailyRecord[];
  matching: number;
  conflicts: { local: DailyRecord; incoming: DailyRecord }[];
};

export function planHistoryImport(incoming: DailyRecord[], current: DailyRecord[]) {
  const byDate = recordsByDate(current);
  const plan: HistoryImportPlan = { additions: [], matching: 0, conflicts: [] };
  for (const record of incoming) {
    const local = byDate.get(record.date);
    if (!local) plan.additions.push(record);
    else if (sameResult(local, record)) plan.matching++;
    else plan.conflicts.push({ local: recordFields(local), incoming: record });
  }
  return plan;
}

export function applyHistoryImport(incoming: DailyRecord[], preview: HistoryImportPlan) {
  return withBrowserLock(recordsKey, () => {
    const current = readStoredRecords();
    if (!current) return { status: "unavailable" } as const;
    const plan = planHistoryImport(incoming, current);
    // Compare the date-level decisions and displayed results, including changes within conflicts.
    if (JSON.stringify(plan) !== JSON.stringify(preview))
      return { status: "changed", plan } as const;
    if (!plan.additions.length) return { status: "saved", records: current } as const;
    const records = [...current, ...plan.additions].sort(compareDates);
    return writeStorage(recordsKey, records)
      ? ({ status: "saved", records } as const)
      : ({ status: "unavailable" } as const);
  });
}
