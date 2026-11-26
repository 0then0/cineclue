type TelegramWebApp = {
  platform: string;
  initData: string;
  initDataUnsafe?: { start_param?: unknown };
  ready: () => void;
  expand: () => void;
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (callback: () => void) => void;
    offClick: (callback: () => void) => void;
  };
  openTelegramLink?: (url: string) => void;
  onEvent?: (event: "activated", callback: () => void) => void;
  offEvent?: (event: "activated", callback: () => void) => void;
};

const entryPath = "/telegram";
export const invalidMiniAppChallenge = "/telegram/challenge-unavailable";
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const prefix = "challenge_";

export function telegramWebApp() {
  const bridge = (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
  return bridge && (bridge.initData || (bridge.platform && bridge.platform !== "unknown"))
    ? bridge
    : undefined;
}

export function miniAppPath(payload: unknown) {
  if (payload === undefined || payload === "") return "/";
  if (typeof payload !== "string") return invalidMiniAppChallenge;
  const id = payload.slice(prefix.length);
  return payload.length <= 512 && payload.startsWith(prefix) && id.length === 36 && uuid.test(id)
    ? `/challenge/${id.toLowerCase()}`
    : invalidMiniAppChallenge;
}

export function telegramGameLink(bot: string, path: string) {
  const id = path.startsWith("/challenge/") ? path.slice("/challenge/".length) : "";
  return `https://t.me/${bot}?startapp${id ? `=${prefix}${id}` : ""}`;
}

export function telegramShareLink(url: string, text: string) {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

export function isMiniApp() {
  return Boolean(
    telegramWebApp() ||
      window.history.state?.cineclueMiniApp ||
      window.location.pathname === entryPath,
  );
}

export function miniAppHistoryState() {
  return isMiniApp() ? { cineclueMiniApp: true } : {};
}

export async function initializeMiniApp() {
  const { pathname, search, hash } = window.location;
  const launch = pathname === entryPath;
  const telegramFragment = new URLSearchParams(hash.slice(1)).has("tgWebAppData");
  if (!launch && !window.history.state?.cineclueMiniApp && !telegramFragment) {
    return;
  }
  if (!telegramWebApp()) {
    await new Promise<void>((resolve) => {
      const sdk = document.createElement("script");
      sdk.src = "https://telegram.org/js/telegram-web-app.js?65";
      const finish = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      const timeout = window.setTimeout(() => {
        sdk.remove();
        finish();
      }, 3000);
      sdk.onload = finish;
      sdk.onerror = finish;
      document.head.append(sdk);
    });
  }
  if (launch) {
    const fromUrl = new URLSearchParams(search).getAll("tgWebAppStartParam");
    const payload = telegramWebApp()?.initDataUnsafe?.start_param ?? fromUrl[0];
    const path = fromUrl.length > 1 ? invalidMiniAppChallenge : miniAppPath(payload);
    window.history.replaceState(miniAppHistoryState(), "", path);
  } else if (telegramFragment) {
    window.history.replaceState({ cineclueMiniApp: true }, "", pathname + search);
  }
}
