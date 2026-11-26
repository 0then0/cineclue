export type UnlimitedSession = { id: string; pack: string };
const storageKey = (player?: string) => `cineclue:unlimited:v1${player ? `:${player}` : ""}`;

export function readUnlimitedSession(player?: string): UnlimitedSession | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(player)) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      value.id.length > 0 &&
      "pack" in value &&
      typeof value.pack === "string"
    )
      return { id: value.id, pack: value.pack };
  } catch {
    // Games still work in memory when browser storage is unavailable.
  }
  return null;
}
export function saveUnlimitedSession(value: UnlimitedSession | null, player?: string) {
  try {
    if (value) sessionStorage.setItem(storageKey(player), JSON.stringify(value));
    else sessionStorage.removeItem(storageKey(player));
  } catch {
    // The App keeps an in-memory copy for navigation in this tab.
  }
}
