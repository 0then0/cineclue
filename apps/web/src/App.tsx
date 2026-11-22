import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import type {
  ArchivePage,
  Difficulty,
  GameView,
  HintKind,
  PublicMovie,
} from "../../../packages/game-engine/src/model.ts";
import { Answer } from "./Answer.tsx";
import { Clues } from "./Clues.tsx";
import { Confetti } from "./Confetti.tsx";
import { packName } from "./catalog-i18n.ts";
import {
  api,
  establishVisitor,
  HttpError,
  publicRead,
  readStorage,
  writeStorage,
} from "./client.ts";
import { FilmShelf } from "./FilmShelf.tsx";
import { HelpDialog } from "./Help.tsx";
import { Hints } from "./Hints.tsx";
import {
  detectLocale,
  dictionaries,
  isLocale,
  type Locale,
  languages,
  type Messages,
  titleOf,
} from "./i18n.ts";
import { MediaCredits, MediaPicture, useMovieMedia } from "./Media.tsx";
import { readRecords, readStoredRecords, recordsKey, saveRecord } from "./records.ts";
import { type DailyRecord, shareText } from "./results.ts";
import { Search } from "./Search.tsx";
import { StatsDialog } from "./StatsDialog.tsx";
import { Tips } from "./Tips.tsx";
import {
  readUnlimitedSession,
  saveUnlimitedSession,
  type UnlimitedSession,
} from "./unlimited-session.ts";

type Pack = {
  id: string;
  name: Record<string, string>;
  count: number;
  counts?: Record<Difficulty, number>;
  category?: "all" | "genre" | "era" | "director" | "country";
  rules?: { yearMin?: number; yearMax?: number };
};
type CatalogInfo = { packs: Pack[]; catalogSize: number; dataSources?: string[] };
type Theme = "system" | "light" | "dark";
const route = () => window.location.pathname;
function errorMessage(e: unknown, t: Messages) {
  return e instanceof HttpError && e.code in t ? t[e.code as keyof Messages] : t.error;
}
function ChallengeMovie({ movie, locale, t }: { movie: PublicMovie; locale: Locale; t: Messages }) {
  const media = useMovieMedia(movie.id);
  return (
    <article className="challenge-movie">
      <MediaPicture
        key={media.poster?.url ?? movie.id}
        image={media.poster}
        name={titleOf(movie, locale)}
        poster
      />
      <div>
        <h3>{titleOf(movie, locale)}</h3>
        <p>{movie.releaseYear}</p>
        {movie.originalTitle !== titleOf(movie, locale) && <p>{movie.originalTitle}</p>}
      </div>
      <MediaCredits media={media} t={t} />
    </article>
  );
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = readStorage<unknown>("cineclue:locale", null);
    return isLocale(saved)
      ? saved
      : detectLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
  });
  const [theme, setTheme] = useState<Theme>(() => {
    const v = readStorage<string>("cineclue:theme", "system");
    return v === "dark" || v === "light" ? v : "system";
  });
  const [celebration, setCelebration] = useState<string | null>(null);
  const [path, setPath] = useState(route);
  const activePath = useRef(path);
  const [game, setGame] = useState<GameView | null>(null);
  const [archivePage, setArchivePage] = useState<ArchivePage | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [records, setRecords] = useState<DailyRecord[]>(readRecords);
  const [showHelp, setShowHelp] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const builder = path === "/challenge";
  const archiveList = path === "/archive" || path === "/archive/";
  const isArchive = archiveList || path.startsWith("/archive/");
  const [createdChallenge, setCreatedChallenge] = useState<{
    url: string;
    movie: PublicMovie;
  } | null>(null);
  const challengeUrl = createdChallenge?.url ?? "";
  const [packs, setPacks] = useState<Pack[]>([]);
  const [tmdbData, setTmdbData] = useState(false);
  const [catalogSize, setCatalogSize] = useState<number | null>(null);
  const [pack, setPack] = useState("popular");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [now, setNow] = useState(Date.now());
  const [fallbackShare, setFallbackShare] = useState("");
  const t = dictionaries[locale];
  const requestId = useRef(0);
  const visitor = useRef<Promise<void> | null>(null);
  const ensureVisitor = useCallback(() => {
    visitor.current ??= establishVisitor().catch((error) => {
      visitor.current = null;
      throw error;
    });
    return visitor.current;
  }, []);
  const persistDailyResult = useCallback((value: GameView, id: number) => {
    if (value.mode !== "daily" || value.status === "playing" || !value.date) return;
    const record = {
      date: value.date,
      won: value.status === "won",
      attempts: value.guesses.length,
    };
    void saveRecord(record).then((result) => {
      if (result.saved) setRecords(result.records);
      else if (id === requestId.current) setNotice("localUnavailable");
    });
  }, []);
  const unlimitedSession = useRef<UnlimitedSession | null>(readUnlimitedSession());
  const startingUnlimited = useRef<Promise<GameView> | null>(null);
  const startUnlimited = useCallback(
    (difficulty: Difficulty, pack: string) => {
      // StrictMode and repeated loads must share a single session-creation request.
      if (!startingUnlimited.current) {
        startingUnlimited.current = ensureVisitor()
          .then(() => api<GameView>("/unlimited", { difficulty, pack }))
          .then((value) => {
            const saved = { id: value.id, pack };
            unlimitedSession.current = saved;
            saveUnlimitedSession(saved);
            return value;
          })
          .finally(() => {
            startingUnlimited.current = null;
          });
      }
      return startingUnlimited.current;
    },
    [ensureVisitor],
  );
  useEffect(() => {
    document.documentElement.lang = locale;
    writeStorage("cineclue:locale", locale);
  }, [locale]);
  useEffect(() => {
    document.title = `CineClue · ${isArchive ? t.archive : t.headline}`;
  }, [isArchive, t]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStorage("cineclue:theme", theme);
  }, [theme]);
  const changePath = useCallback((url: string) => {
    if (url === activePath.current) return;
    activePath.current = url;
    requestId.current++;
    setPath(url);
    setGame(null);
    setArchivePage(null);
    setPending(true);
    setError(null);
    setCreatedChallenge(null);
    setNotice("");
    setFallbackShare("");
    setCelebration(null);
  }, []);
  useEffect(() => {
    const listener = () => changePath(route());
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, [changePath]);
  const navigate = useCallback(
    (url: string) => {
      if (url === activePath.current) return;
      if (url.startsWith("/archive") || activePath.current.startsWith("/archive")) {
        document.documentElement.scrollTop = 0;
      }
      window.history.pushState({}, "", url);
      changePath(url);
    },
    [changePath],
  );
  function followRoute(event: MouseEvent<HTMLAnchorElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    navigate(event.currentTarget.pathname);
  }
  const load = useCallback(
    async (before?: string) => {
      const id = ++requestId.current;
      setPending(true);
      setError(null);
      setGame(null);
      if (path === "/challenge") {
        setPending(false);
        return;
      }
      try {
        await ensureVisitor();
        if (id !== requestId.current) return;
        if (archiveList) {
          const page = await api<ArchivePage>(before ? `/archive?before=${before}` : "/archive");
          if (id === requestId.current) {
            setArchivePage((current) => ({
              ...page,
              dates: before && current ? [...current.dates, ...page.dates] : page.dates,
            }));
          }
          return;
        }
        const legacyUnlimited = path.startsWith("/unlimited/");
        let value: GameView;
        if (isArchive) {
          value = await api<GameView>(path, {});
        } else if (path === "/unlimited") {
          const active = unlimitedSession.current;
          if (active) {
            try {
              value = await api<GameView>(`/unlimited/${encodeURIComponent(active.id)}`);
            } catch (e) {
              if (id !== requestId.current) return;
              if (!(e instanceof HttpError) || e.code !== "not_found") throw e;
              const replacement = unlimitedSession.current;
              if (replacement && replacement.id !== active.id) {
                value = await api<GameView>(`/unlimited/${encodeURIComponent(replacement.id)}`);
              } else {
                unlimitedSession.current = null;
                saveUnlimitedSession(null);
                value = await startUnlimited("normal", active.pack);
              }
            }
          } else {
            value = await startUnlimited("normal", "popular");
          }
        } else {
          const endpoint = path.startsWith("/challenge/")
            ? `/challenges/${path.split("/")[2]}`
            : legacyUnlimited
              ? path
              : "/daily";
          value = await api<GameView>(endpoint);
        }
        persistDailyResult(value, id);
        if (id === requestId.current) {
          if (value.mode === "unlimited") {
            const active = unlimitedSession.current;
            const saved = { id: value.id, pack: active?.id === value.id ? active.pack : "popular" };
            unlimitedSession.current = saved;
            saveUnlimitedSession(saved);
            setDifficulty(value.difficulty);
            setPack(saved.pack);
            if (legacyUnlimited) {
              window.history.replaceState({}, "", "/unlimited");
              changePath("/unlimited");
              return;
            }
          }
          setGame(value);
        }
      } catch (e) {
        if (id === requestId.current) setError(e);
      } finally {
        if (id === requestId.current) setPending(false);
      }
    },
    [archiveList, changePath, ensureVisitor, isArchive, path, persistDailyResult, startUnlimited],
  );
  useEffect(() => {
    void load();
    return () => {
      requestId.current++;
    };
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    publicRead<CatalogInfo>("/packs", controller.signal)
      .then((b) => {
        if (controller.signal.aborted) return;
        setPacks(b.packs);
        setCatalogSize(b.catalogSize);
        setTmdbData(b.dataSources?.includes("tmdb") ?? false);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (isArchive) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isArchive]);
  useEffect(() => {
    if (
      game?.mode === "daily" &&
      game.nextPuzzleAt &&
      Date.parse(game.nextPuzzleAt) <= now &&
      !pending
    )
      void load();
  }, [game, now, load, pending]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== recordsKey && event.key !== null) return;
      const latest = readStoredRecords();
      if (latest) setRecords(latest);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  async function guess(movie: PublicMovie) {
    if (!game || pending) return;
    setPending(true);
    setError(null);
    const id = requestId.current;
    const endpoint = {
      daily: "/daily/guess",
      archive: `/archive/${game.date}/guess`,
      challenge: `/challenges/${path.split("/")[2]}/guess`,
      unlimited: `/unlimited/${game.id}/guess`,
    }[game.mode];
    try {
      const value = await api<GameView>(endpoint, {
        movieId: movie.id,
        ...(game.mode === "daily" || game.mode === "archive" ? { gameId: game.id } : {}),
      });
      persistDailyResult(value, id);
      if (id === requestId.current) {
        setGame(value);
        if (value.status === "won" && game.status === "playing") setCelebration(value.id);
      }
    } catch (e) {
      if (id === requestId.current) setError(e);
      throw e;
    } finally {
      if (id === requestId.current) setPending(false);
    }
  }
  async function useHint(kind: HintKind) {
    if (!game || pending) return;
    const id = requestId.current;
    setPending(true);
    try {
      const value =
        game.mode === "archive"
          ? await api<GameView>(`/archive/${game.date}/hints`, { kind, gameId: game.id })
          : await api<GameView>(`/games/${game.id}/hints`, { kind });
      if (id === requestId.current) setGame(value);
    } finally {
      if (id === requestId.current) setPending(false);
    }
  }
  async function newUnlimited() {
    setPending(true);
    setError(null);
    const id = ++requestId.current;
    try {
      const value = await startUnlimited(difficulty, pack);
      if (id === requestId.current) {
        const saved = { id: value.id, pack };
        unlimitedSession.current = saved;
        saveUnlimitedSession(saved);
        setGame(value);
        setNotice("");
        setFallbackShare("");
        navigate("/unlimited");
      }
    } catch (e) {
      if (id === requestId.current) setError(e);
    } finally {
      if (id === requestId.current) setPending(false);
    }
  }
  async function createChallenge(movie: PublicMovie) {
    setPending(true);
    setError(null);
    const id = requestId.current;
    try {
      await ensureVisitor();
      if (id !== requestId.current) return;
      const value = await api<{ path: string }>("/challenges", { movieId: movie.id });
      if (id === requestId.current) {
        setCreatedChallenge({ url: `${window.location.origin}${value.path}`, movie });
      }
    } catch (e) {
      if (id === requestId.current) setError(e);
      throw e;
    } finally {
      if (id === requestId.current) setPending(false);
    }
  }
  async function share() {
    if (!game) return;
    const id = requestId.current;
    const text = shareText(game, t);
    try {
      if (navigator.share) {
        try {
          await navigator.share({ text });
          if (id === requestId.current) setNotice("shared");
          return;
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") return;
        }
      }
      await navigator.clipboard.writeText(text);
      if (id === requestId.current) setNotice("shared");
    } catch (e) {
      if (id !== requestId.current) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      setFallbackShare(text);
      setNotice("shareUnavailable");
    }
  }
  async function copyChallenge() {
    try {
      await navigator.clipboard.writeText(challengeUrl);
      setNotice("copied");
    } catch {
      setNotice("shareUnavailable");
    }
  }
  const seconds = Math.max(
    0,
    Math.floor(((game?.nextPuzzleAt ? Date.parse(game.nextPuzzleAt) : now) - now) / 1000),
  );
  const countdown = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const mode = isArchive
    ? "archive"
    : builder || path.startsWith("/challenge/")
      ? "challenge"
      : path === "/unlimited" || path.startsWith("/unlimited/")
        ? "unlimited"
        : "daily";
  const dateFormat = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const formatDate = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`));
  return (
    <>
      <header className="site-header">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          <img src="/icon.svg" width="38" height="38" alt="" />
          <span>CineClue</span>
        </a>
        <nav className="mode-nav" aria-label={t.gameMode}>
          <button
            type="button"
            aria-current={mode === "daily" ? "page" : undefined}
            onClick={() => navigate("/")}
          >
            {t.daily}
            <span className="live-dot" />
          </button>
          <button
            type="button"
            aria-current={mode === "archive" ? "page" : undefined}
            onClick={() => navigate("/archive")}
          >
            {t.archive}
          </button>
          <button
            type="button"
            aria-current={mode === "unlimited" ? "page" : undefined}
            onClick={() => {
              if (path !== "/unlimited" || builder) navigate("/unlimited");
            }}
            disabled={pending}
          >
            {t.unlimited}
          </button>
          <button
            type="button"
            aria-current={mode === "challenge" ? "page" : undefined}
            onClick={() => {
              if (path !== "/challenge") navigate("/challenge");
              setCreatedChallenge(null);
              setError(null);
              setNotice("");
            }}
            disabled={pending}
          >
            {t.challenge}
          </button>
        </nav>
        <div className="utilities">
          <button
            type="button"
            className="utility-button help-button"
            aria-label={t.help}
            title={t.help}
            onClick={() => setShowHelp(true)}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M8 8a4 4 0 1 1 6.5 3.1C13 12.2 12 12.8 12 15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle cx="12" cy="19" r="1.2" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="utility-button"
            onClick={() => setShowStats(true)}
            aria-label={t.stats}
            title={t.stats}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M3 3v17a1 1 0 0 0 1 1h17"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <rect x="6" y="13" width="3" height="5" rx="0.8" fill="currentColor" />
              <rect x="11" y="9" width="3" height="9" rx="0.8" fill="currentColor" />
              <rect x="16" y="4" width="3" height="14" rx="0.8" fill="currentColor" />
            </svg>
          </button>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as Theme)}
            aria-label={t.system}
            className="theme-select"
          >
            <option value="system">◐ {t.system}</option>
            <option value="light">☀ {t.light}</option>
            <option value="dark">☾ {t.dark}</option>
          </select>
          <select
            className="language-select"
            data-locale={locale}
            value={locale}
            onChange={(e) => {
              if (isLocale(e.target.value)) setLocale(e.target.value);
            }}
            aria-label={t.language}
            title={`${t.language}: ${languages.find((language) => language.code === locale)?.name}`}
          >
            {languages.map((language) => (
              <option
                key={language.code}
                value={language.code}
                lang={language.code}
                aria-label={language.name}
              >
                {language.flag} {language.short}
              </option>
            ))}
          </select>
        </div>
      </header>
      <main>
        <section className={archiveList ? "intro archive-intro" : "intro"}>
          <div className="intro-copy">
            <h1>{archiveList ? t.archive : builder ? t.challengeTitle : t.headline}</h1>
            <p>
              {archiveList
                ? t.archiveIntro
                : builder
                  ? t.challengeIntro
                  : mode === "unlimited"
                    ? t.practice
                    : mode === "challenge"
                      ? t.friend
                      : t.intro}
            </p>
          </div>
          {!archiveList && <FilmShelf label={t.posterArt} locale={locale} />}
        </section>
        <section className="game-panel" aria-busy={pending}>
          {archiveList ? (
            archivePage ? (
              <div className="archive-puzzles">
                {archivePage.dates.length === 0 ? (
                  <p>{t.archiveEmpty}</p>
                ) : (
                  <ol className="archive-dates">
                    {archivePage.dates.map((day) => (
                      <li key={day}>
                        <a href={`/archive/${day}`} onClick={followRoute}>
                          <time dateTime={day}>{formatDate(day)}</time>
                          <span aria-hidden="true">›</span>
                        </a>
                      </li>
                    ))}
                  </ol>
                )}
                {archivePage.nextBefore && (
                  <div className="button-row">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void load(archivePage.nextBefore ?? undefined)}
                    >
                      {t.archiveMore}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              pending && (
                <p className="loading" role="status">
                  {t.loading}
                </p>
              )
            )
          ) : builder ? (
            <>
              <div className="panel-heading">
                <span>{t.challenge}</span>
                <span>↗</span>
              </div>
              {challengeUrl ? (
                <div className="challenge-ready">
                  <h2>{t.challengeReady}</h2>
                  {createdChallenge && (
                    <ChallengeMovie movie={createdChallenge.movie} locale={locale} t={t} />
                  )}
                  <label htmlFor="challenge-link">{t.challenge}</label>
                  <input
                    id="challenge-link"
                    readOnly
                    value={challengeUrl}
                    onFocus={(e) => e.target.select()}
                  />
                  <div className="button-row">
                    <button type="button" className="primary" onClick={() => void copyChallenge()}>
                      {t.copy}
                    </button>
                    <button type="button" onClick={() => setCreatedChallenge(null)}>
                      {t.createAnother}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="search-area">
                  <Search locale={locale} t={t} disabled={pending} onSelect={createChallenge} />
                </div>
              )}
            </>
          ) : (
            <>
              <div className="panel-heading">
                <span>
                  <span className="tiny-square" /> {mode === "daily" ? t.today : t[mode]}{" "}
                  {game?.date && (
                    <small>
                      <time dateTime={game.date}>{formatDate(game.date)}</time>
                    </small>
                  )}
                </span>
                <span className="attempt-count">
                  {game ? `${game.guesses.length} / ${game.maxAttempts}` : "— / 8"}
                </span>
              </div>
              {isArchive && (
                <div className="archive-return">
                  <a href="/" onClick={followRoute}>
                    {t.backToDaily}
                  </a>
                </div>
              )}
              {mode === "unlimited" && (
                <div className="game-options">
                  <label>
                    {t.difficulty}
                    <select
                      value={difficulty}
                      onChange={(e) => setDifficulty(e.target.value as Difficulty)}
                    >
                      {(["easy", "normal", "hard"] as const).map((d) => (
                        <option key={d} value={d}>
                          {t[d]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t.pack}
                    <select value={pack} onChange={(e) => setPack(e.target.value)}>
                      {packs
                        .filter((p) => p.id === "popular")
                        .map((p) => (
                          <option value={p.id} key={p.id}>
                            {packName(p, locale)} ({p.counts?.[difficulty] ?? p.count})
                          </option>
                        ))}
                      {(["genre", "country", "era", "director"] as const).map((category) => (
                        <optgroup key={category} label={t[`${category}Collections`]}>
                          {packs
                            .filter(
                              (p) => p.id !== "popular" && (p.category ?? "genre") === category,
                            )
                            .sort((a, b) =>
                              category === "era"
                                ? (a.rules?.yearMin ?? a.rules?.yearMax ?? 0) -
                                  (b.rules?.yearMin ?? b.rules?.yearMax ?? 0)
                                : packName(a, locale).localeCompare(packName(b, locale), locale),
                            )
                            .map((p) => (
                              <option
                                value={p.id}
                                key={p.id}
                                disabled={(p.counts?.[difficulty] ?? p.count) === 0}
                              >
                                {packName(p, locale)} ({p.counts?.[difficulty] ?? p.count})
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <button type="button" disabled={pending} onClick={() => void newUnlimited()}>
                    {t.newGame} ↗
                  </button>
                </div>
              )}
              {!game && pending && (
                <p className="loading" role="status">
                  {t.loading}
                </p>
              )}
              {game && (
                <>
                  <div
                    className="attempt-track"
                    role="img"
                    aria-label={`${game.guesses.length} ${t.of} ${game.maxAttempts}`}
                  >
                    {Array.from({ length: 8 }, (_, i) => (
                      <span
                        key={`slot-${i + 1}`}
                        className={
                          i < game.guesses.length
                            ? game.status === "won" && i === game.guesses.length - 1
                              ? "solved"
                              : "used"
                            : ""
                        }
                      />
                    ))}
                  </div>
                  {game.status === "playing" ? (
                    <div className="search-area">
                      <Search
                        locale={locale}
                        t={t}
                        disabled={pending}
                        excluded={game.guesses.map((g) => g.movie.id)}
                        onSelect={guess}
                      />
                    </div>
                  ) : (
                    <section className={`finish ${game.status}`}>
                      {game.status === "won" && celebration === game.id && (
                        <Confetti key={game.id} />
                      )}
                      <p className="eyebrow">
                        {game.status === "won" ? "✓" : "↘"} {game.guesses.length} / 8
                      </p>
                      <h2>{t[game.status]}</h2>
                      <p>{t.answer}</p>
                      {game.answer && (
                        <Answer key={game.answer.id} movie={game.answer} locale={locale} t={t} />
                      )}
                      <div className="button-row">
                        <button type="button" className="primary" onClick={() => void share()}>
                          {t.share} ↗
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => (isArchive ? navigate("/archive") : void newUnlimited())}
                        >
                          {isArchive ? t.archive : t.next}
                        </button>
                      </div>
                    </section>
                  )}
                  <Hints
                    key={game.id}
                    game={game}
                    locale={locale}
                    t={t}
                    pending={pending}
                    onUse={useHint}
                  />
                  <Clues game={game} locale={locale} t={t} />
                </>
              )}
            </>
          )}
          {error !== null && (
            <div className="error" role="alert">
              <p>{errorMessage(error, t)}</p>
              <button
                type="button"
                disabled={pending}
                onClick={() => void load(archivePage?.nextBefore ?? undefined)}
              >
                {t.retry}
              </button>
            </div>
          )}
          {notice && (
            <p className="notice" role="status">
              {t[notice as keyof Messages] ?? notice}
            </p>
          )}
          {fallbackShare && (
            <textarea
              className="share-fallback"
              aria-label={t.share}
              readOnly
              value={fallbackShare}
              onFocus={(e) => e.target.select()}
            />
          )}
        </section>
        {!archiveList && <Tips t={t} />}
        <div className="below-game">
          {game?.mode === "daily" && !builder && (
            <p className="countdown">
              {t.nextDaily} <strong>{countdown}</strong>
              <small>00:00 UTC</small>
            </p>
          )}
        </div>
      </main>
      <footer>
        <span>
          {catalogSize !== null && `${catalogSize} ${t.catalog} · `}
          {tmdbData ? t.mixedData : t.openData}
        </span>
        <div className="tmdb-credit catalog-credit">
          <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer">
            <img src="/tmdb.svg" alt="TMDB" width="72" height="10" />
          </a>
          <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        </div>
      </footer>
      {showHelp && <HelpDialog t={t} onClose={() => setShowHelp(false)} />}
      {showStats && (
        <StatsDialog
          records={records}
          t={t}
          onImport={setRecords}
          onClose={() => setShowStats(false)}
        />
      )}
    </>
  );
}
