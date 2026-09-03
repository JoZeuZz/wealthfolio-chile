import { describe, expect, it } from 'vitest';
import {
  readJson,
  ShardedList,
  StorageError,
  StorageKeys,
  writeJson,
} from '../src/services/storage';
import { ImportHistory, newRunId, type ImportRun } from '../src/services/import-history';
import { memoryStore } from './host';

/**
 * Addon storage.
 *
 * `ctx.api.storage` caps each value at roughly 250 KB because it replicates
 * across a user's devices, so anything that grows with use has to be sharded.
 * These tests pin both halves: the cap is enforced, and the sharded list stays
 * correct across the boundaries.
 */

describe('readJson / writeJson', () => {
  it('round-trips a value', async () => {
    const store = memoryStore();
    await writeJson(store, 'k', { a: 1, b: ['x'] });
    expect(await readJson(store, 'k', {})).toEqual({ a: 1, b: ['x'] });
  });

  it('returns the fallback for a key that was never written', async () => {
    const store = memoryStore();
    expect(await readJson(store, 'missing', { fallback: true })).toEqual({ fallback: true });
  });

  it('treats corrupt JSON as absent rather than throwing', async () => {
    const store = memoryStore();
    store.data.set('k', '{not json');
    expect(await readJson(store, 'k', { safe: true })).toEqual({ safe: true });
  });

  it('refuses to write a value over the per-item limit', async () => {
    const store = memoryStore();
    const oversized = { blob: 'x'.repeat(250_000) };

    await expect(writeJson(store, 'big', oversized)).rejects.toBeInstanceOf(StorageError);
    expect(store.data.has('big')).toBe(false);
  });

  it('measures the limit in bytes, not characters', async () => {
    const store = memoryStore();
    // Each 'ñ' is two UTF-8 bytes, so 120.000 of them exceed the 200.000-byte cap.
    await expect(writeJson(store, 'utf8', { text: 'ñ'.repeat(120_000) })).rejects.toBeInstanceOf(
      StorageError,
    );
  });
});

describe('ShardedList', () => {
  const item = (n: number) => ({ n, label: `item-${n}` });

  it('starts empty', async () => {
    const list = new ShardedList<{ n: number }>(memoryStore(), 'test', 10);
    expect(await list.count()).toBe(0);
    expect(await list.readAll()).toEqual([]);
    expect(await list.readRecent(5)).toEqual([]);
  });

  it('appends and reads back in insertion order', async () => {
    const list = new ShardedList<{ n: number }>(memoryStore(), 'test', 10);
    await list.append([item(1), item(2), item(3)]);

    expect(await list.count()).toBe(3);
    expect((await list.readAll()).map((i) => i.n)).toEqual([1, 2, 3]);
  });

  it('ignores an empty append', async () => {
    const store = memoryStore();
    const list = new ShardedList<{ n: number }>(store, 'test', 10);
    await list.append([]);
    expect(store.data.size).toBe(0);
  });

  it('spills into more shards as it grows', async () => {
    const store = memoryStore();
    const list = new ShardedList<{ n: number }>(store, 'test', 10);
    await list.append(Array.from({ length: 25 }, (_, i) => item(i)));

    expect(await list.count()).toBe(25);
    expect(store.data.has('test.s0')).toBe(true);
    expect(store.data.has('test.s1')).toBe(true);
    expect(store.data.has('test.s2')).toBe(true);
    expect((await list.readAll()).map((i) => i.n)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('keeps order across many separate appends', async () => {
    const list = new ShardedList<{ n: number }>(memoryStore(), 'test', 3);
    for (let i = 0; i < 10; i += 1) await list.append([item(i)]);

    expect((await list.readAll()).map((i) => i.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await list.count()).toBe(10);
  });

  it('reads the newest items first without loading every shard', async () => {
    const store = memoryStore();
    const list = new ShardedList<{ n: number }>(store, 'test', 10);
    await list.append(Array.from({ length: 100 }, (_, i) => item(i)));

    const recent = await list.readRecent(5);
    expect(recent.map((i) => i.n)).toEqual([99, 98, 97, 96, 95]);
  });

  it('returns everything when asked for more than it holds', async () => {
    const list = new ShardedList<{ n: number }>(memoryStore(), 'test', 10);
    await list.append([item(1), item(2)]);
    expect((await list.readRecent(50)).map((i) => i.n)).toEqual([2, 1]);
  });

  it('clears every shard and its index', async () => {
    const store = memoryStore();
    const list = new ShardedList<{ n: number }>(store, 'test', 5);
    await list.append(Array.from({ length: 12 }, (_, i) => item(i)));

    await list.clear();

    expect(store.data.size).toBe(0);
    expect(await list.count()).toBe(0);
    expect(await list.readAll()).toEqual([]);
  });

  it('refuses to write a shard that outgrew the per-value limit', async () => {
    const list = new ShardedList<{ n: number }>(memoryStore(), 'test', 200);
    const fat = Array.from({ length: 200 }, (_, i) => ({ n: i, blob: 'x'.repeat(2_000) }));

    await expect(list.append(fat)).rejects.toBeInstanceOf(StorageError);
  });
});

describe('import history at volume', () => {
  function run(index: number): ImportRun {
    return {
      id: newRunId(new Date(2026, 0, 1 + (index % 300))),
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
      fileName: `cartola-${index}.csv`,
      fileHash: `hash-${index}`,
      institution: 'banco-chile',
      parser: 'banco-chile.cartola-csv',
      parserVersion: '1.0.0',
      profileStatus: 'pending-real-sample',
      accountId: 'acc-1',
      accountName: 'Cuenta corriente',
      currency: 'CLP',
      detectedRows: 120,
      selectedRows: 118,
      importedRows: 118,
      failedRows: 0,
      exactDuplicates: 2,
      probableDuplicates: 0,
      ignoredRows: 0,
      deselectedRows: 0,
      errorRows: 0,
      status: 'completed',
    };
  }

  it('stores thousands of runs without exceeding the per-value limit', async () => {
    // The real host rejects an oversized value; the fake does too, so a shard
    // that grew past the cap fails the test instead of passing quietly.
    const store = memoryStore({ maxValueBytes: 250_000 });
    const history = new ImportHistory(store);

    for (let i = 0; i < 2000; i += 1) {
      await history.record(run(i));
    }

    const all = await history.all();
    expect(all).toHaveLength(2000);
    expect(all[0]?.fileName).toBe('cartola-0.csv');
    expect(all[1999]?.fileName).toBe('cartola-1999.csv');

    const recent = await history.recent(10);
    expect(recent[0]?.fileName).toBe('cartola-1999.csv');

    for (const [key, value] of store.data) {
      expect(new TextEncoder().encode(value).length, `${key} is too large`).toBeLessThanOrEqual(
        250_000,
      );
    }
  });

  it('finds a previous run by file hash and account', async () => {
    const history = new ImportHistory(memoryStore());
    await history.record(run(1));
    await history.record(run(2));

    expect((await history.findByFileHash('hash-2', 'acc-1'))?.fileName).toBe('cartola-2.csv');
    expect(await history.findByFileHash('hash-2', 'other-account')).toBeUndefined();
    expect(await history.findByFileHash('nope', 'acc-1')).toBeUndefined();
  });

  it('uses its own storage key', () => {
    expect(StorageKeys.importHistory).toBe('wfcl.imports');
  });
});

/**
 * Qué pasa cuando una escritura se corta a la mitad.
 *
 * `ShardedList` escribe los shards primero y el índice al final, así que la
 * ventana peligrosa es exactamente esa: los datos están en el store y el índice
 * todavía no lo sabe. Sin reparación, el siguiente `append` lee el índice viejo
 * y **sobrescribe** el shard huérfano: la escritura anterior desaparece sin que
 * nada falle.
 */
describe('índice y shards desincronizados', () => {
  interface Item {
    n: number;
  }

  const items = (from: number, count: number): Item[] =>
    Array.from({ length: count }, (_, i) => ({ n: from + i }));

  it('recupera un shard que el índice no conoce', async () => {
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);

    await list.append(items(1, 4)); // shards 0 y 1
    // Simula un corte justo antes de escribir el índice.
    await store.set('wfcl.test.index', JSON.stringify({ shards: 1, total: 2 }));

    expect(await list.readAll()).toEqual(items(1, 4));
    expect(await list.count()).toBe(4);
  });

  it('no pisa el shard huérfano en el siguiente append', async () => {
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);

    await list.append(items(1, 4));
    await store.set('wfcl.test.index', JSON.stringify({ shards: 1, total: 2 }));

    await list.append(items(5, 1));

    expect(await list.readAll()).toEqual(items(1, 5));
  });

  it('deriva el total de los shards en vez de creerle al índice', async () => {
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);

    await list.append(items(1, 3));
    await store.set('wfcl.test.index', JSON.stringify({ shards: 2, total: 99 }));

    expect(await list.count()).toBe(3);
  });

  it('informa de un shard ilegible en vez de tratarlo como vacío', async () => {
    // Un shard corrupto que se lee como `[]` es pérdida de datos silenciosa.
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);

    await list.append(items(1, 4));
    await store.set('wfcl.test.s0', '{ esto no es json');

    const health = await list.inspect();
    expect(health.corruptShards).toEqual([0]);
    expect(health.shards).toBe(2);
  });

  it('escribe una versión de esquema en el índice', async () => {
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);
    await list.append(items(1, 1));

    const index = JSON.parse((await store.get('wfcl.test.index')) as string) as { v?: number };
    expect(index.v).toBe(1);
  });

  it('sigue leyendo un índice escrito antes de que existiera la versión', async () => {
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);

    await store.set('wfcl.test.s0', JSON.stringify(items(1, 2)));
    await store.set('wfcl.test.index', JSON.stringify({ shards: 1, total: 2 }));

    expect(await list.readAll()).toEqual(items(1, 2));
  });
});

/**
 * Daño parcial.
 *
 * Ninguno de estos casos debería costar todo el historial. La lista es
 * auxiliar: si se pierde una parte, lo que hay que conservar es el resto y la
 * capacidad de seguir escribiendo.
 */
describe('storage dañado', () => {
  interface Item {
    n: number;
  }
  const items = (from: number, count: number): Item[] =>
    Array.from({ length: count }, (_, i) => ({ n: from + i }));

  it('un índice ilegible se reconstruye desde los shards', () => {
    // Sin reconstrucción, un índice corrupto se lee como «cero shards» y todo
    // el historial desaparece de la vista, aunque siga escrito.
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);

    return (async () => {
      await list.append(items(1, 4));
      await store.set('wfcl.test.index', 'no soy json');

      expect(await list.readAll()).toEqual(items(1, 4));
      expect(await list.count()).toBe(4);
    })();
  });

  it('un shard perdido en medio no se lleva a los demás', async () => {
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);

    await list.append(items(1, 6)); // shards 0, 1, 2
    await store.delete('wfcl.test.s1');

    // El shard 1 desaparece; los otros dos siguen ahí y se leen.
    expect(await list.readAll()).toEqual([...items(1, 2), ...items(5, 2)]);
  });

  it('un shard con JSON válido pero que no es una lista se reporta', async () => {
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);

    await list.append(items(1, 4));
    await store.set('wfcl.test.s1', '{"no":"es una lista"}');

    const health = await list.inspect();
    expect(health.corruptShards).toEqual([1]);
  });

  it('se puede seguir escribiendo después de un daño parcial', async () => {
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);

    await list.append(items(1, 4));
    await store.set('wfcl.test.index', 'no soy json');
    await list.append(items(5, 1));

    expect(await list.readAll()).toEqual(items(1, 5));
  });
});
