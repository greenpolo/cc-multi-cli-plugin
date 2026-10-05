// Capacity-bounded Map and Set writes. A Map iterates in insertion order, so the first key
// is the oldest. Callers choose the recency rule explicitly; none of these refuses a write.

/**
 * `lru`: a write makes the key the newest, and the least recently written entry makes room.
 * `insertion`: only a new key can evict, and an existing key keeps its place in the order.
 */
export type EvictionOrder = 'lru' | 'insertion';

function evictOldest<K, V>(map: Map<K, V>, capacity: number) {
  while (map.size >= capacity) {
    const oldest = map.keys().next();
    if (oldest.done) {
      return;
    }
    map.delete(oldest.value);
  }
}

/** Stores `value` and keeps the map at or below `capacity` entries. */
export function setBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  capacity: number,
  order: EvictionOrder,
): void {
  if (order === 'lru') {
    map.delete(key);
  }
  if (!map.has(key)) {
    evictOldest(map, capacity);
  }
  map.set(key, value);
}

/** Adds `key`, evicting the oldest members once the set exceeds `capacity`. */
export function addBounded<K>(set: Set<K>, key: K, capacity: number): void {
  set.add(key);
  while (set.size > capacity) {
    const oldest = set.values().next();
    if (oldest.done) {
      return;
    }
    set.delete(oldest.value);
  }
}
