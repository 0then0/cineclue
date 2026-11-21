import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { useBackdropClose } from "./dialog.ts";
import type { Messages } from "./i18n.ts";
import {
  applyHistoryImport,
  type HistoryImportPlan,
  historyFileLimit,
  planHistoryImport,
  readHistoryFile,
  readStoredRecords,
  serializeHistory,
} from "./records.ts";
import { type DailyRecord, dailyAttemptLimit, stats } from "./results.ts";

type Preview = { incoming: DailyRecord[]; plan: HistoryImportPlan };
type Feedback = { role: "alert" | "status"; message: keyof Messages };

export function StatsDialog({
  records,
  t,
  onImport,
  onClose,
}: {
  records: DailyRecord[];
  t: Messages;
  onImport: (records: DailyRecord[]) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const feedbackText = useRef<HTMLParagraphElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState<"reading" | "saving" | null>(null);
  const data = stats(records);
  const backdropClose = useBackdropClose();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  useEffect(() => {
    const target = feedback ? feedbackText.current : previewHeading.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "start" });
  }, [preview, feedback]);

  function downloadHistory() {
    const blob = new Blob([serializeHistory(records)], { type: "application/json" });
    if (blob.size > historyFileLimit) {
      setFeedback({ role: "alert", message: "historyFileTooLarge" });
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "cineclue-daily-history.json";
    link.hidden = true;
    ref.current?.append(link);
    link.click();
    link.remove();
    const revoke = URL.revokeObjectURL.bind(URL);
    window.setTimeout(() => revoke(url), 1000);
  }

  async function previewFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || busy) return;
    setPreview(null);
    setFeedback(null);
    setBusy("reading");
    const result = await readHistoryFile(file);
    setBusy(null);
    if ("error" in result) {
      setFeedback({ role: "alert", message: result.error });
      return;
    }
    const current = readStoredRecords();
    if (!current) {
      setFeedback({ role: "alert", message: "localUnavailable" });
      return;
    }
    setPreview({ incoming: result.records, plan: planHistoryImport(result.records, current) });
  }

  async function confirmImport() {
    if (!preview || busy) return;
    setFeedback(null);
    setBusy("saving");
    const result = await applyHistoryImport(preview.incoming, preview.plan);
    setBusy(null);
    if (result.status === "unavailable") {
      setFeedback({ role: "alert", message: "localUnavailable" });
    } else if (result.status === "changed") {
      setPreview({ incoming: preview.incoming, plan: result.plan });
      setFeedback({ role: "status", message: "historyChanged" });
    } else {
      onImport(result.records);
      setPreview(null);
      setFeedback({ role: "status", message: "historyImported" });
    }
  }

  function cancelImport() {
    setPreview(null);
    setFeedback(null);
    importButton.current?.focus();
  }

  const describe = (record: DailyRecord) =>
    `${record.won ? t.historyWin : t.historyLoss} (${record.attempts}/${dailyAttemptLimit})`;
  return (
    <dialog
      ref={ref}
      className="stats-dialog"
      aria-labelledby="stats-title"
      onClose={onClose}
      onCancel={(event) => {
        if (busy === "saving") event.preventDefault();
      }}
      {...(busy === "saving" ? {} : backdropClose)}
    >
      <div className="dialog-heading">
        <h2 id="stats-title">{t.stats}</h2>
        <button
          type="button"
          disabled={busy === "saving"}
          onClick={() => ref.current?.close()}
          aria-label={t.closeDialog}
        >
          ×
        </button>
      </div>
      <div className="stats-grid">
        {(["played", "wins", "winRate", "streak", "best"] as const).map((k) => (
          <div key={k}>
            <strong>{data[k]}</strong>
            <span>{t[k]}</span>
          </div>
        ))}
      </div>
      <h3>{t.distribution}</h3>
      {data.played === 0 && <p>{t.noStats}</p>}
      <div className="distribution">
        {data.distribution.map((count, index) => (
          <div key={`attempt-${index + 1}`}>
            <span>{index + 1}</span>
            <div
              style={{ width: `${Math.max(4, (count / Math.max(1, ...data.distribution)) * 85)}%` }}
            >
              {count}
            </div>
          </div>
        ))}
      </div>
      <small>{t.statsNote}</small>
      <div className="history-transfer">
        <div className="button-row">
          <button type="button" disabled={busy !== null} onClick={downloadHistory}>
            {t.exportHistory}
          </button>
          <button
            type="button"
            ref={importButton}
            disabled={busy !== null}
            onClick={() => fileInput.current?.click()}
          >
            {t.importHistory}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            aria-label={t.importHistory}
            onChange={(event) => void previewFile(event)}
            hidden
          />
        </div>
        {busy && <p role="status">{busy === "reading" ? t.historyReading : t.historySaving}</p>}
        {feedback && (
          <p ref={feedbackText} role={feedback.role} tabIndex={-1}>
            {t[feedback.message]}
          </p>
        )}
        {preview && (
          <section className="history-preview" aria-labelledby="history-preview-title">
            <h3 id="history-preview-title" ref={previewHeading} tabIndex={-1}>
              {t.historyPreview}
            </h3>
            <dl className="history-counts">
              <div>
                <dt>{t.historyToAdd}</dt>
                <dd>{preview.plan.additions.length}</dd>
              </div>
              <div>
                <dt>{t.historyMatching}</dt>
                <dd>{preview.plan.matching}</dd>
              </div>
              <div>
                <dt>{t.historyConflicting}</dt>
                <dd>{preview.plan.conflicts.length}</dd>
              </div>
            </dl>
            {preview.plan.conflicts.length > 0 && (
              <>
                <p>{t.historyKeepLocal}</p>
                <ul className="history-conflicts">
                  {preview.plan.conflicts.map(({ local, incoming }) => (
                    <li key={local.date}>
                      <time dateTime={local.date}>{local.date}</time>
                      <span>
                        {t.historyLocalResult} <strong>{describe(local)}</strong>
                      </span>
                      <span>
                        {t.historyFileResult} <strong>{describe(incoming)}</strong>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="button-row">
              <button
                type="button"
                className="primary"
                disabled={busy !== null}
                onClick={() => void confirmImport()}
              >
                {t.confirmImport}
              </button>
              <button type="button" disabled={busy !== null} onClick={cancelImport}>
                {t.cancelImport}
              </button>
            </div>
          </section>
        )}
      </div>
    </dialog>
  );
}
