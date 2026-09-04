import { describe, expect, it } from 'vitest';
import {
  readJson,
  ShardedList,
  StorageError,
  StorageKeys,
  writeJson,
  MAX_SHARD_PROBES,
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

/**
 * Un shard corrupto no es un shard vacío.
 *
 * `inspect()` ya lo decía en su propio comentario —«un `[]` para un valor que
 * no se pudo parsear es pérdida silenciosa de datos»— pero `readAll`,
 * `readRecent`, `deriveTotal` y `append` pasaban todos por `readShard`, que
 * hacía exactamente eso.
 *
 * La consecuencia no era sólo leer de menos: el siguiente `append` leía `[]`,
 * añadía encima y **reescribía** el shard, destruyendo la corrupción junto con
 * los 49 registros que la acompañaban. La avería era detectable —`inspect()` la
 * encontraba— y la siguiente importación borraba la evidencia.
 */
describe('daño en un shard', () => {
  async function threeRuns() {
    const store = memoryStore();
    const list = new ShardedList<{ n: number }>(store, 'wfcl.imports', 50);
    await list.append([{ n: 1 }, { n: 2 }, { n: 3 }]);
    return { store, list };
  }

  it('leer un shard ilegible falla en vez de devolver una lista vacía', async () => {
    const { store, list } = await threeRuns();
    store.data.set('wfcl.imports.s0', '[{"n":1},{"n"');

    await expect(list.readAll()).rejects.toThrow();
  });

  it('el conteo tampoco finge', async () => {
    const { store, list } = await threeRuns();
    store.data.set('wfcl.imports.s0', 'no es json');

    await expect(list.count()).rejects.toThrow();
  });

  it('y sobre todo, añadir no lo sobrescribe', async () => {
    const { store, list } = await threeRuns();
    store.data.set('wfcl.imports.s0', '[{"n":1},{"n"');

    await expect(list.append([{ n: 4 }])).rejects.toThrow();
    // La evidencia sigue ahí para que `inspect()` la pueda encontrar.
    expect(store.data.get('wfcl.imports.s0')).toBe('[{"n":1},{"n"');
  });

  it('inspect sigue funcionando, porque diagnosticar es su trabajo', async () => {
    const { store, list } = await threeRuns();
    store.data.set('wfcl.imports.s0', '[{"n":1},{"n"');

    const report = await list.inspect();
    expect(report.corruptShards).toEqual([0]);
  });
});

/**
 * El tamaño de shard con el que se escribió tiene que viajar con los datos.
 *
 * `deriveTotal` multiplica por `itemsPerShard` sin haberlo guardado nunca, así
 * que cambiar la constante hace que el conteo de una lista ya escrita salga
 * mal — 120 elementos escritos con 50 por shard se leen como 220 con 100.
 * `INDEX_VERSION` se escribía y no se leía en ninguna parte, así que la única
 * guarda que podía atrapar esto estaba inerte.
 */
describe('el índice recuerda con qué tamaño de shard se escribió', () => {
  it('una lista escrita con otro tamaño se lee con el suyo, no con el actual', async () => {
    const store = memoryStore();
    const written = new ShardedList<{ n: number }>(store, 'wfcl.runs', 50);
    await written.append(Array.from({ length: 120 }, (_, n) => ({ n })));

    const readBack = new ShardedList<{ n: number }>(store, 'wfcl.runs', 100);

    expect(await readBack.count()).toBe(120);
    expect(await readBack.readAll()).toHaveLength(120);
  });
});

/**
 * Hasta dónde mira una lectura, y qué pasa cuando deja de mirar.
 *
 * `probeShardCount` avanzaba como máximo 16 shards desde donde el índice
 * decía que la lista terminaba, y devolvía **el mismo tipo de valor** tanto si
 * había encontrado el final de verdad como si se había quedado sin
 * presupuesto. Nadie aguas arriba podía distinguir «la lista termina aquí» de
 * «dejé de mirar aquí».
 *
 * El escenario que lo dispara no es tener muchas importaciones: es perder el
 * índice teniéndolas. Con `ImportHistory` a 50 registros por shard, 16 shards
 * son 800 importaciones, y a partir de ahí `readAll` leía corto, `count`
 * mentía y el siguiente `append` escribía encima de lo que no había visto.
 */
describe('límite de sondeo y truncamiento', () => {
  interface Item {
    n: number;
  }

  /** Escribe shards directamente, sin índice: el estado tras perderlo. */
  async function shardsWithoutIndex(count: number) {
    const store = memoryStore();
    for (let shard = 0; shard < count; shard += 1) {
      store.data.set(`wfcl.test.s${shard}`, JSON.stringify([{ n: shard }]));
    }
    return { store, list: new ShardedList<Item>(store, 'wfcl.test', 1) };
  }

  it('recupera muy por encima de los 16 shards que alcanzaba antes', async () => {
    const { list } = await shardsWithoutIndex(120);

    expect(await list.count()).toBe(120);
    expect(await list.readAll()).toHaveLength(120);
  });

  it('cuando se queda sin presupuesto lo dice, en vez de fingir un final', async () => {
    const { list } = await shardsWithoutIndex(MAX_SHARD_PROBES + 2);

    const health = await list.inspect();
    expect(health.truncated).toBe(true);
  });

  it('una lista sana no está truncada', async () => {
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);
    await list.append([{ n: 1 }, { n: 2 }, { n: 3 }]);

    expect((await list.inspect()).truncated).toBe(false);
  });

  it('leer no devuelve una lista corta en silencio', async () => {
    const { list } = await shardsWithoutIndex(MAX_SHARD_PROBES + 2);

    await expect(list.readAll()).rejects.toBeInstanceOf(StorageError);
    await expect(list.count()).rejects.toBeInstanceOf(StorageError);
  });

  it('los «más recientes» tampoco, porque lo no visto es justo lo más reciente', async () => {
    const { list } = await shardsWithoutIndex(MAX_SHARD_PROBES + 2);

    await expect(list.readRecent(5)).rejects.toBeInstanceOf(StorageError);
  });

  it('y sobre todo, no se escribe donde no se sabe qué hay', async () => {
    const { store, list } = await shardsWithoutIndex(MAX_SHARD_PROBES + 2);
    const before = store.data.get(`wfcl.test.s${MAX_SHARD_PROBES}`);

    await expect(list.append([{ n: 999 }])).rejects.toBeInstanceOf(StorageError);
    expect(store.data.get(`wfcl.test.s${MAX_SHARD_PROBES}`)).toBe(before);
  });
});

/**
 * Un hueco no es un final.
 *
 * Sin índice, el sondeo se detiene en el primer shard ausente. Si ese hueco
 * está en medio —un borrado interrumpido, una réplica entre dispositivos que
 * llegó desordenada— todo lo que hay detrás desaparece sin que nada falle.
 * Mirar unos pocos shards más allá del hueco cuesta cuatro lecturas y sólo se
 * paga cuando el índice ya no está para decir dónde termina la lista.
 */
describe('huecos entre shards', () => {
  interface Item {
    n: number;
  }

  it('sin índice, un hueco no esconde lo que hay detrás', async () => {
    const store = memoryStore();
    for (const shard of [0, 1, 3, 4]) {
      store.data.set(`wfcl.test.s${shard}`, JSON.stringify([{ n: shard }]));
    }
    const list = new ShardedList<Item>(store, 'wfcl.test', 1);

    expect((await list.readAll()).map((i) => i.n)).toEqual([0, 1, 3, 4]);
    expect((await list.inspect()).missingShards).toEqual([2]);
  });

  it('una lista sana no paga esas lecturas de más', async () => {
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);
    await list.append([{ n: 1 }, { n: 2 }]);

    store.reads = 0;
    await list.count();
    // Un sondeo (el shard siguiente al que el índice declara) y la lectura del
    // último shard para el total. Nada más.
    expect(store.reads).toBeLessThanOrEqual(3);
  });
});

/**
 * Vaciar la lista tiene que dejarla coherente aunque se interrumpa.
 *
 * `clear()` borraba de abajo hacia arriba y el índice al final. Interrumpirlo
 * dejaba un **sufijo** de shards —`s5`, `s6`— sin nada delante: exactamente la
 * forma que el sondeo no puede recorrer. Borrar de arriba hacia abajo, y el
 * índice primero, deja siempre un prefijo, que es una lista más corta y nada
 * más.
 */
describe('vaciado interrumpido', () => {
  interface Item {
    n: number;
  }

  it('lo que queda es un prefijo, no un sufijo huérfano', async () => {
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 1);
    await list.append([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);

    // Índice, `s4`, `s3`: tres borrados y la interrupción antes de `s2`.
    const failAfter = 3;
    let deletes = 0;
    const original = store.delete.bind(store);
    store.delete = async (key: string) => {
      deletes += 1;
      if (deletes > failAfter) throw new Error('sincronización interrumpida');
      await original(key);
    };

    await expect(list.clear()).rejects.toThrow();
    store.delete = original;

    const remaining = [...store.data.keys()]
      .filter((key) => key.startsWith('wfcl.test.s'))
      .map((key) => Number(key.slice('wfcl.test.s'.length)))
      .sort((a, b) => a - b);

    expect(remaining).toEqual([0, 1, 2]);
    expect((await list.readAll()).map((i) => i.n)).toEqual([0, 1, 2]);
  });
});

/**
 * Reparar es reconstruir el índice, no tocar los datos.
 *
 * Tras perder el índice, cada lectura vuelve a recorrer la lista entera hasta
 * que una escritura lo deje bien. `reindex()` lo deja bien de una vez y
 * devuelve lo que encontró, para que la reparación pueda ser algo que el
 * usuario ve y decide, no un efecto colateral de leer.
 */
describe('reindex', () => {
  interface Item {
    n: number;
  }

  it('reconstruye el índice y la siguiente lectura ya no recorre nada', async () => {
    const store = memoryStore();
    for (let shard = 0; shard < 30; shard += 1) {
      store.data.set(`wfcl.test.s${shard}`, JSON.stringify([{ n: shard }]));
    }
    const list = new ShardedList<Item>(store, 'wfcl.test', 1);

    const health = await list.reindex();
    expect(health.shards).toBe(30);
    expect(health.total).toBe(30);
    expect(health.recoveredShards).toBe(30);

    store.reads = 0;
    expect(await list.count()).toBe(30);
    expect(store.reads).toBeLessThanOrEqual(3);
  });

  it('no destruye un shard ilegible al reparar', async () => {
    const store = memoryStore();
    const list = new ShardedList<Item>(store, 'wfcl.test', 2);
    await list.append([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    store.data.set('wfcl.test.s0', '[{"n":1},{"n"');

    const health = await list.reindex();

    expect(health.corruptShards).toEqual([0]);
    expect(store.data.get('wfcl.test.s0')).toBe('[{"n":1},{"n"');
  });
});
