/**
 * Typed persistence over the host's key/value store.
 *
 * `ctx.api.storage` is a baseline capability (no permission needed) and the
 * only durable storage an addon gets — `localStorage` throws inside the
 * sandboxed iframe. Values are capped at roughly 250 KB each because storage
 * replicates across a user's paired devices, so anything that grows without
 * bound has to be written in shards rather than as one blob.
 */

/** Conservative ceiling; the host's own limit is a little higher. */
const MAX_VALUE_BYTES = 200_000;

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Read and parse a JSON value, falling back when absent or corrupt. */
export async function readJson<T>(
  store: KeyValueStore,
  key: string,
  fallback: T,
): Promise<T> {
  const raw = await store.get(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt value is treated as absent rather than fatal: losing a
    // preference is recoverable, refusing to open the addon is not.
    return fallback;
  }
}

export async function writeJson(
  store: KeyValueStore,
  key: string,
  value: unknown,
): Promise<void> {
  const raw = JSON.stringify(value);
  if (byteLength(raw) > MAX_VALUE_BYTES) {
    throw new StorageError(
      `El valor de "${key}" supera el límite de almacenamiento del addon. Usa una lista particionada.`,
    );
  }
  await store.set(key, raw);
}

/**
 * An append-only list stored across as many shards as it needs.
 *
 * Used for the import history, which grows with use. Each shard stays under the
 * per-value limit and an index records how many exist, so reads never have to
 * probe blindly.
 *
 * Writes go shards-first, index-last, which leaves exactly one dangerous
 * window: the data is in the store and the index does not know it yet. Without
 * repair the next append reads the stale index and *overwrites* the orphan —
 * the earlier write disappears and nothing fails. So the index is treated as a
 * hint that can be behind, never as the truth: every read probes one shard past
 * where the index says the list ends, and the total is derived from the shards
 * rather than believed.
 *
 * That is as far as this goes. There is no locking and none is needed: an addon
 * runs in one sandbox, and two concurrent appends from one page are not a
 * scenario. What is a scenario is a write interrupted by a reload, a crash, or
 * a device sync, and that is what the repair covers.
 */
export class ShardedList<T> {
  constructor(
    private readonly store: KeyValueStore,
    private readonly prefix: string,
    private readonly itemsPerShard = 200,
  ) {}

  private indexKey(): string {
    return `${this.prefix}.index`;
  }

  private shardKey(shard: number): string {
    return `${this.prefix}.s${shard}`;
  }

  /** Items in the list, counted from the shards themselves. */
  async count(): Promise<number> {
    return (await this.resolve()).total;
  }

  async readAll(): Promise<T[]> {
    const { shards } = await this.resolve();
    const out: T[] = [];
    for (let shard = 0; shard < shards; shard += 1) {
      out.push(...(await this.readShard(shard)));
    }
    return out;
  }

  /** Read the most recent `limit` items, newest first, without loading the rest. */
  async readRecent(limit: number): Promise<T[]> {
    const { shards } = await this.resolve();
    const out: T[] = [];
    for (let shard = shards - 1; shard >= 0 && out.length < limit; shard -= 1) {
      const items = await this.readShard(shard);
      out.push(...items.slice().reverse());
    }
    return out.slice(0, limit);
  }

  async append(items: readonly T[]): Promise<void> {
    if (items.length === 0) return;

    const { shards } = await this.resolve();
    let shard = Math.max(0, shards - 1);
    let current = shards === 0 ? [] : await this.readShard(shard);

    for (const item of items) {
      if (current.length >= this.itemsPerShard) {
        await writeJson(this.store, this.shardKey(shard), current);
        shard += 1;
        current = [];
      }
      current.push(item);
    }

    await writeJson(this.store, this.shardKey(shard), current);
    await this.writeIndex(shard + 1, current.length);
  }

  /**
   * What the store actually holds, including what the index got wrong.
   *
   * For diagnostics and for tests. A corrupt shard is reported rather than read
   * as an empty one: `[]` for a value that failed to parse is silent data loss,
   * and the whole point of the history is that the user can trust it.
   */
  async inspect(): Promise<ShardedListHealth> {
    const stored = await this.readIndex();
    const shards = await this.probeShardCount(stored.shards);
    const corruptShards: number[] = [];

    for (let shard = 0; shard < shards; shard += 1) {
      const raw = await this.store.get(this.shardKey(shard));
      if (raw === null) continue;
      if (!Array.isArray(safeParse(raw))) corruptShards.push(shard);
    }

    return {
      shards,
      // Diagnosing is this method's job, so a shard it cannot read must not
      // stop it: the count is reported as far as it can be established.
      total: corruptShards.length > 0 ? await this.countReadableItems(shards) : await this.deriveTotal(shards),
      recoveredShards: Math.max(0, shards - stored.shards),
      corruptShards,
    };
  }

  async clear(): Promise<void> {
    const { shards } = await this.resolve();
    for (let shard = 0; shard < shards; shard += 1) {
      await this.store.delete(this.shardKey(shard));
    }
    await this.store.delete(this.indexKey());
  }

  /** The shard count the store really has, and the item count that implies. */
  private async resolve(): Promise<{ shards: number; total: number }> {
    const stored = await this.readIndex();
    const shards = await this.probeShardCount(stored.shards);
    return { shards, total: await this.deriveTotal(shards) };
  }

  private async readIndex(): Promise<StoredIndex> {
    // No `v` means an index written before the field existed. Readable as is —
    // the shape has not changed, only gained a version to change it *by*.
    return readJson<StoredIndex>(this.store, this.indexKey(), { shards: 0, total: 0 });
  }

  private async writeIndex(shards: number, lastShardLength: number): Promise<void> {
    await writeJson(this.store, this.indexKey(), {
      v: INDEX_VERSION,
      shards,
      // Recorded because `deriveTotal` multiplies by it. Without it, changing
      // the constant silently rewrites the count of every list already on disk:
      // 120 items written at 50 per shard read back as 220 at 100. Nothing
      // changes the value today; this is the trap laid for whoever tunes it.
      perShard: this.itemsPerShard,
      total: (shards - 1) * this.itemsPerShard + lastShardLength,
    } satisfies StoredIndex);
  }

  /** The shard size this list was written with, not the one it was constructed with. */
  private async storedPerShard(): Promise<number> {
    const stored = await this.readIndex();
    return typeof stored.perShard === 'number' && stored.perShard > 0
      ? stored.perShard
      : this.itemsPerShard;
  }

  /** Items across every shard that can actually be read. */
  private async countReadableItems(shards: number): Promise<number> {
    let total = 0;
    for (let shard = 0; shard < shards; shard += 1) {
      try {
        total += (await this.readShard(shard)).length;
      } catch {
        // Counted by `corruptShards` instead.
      }
    }
    return total;
  }

  /**
   * Walk forward from where the index says the list ends.
   *
   * One extra read on a healthy list, which is the price of never silently
   * overwriting an orphan. The cap bounds the damage if the store starts
   * answering nonsense; beyond it the list is broken in a way probing cannot
   * fix.
   */
  private async probeShardCount(fromIndex: number): Promise<number> {
    let shards = Math.max(0, fromIndex);
    for (let probe = 0; probe < MAX_ORPHAN_PROBES; probe += 1) {
      if ((await this.store.get(this.shardKey(shards))) === null) return shards;
      shards += 1;
    }
    return shards;
  }

  /**
   * Every shard but the last is full by construction, so the total needs one
   * read rather than a full scan.
   */
  private async deriveTotal(shards: number): Promise<number> {
    if (shards === 0) return 0;
    const last = await this.readShard(shards - 1);
    return (shards - 1) * (await this.storedPerShard()) + last.length;
  }

  /**
   * A shard's contents, or an error.
   *
   * Deliberately not `readJson(..., [])`. `inspect()` already says why in its
   * own comment — "a corrupt shard is reported rather than read as an empty
   * one: `[]` for a value that failed to parse is silent data loss" — but every
   * other reader went through here and did exactly that. The damage was not
   * only reading short: the next `append` read `[]`, appended to it and wrote
   * the shard back, destroying the corruption together with the 49 records
   * beside it. The fault was detectable and the next import erased the
   * evidence.
   *
   * An *absent* shard is still an empty one. That is the ordinary interrupted
   * append, and `probeShardCount` exists to handle it.
   */
  private async readShard(shard: number): Promise<T[]> {
    const key = this.shardKey(shard);
    const raw = await this.store.get(key);
    if (raw === null) return [];
    const parsed = safeParse(raw);
    if (!Array.isArray(parsed)) {
      throw new StorageError(
        `el bloque ${shard} de ${this.prefix} no se puede leer; no se tocará para no perder lo que queda en él`,
      );
    }
    return parsed as T[];
  }
}

/** Schema version of the shard index. Bump when its shape changes. */
const INDEX_VERSION = 1;

/**
 * How far past the index a read will look for orphaned shards.
 *
 * An interrupted append leaves at most the shards that one call created, and no
 * single call writes anywhere near this many.
 */
const MAX_ORPHAN_PROBES = 16;

interface StoredIndex {
  /** Absent on indexes written before the field existed. */
  v?: number;
  shards: number;
  /**
   * Items per shard at the time of writing.
   *
   * Absent on indexes written before this field existed, in which case the
   * reader's own value is the only answer available — which is what the
   * constructor default was silently assuming for every list.
   */
  perShard?: number;
  /** Kept for older readers. Never trusted — see `deriveTotal`. */
  total: number;
}

export interface ShardedListHealth {
  shards: number;
  total: number;
  /** Shards the index did not know about, found by probing. */
  recoveredShards: number;
  /** Shards that exist but could not be parsed. */
  corruptShards: number[];
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Storage keys used by the addon. Centralised so nothing collides.
 *
 * Only keys something reads or writes. `wfcl.categories` and `wfcl.transfers`
 * used to be reserved here for a category editor and for persisted
 * reconciliation decisions; neither exists, and a reserved key is a promise the
 * code does not keep. They come back when the feature does — with a schema
 * version, which these never had.
 */
export const StorageKeys = {
  settings: 'wfcl.settings',
  rules: 'wfcl.rules',
  importHistory: 'wfcl.imports',
} as const;
