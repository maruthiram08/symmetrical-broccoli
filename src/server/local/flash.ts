// One-time messages for Settings that must not go in a URL (a widget token, say). In memory only,
// gone after 10 minutes or a restart.
type Key = "widgetToken" | "ollamaCheck";
const TTL_MS = 10 * 60_000;
const g = globalThis as unknown as { __dbFlash?: Map<Key, { value: string; at: number }> };

export function setFlash(key: Key, value: string | null, now = Date.now()): void {
  const m = (g.__dbFlash ??= new Map());
  if (value === null) m.delete(key);
  else m.set(key, { value, at: now });
}

export function getFlash(key: Key, now = Date.now()): string | null {
  const f = g.__dbFlash?.get(key);
  if (!f) return null;
  if (now - f.at > TTL_MS) { g.__dbFlash!.delete(key); return null; }
  return f.value;
}
