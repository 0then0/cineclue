import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { establishVisitor, type PlayerSession, writeStorage } from "./client.ts";
import { isMiniApp, telegramWebApp } from "./telegram.ts";

const notificationKey = "cineclue:session-change";
const announceSessionChange = () => writeStorage(notificationKey, crypto.randomUUID());

export function usePlayerSession() {
  const [session, setSession] = useState<PlayerSession | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loginResult] = useState(() => new URLSearchParams(location.search).get("telegram"));
  const pending = useRef<Promise<PlayerSession> | null>(null);
  const proof = useRef<string | undefined>(undefined);
  const checkedLaunch = useRef(false);
  const refresh = useCallback((clear = false) => {
    if (clear) {
      pending.current = null;
      proof.current = undefined;
      checkedLaunch.current = false;
      setSession(null);
      setError(null);
    }
    pending.current ??= establishVisitor(
      isMiniApp()
        ? {
            initData: checkedLaunch.current ? "" : (telegramWebApp()?.initData ?? ""),
            proof: proof.current,
          }
        : undefined,
    );
    const request = pending.current;
    void request.then(
      (value) => {
        if (pending.current !== request) return;
        pending.current = null;
        proof.current = value.miniAppProof;
        checkedLaunch.current = true;
        setSession(value);
        setError(null);
      },
      (error) => {
        if (pending.current !== request) return;
        pending.current = null;
        setError(error);
      },
    );
  }, []);
  const update = useCallback((value: PlayerSession) => {
    pending.current = null;
    proof.current = value.miniAppProof;
    checkedLaunch.current = true;
    setSession(value);
    setError(null);
    announceSessionChange();
  }, []);

  useEffect(() => {
    const url = new URL(location.href);
    if (!url.searchParams.has("telegram")) return;
    url.searchParams.delete("telegram");
    history.replaceState(history.state, "", url);
    if (loginResult === "signed-in") announceSessionChange();
  }, [loginResult]);
  useEffect(() => {
    refresh();
    const check = () => {
      if (!document.hidden) refresh();
    };
    const sync = (event: StorageEvent) => {
      if (event.key === notificationKey) refresh(true);
    };
    const suspend = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      pending.current = null;
      // Leave only the loading view in the back-forward cache for a signed-in player.
      flushSync(() => setSession((current) => (current?.player ? null : current)));
    };
    window.addEventListener("storage", sync);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [refresh]);
  const expiresInMs = session?.player?.expiresInMs;
  useEffect(() => {
    if (expiresInMs === undefined) return;
    const timer = window.setTimeout(() => refresh(true), expiresInMs);
    return () => window.clearTimeout(timer);
  }, [expiresInMs, refresh]);
  return { session, error, loginResult, refresh, update };
}
