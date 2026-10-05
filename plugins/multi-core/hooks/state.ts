/**
 * What the hooks keep across a hot reload of this module is `$.state` (declared in
 * `types/multi-core.d.ts`): read with `read($, atom)`, changed with `update($, atom, change)`.
 * Each hooks file names its atoms itself, since the engine's scan reads a state value's
 * plugin and key from the file that uses it. Never mutate a value read: copy it. A
 * `ui.render` hook that reads one is drawn again when it changes.
 */
const defaultLimit = 256;

/** A copy of `entries` with `key` newest, the oldest dropped past `limit`. */
export function withBounded<T>(
  entries: Readonly<Record<string, T>>,
  key: string,
  value: T,
  limit = defaultLimit,
): Record<string, T> {
  const { [key]: _replaced, ...others } = entries;
  const kept = Object.entries(others).slice(-(limit - 1));
  return Object.fromEntries([...kept, [key, value]]);
}

/** A copy of `items` with `item` newest and at most `limit` kept. */
export function withItem(items: readonly string[], item: string, limit = defaultLimit): string[] {
  return [...items.filter((held) => held !== item), item].slice(-limit);
}

/** Bounded like the other per-call records: the oldest entry makes room. */
export function rememberBounded<T>(
  entries: Map<string, T>,
  key: string,
  value: T,
  limit = defaultLimit,
) {
  entries.delete(key);
  const oldest = entries.keys().next();
  if (entries.size >= limit && !oldest.done) {
    entries.delete(oldest.value);
  }
  entries.set(key, value);
}

/** An object without its undefined fields, which the state's JSON data does not hold. */
export function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}
