import type { AddonContext } from '@wealthfolio/addon-sdk';

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

/** The subset of the addon context this layer needs. Keeps tests trivial. */
export function storeFrom(ctx: AddonContext): KeyValueStore {
  return ctx.api.storage;
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
 * Used for the import history and the fingerprint ledger, both of which grow
 * with use. Each shard stays under the per-value limit and the index records
 * how many shards exist, so reads never have to probe.
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

  async count(): Promise<number> {
    const index = await readJson(this.store, this.indexKey(), { shards: 0, total: 0 });
    return index.total;
  }

  async readAll(): Promise<T[]> {
    const index = await readJson(this.store, this.indexKey(), { shards: 0, total: 0 });
    const out: T[] = [];
    for (let shard = 0; shard < index.shards; shard += 1) {
      out.push(...(await readJson<T[]>(this.store, this.shardKey(shard), [])));
    }
    return out;
  }

  /** Read the most recent `limit` items, newest first, without loading the rest. */
  async readRecent(limit: number): Promise<T[]> {
    const index = await readJson(this.store, this.indexKey(), { shards: 0, total: 0 });
    const out: T[] = [];
    for (let shard = index.shards - 1; shard >= 0 && out.length < limit; shard -= 1) {
      const items = await readJson<T[]>(this.store, this.shardKey(shard), []);
      out.push(...items.slice().reverse());
    }
    return out.slice(0, limit);
  }

  async append(items: readonly T[]): Promise<void> {
    if (items.length === 0) return;

    const index = await readJson(this.store, this.indexKey(), { shards: 0, total: 0 });
    let shard = Math.max(0, index.shards - 1);
    let current = index.shards === 0 ? [] : await readJson<T[]>(this.store, this.shardKey(shard), []);

    for (const item of items) {
      if (current.length >= this.itemsPerShard) {
        await writeJson(this.store, this.shardKey(shard), current);
        shard += 1;
        current = [];
      }
      current.push(item);
    }

    await writeJson(this.store, this.shardKey(shard), current);
    await writeJson(this.store, this.indexKey(), {
      shards: shard + 1,
      total: index.total + items.length,
    });
  }

  async clear(): Promise<void> {
    const index = await readJson(this.store, this.indexKey(), { shards: 0, total: 0 });
    for (let shard = 0; shard < index.shards; shard += 1) {
      await this.store.delete(this.shardKey(shard));
    }
    await this.store.delete(this.indexKey());
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Storage keys used by the addon. Centralised so nothing collides. */
export const StorageKeys = {
  settings: 'wfcl.settings',
  rules: 'wfcl.rules',
  categories: 'wfcl.categories',
  importHistory: 'wfcl.imports',
  transferDecisions: 'wfcl.transfers',
} as const;
