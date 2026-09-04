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
    return (await this.resolveOrRefuse()).total;
  }

  async readAll(): Promise<T[]> {
    const { shards } = await this.resolveOrRefuse();
    const out: T[] = [];
    for (let shard = 0; shard < shards; shard += 1) {
      out.push(...(await this.readShard(shard)));
    }
    return out;
  }

  /** Read the most recent `limit` items, newest first, without loading the rest. */
  async readRecent(limit: number): Promise<T[]> {
    // Refuses on a truncated list like every other read, and for a sharper
    // reason: what the probe could not reach is the *end* of the list, so the
    // items this would return are not the recent ones. Answering with the
    // oldest 50 under the heading "últimas importaciones" is worse than
    // failing.
    const { shards } = await this.resolveOrRefuse();
    const out: T[] = [];
    for (let shard = shards - 1; shard >= 0 && out.length < limit; shard -= 1) {
      const items = await this.readShard(shard);
      out.push(...items.slice().reverse());
    }
    return out.slice(0, limit);
  }

  async append(items: readonly T[]): Promise<void> {
    if (items.length === 0) return;

    const { shards } = await this.resolveOrRefuse();
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
    const { index, trusted } = await this.readIndexState();
    const probe = await this.probe(index.shards, trusted);
    const corruptShards: number[] = [];

    for (let shard = 0; shard < probe.shards; shard += 1) {
      const raw = await this.store.get(this.shardKey(shard));
      if (raw === null) continue;
      if (!Array.isArray(safeParse(raw))) corruptShards.push(shard);
    }

    return {
      shards: probe.shards,
      // Diagnosing is this method's job, so a shard it cannot read must not
      // stop it: the count is reported as far as it can be established.
      total:
        corruptShards.length > 0
          ? await this.countReadableItems(probe.shards)
          : await this.deriveTotal(probe.shards, index),
      recoveredShards: Math.max(0, probe.shards - index.shards),
      corruptShards,
      missingShards: probe.missing,
      truncated: probe.truncated,
      indexReadable: trusted,
    };
  }

  /**
   * Rebuild the index from what the store actually holds.
   *
   * The repair, and the only one this class offers: it writes the index and
   * never touches a shard. After an index is lost every read pays the full
   * scan until the next append happens to fix it; this makes that a one-off,
   * and makes it something a user can be shown and can choose, rather than a
   * side effect of opening a screen.
   *
   * A corrupt shard is reported and left exactly as it is. Repair that
   * destroys evidence is not repair.
   */
  async reindex(): Promise<ShardedListHealth> {
    const health = await this.inspect();
    if (health.truncated) return health;

    const last = health.shards === 0 ? [] : await this.readShardOrEmpty(health.shards - 1);
    await this.writeIndex(health.shards, last.length);
    return health;
  }

  /**
   * Delete every shard and the index.
   *
   * Index first, then shards from the top down. The old order — shards
   * ascending, index last — meant an interrupted clear left a *suffix* of
   * shards with nothing in front of them, which is the one shape a forward
   * probe cannot reach: the data was still on disk and permanently invisible.
   * Downward, whatever survives an interruption is a prefix, which is just a
   * shorter list.
   */
  async clear(): Promise<void> {
    const { shards } = await this.resolve();
    await this.store.delete(this.indexKey());
    for (let shard = shards - 1; shard >= 0; shard -= 1) {
      await this.store.delete(this.shardKey(shard));
    }
  }

  /**
   * The shard count the store really has, and the item count that implies.
   *
   * Refuses instead of answering when the probe could not establish where the
   * list ends. Every caller of this used the number as if it were the end of
   * the list; a floor dressed up as a total is how a read comes back short and
   * an append writes over what it never saw.
   */
  private async resolveOrRefuse(): Promise<{ shards: number; total: number }> {
    const { index, trusted } = await this.readIndexState();
    const probe = await this.probe(index.shards, trusted);
    if (probe.truncated) {
      throw new StorageError(
        `no se pudo determinar dónde termina ${this.prefix}: hay más de ${MAX_SHARD_PROBES} bloques encadenados. No se leerá ni se escribirá a ciegas; usa el diagnóstico de almacenamiento.`,
      );
    }
    return { shards: probe.shards, total: await this.deriveTotal(probe.shards, index) };
  }

  /** Like {@link resolveOrRefuse}, but reports truncation instead of refusing. */
  private async resolve(): Promise<{ shards: number; total: number; truncated: boolean }> {
    const { index, trusted } = await this.readIndexState();
    const probe = await this.probe(index.shards, trusted);
    return {
      shards: probe.shards,
      // A floor when truncated. Only `inspect` is allowed to see it.
      total: probe.truncated ? 0 : await this.deriveTotal(probe.shards, index),
      truncated: probe.truncated,
    };
  }

  /**
   * The stored index, and whether it was actually there to be read.
   *
   * `readJson` folds "absent" and "corrupt" into the same fallback, which is
   * right for a preference and wrong here: a missing index is the difference
   * between "the list ends where the index says" and "nothing knows where the
   * list ends", and the probe has to behave differently in each case.
   */
  private async readIndexState(): Promise<{ index: StoredIndex; trusted: boolean }> {
    const raw = await this.store.get(this.indexKey());
    if (raw === null) return { index: EMPTY_INDEX, trusted: false };
    const parsed = safeParse(raw);
    if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
      return { index: EMPTY_INDEX, trusted: false };
    }
    // No `v` means an index written before the field existed. Readable as is —
    // the shape has not changed, only gained a version to change it *by*.
    const index = parsed as StoredIndex;
    if (typeof index.shards !== 'number' || index.shards < 0) {
      return { index: EMPTY_INDEX, trusted: false };
    }
    return { index, trusted: true };
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
  private storedPerShard(stored: StoredIndex): number {
    return typeof stored.perShard === 'number' && stored.perShard > 0
      ? stored.perShard
      : this.itemsPerShard;
  }

  /** A shard's contents, or nothing when it cannot be read. For repair paths. */
  private async readShardOrEmpty(shard: number): Promise<T[]> {
    try {
      return await this.readShard(shard);
    } catch {
      return [];
    }
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
   * overwriting an orphan.
   *
   * Two things this has to answer that the first version could not.
   *
   * **Where it stopped, and why.** It returned a plain number whether it had
   * found the end or run out of budget, and the budget was 16 shards from the
   * index. That is fine for the case it was written for — an append
   * interrupted mid-flight leaves at most the shards that one call created —
   * but not for the case that actually loses data: an index that is *gone*.
   * Then the walk starts at zero, and with the history's 50 records per shard
   * everything past the 800th import was unreachable and unreported. The
   * budget is now large enough that reaching it means the store is answering
   * nonsense rather than that the user has been busy, and hitting it is
   * reported rather than rounded off to "the list ends here".
   *
   * **Holes.** A forward walk stops at the first absent shard. When the index
   * is there to confirm the count that is the end and nothing more needs
   * checking, which keeps the healthy path at a single read. When it is not,
   * an absent shard in the middle — an interrupted delete, a replica that
   * arrived out of order — would hide everything behind it, so the walk looks
   * a few shards past the gap before believing it.
   */
  private async probe(fromIndex: number, indexTrusted: boolean): Promise<ShardProbe> {
    const lookAhead = indexTrusted ? 0 : HOLE_LOOKAHEAD;
    const missing: number[] = [];
    let shards = Math.max(0, fromIndex);
    let reads = 0;

    while (reads < MAX_SHARD_PROBES) {
      reads += 1;
      if ((await this.store.get(this.shardKey(shards))) !== null) {
        shards += 1;
        continue;
      }

      let bridged = 0;
      for (let ahead = 1; ahead <= lookAhead && reads < MAX_SHARD_PROBES; ahead += 1) {
        reads += 1;
        if ((await this.store.get(this.shardKey(shards + ahead))) !== null) {
          bridged = ahead;
          break;
        }
      }
      if (bridged === 0) return { shards, missing, truncated: false };

      for (let gap = 0; gap < bridged; gap += 1) missing.push(shards + gap);
      shards += bridged + 1;
    }

    return { shards, missing, truncated: true };
  }

  /**
   * Every shard but the last is full by construction, so the total needs one
   * read rather than a full scan.
   */
  private async deriveTotal(shards: number, stored: StoredIndex): Promise<number> {
    if (shards === 0) return 0;
    const last = await this.readShard(shards - 1);
    return (shards - 1) * this.storedPerShard(stored) + last.length;
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

/** What a probe found, and whether it found the end. */
interface ShardProbe {
  /** One past the highest shard the probe reached. */
  shards: number;
  /** Shard positions that are absent with data behind them. */
  missing: number[];
  /** True when the probe ran out of budget without finding the end. */
  truncated: boolean;
}

const EMPTY_INDEX: StoredIndex = { shards: 0, total: 0 };

/**
 * Shards a single read will walk before it gives up and says so.
 *
 * Not a limit on how long a list may be — it is the point past which "the
 * store keeps answering" stops being a long history and starts being a broken
 * store. At the import history's 50 records per shard it is a little over two
 * hundred thousand imports, and the walk only runs that far at all when the
 * index is missing; with the index intact a read costs one probe.
 *
 * The budget is deliberately not a write-ahead marker in the index. Recording
 * the intended shard count *before* writing the shards would make an
 * interrupted append self-describing, but that is the case the single forward
 * probe already covers, and it would not survive the case that actually needs
 * covering — an index that is gone entirely. Two index writes per append to
 * cover nothing new is the point where this stops being a sharded list and
 * starts being a journal.
 */
export const MAX_SHARD_PROBES = 4096;

/**
 * Shards to look past an absent one before believing it is the end.
 *
 * Only paid when the index is unreadable, which is the only time the walk has
 * no second opinion about where the list stops.
 */
const HOLE_LOOKAHEAD = 4;

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
  /** Shard positions that are absent while later ones exist. */
  missingShards: number[];
  /**
   * The probe ran out of budget. `shards` and `total` are floors, not totals,
   * and every read and write refuses until this is resolved.
   */
  truncated: boolean;
  /** False when the index was absent or unparseable and had to be rebuilt. */
  indexReadable: boolean;
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
