/**
 * Copy-on-write map. `fork()` shares the parent chain and writes only to a
 * new overlay so a token delta does not clone every historical entry.
 * Chains flatten after `COW_MAP_MAX_DEPTH` forks so lookups stay bounded.
 */
export const COW_MAP_MAX_DEPTH = 24;

export class CowMap<V> implements Iterable<[string, V]> {
  private constructor(
    private readonly parent: CowMap<V> | null,
    private readonly overlay: Map<string, V>,
    readonly depth: number,
  ) {}

  static empty<V>(): CowMap<V> {
    return new CowMap<V>(null, new Map(), 0);
  }

  static from<V>(entries: Iterable<readonly [string, V]>): CowMap<V> {
    return new CowMap<V>(null, new Map(entries), 0);
  }

  get(id: string): V | undefined {
    if (this.overlay.has(id)) return this.overlay.get(id);
    return this.parent?.get(id);
  }

  has(id: string): boolean {
    if (this.overlay.has(id)) return true;
    return this.parent?.has(id) ?? false;
  }

  set(id: string, value: V): this {
    this.overlay.set(id, value);
    return this;
  }

  /** Snapshot-private child. Parent overlays stay frozen. */
  fork(): CowMap<V> {
    if (this.depth >= COW_MAP_MAX_DEPTH) return this.compact().fork();
    return new CowMap<V>(this, new Map(), this.depth + 1);
  }

  compact(): CowMap<V> {
    if (!this.parent) return this;
    const overlay = new Map<string, V>();
    this.collect(overlay);
    return new CowMap<V>(null, overlay, 0);
  }

  get size(): number {
    if (!this.parent) return this.overlay.size;
    return [...this.entries()].length;
  }

  *entries(): IterableIterator<[string, V]> {
    const seen = new Set<string>();
    yield* this.walk(seen);
  }

  *values(): IterableIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  *keys(): IterableIterator<string> {
    for (const [id] of this.entries()) yield id;
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries();
  }

  private *walk(seen: Set<string>): IterableIterator<[string, V]> {
    for (const [id, value] of this.overlay) {
      if (seen.has(id)) continue;
      seen.add(id);
      yield [id, value];
    }
    if (this.parent) yield* this.parent.walk(seen);
  }

  private collect(into: Map<string, V>): void {
    this.parent?.collect(into);
    for (const [id, value] of this.overlay) into.set(id, value);
  }
}
