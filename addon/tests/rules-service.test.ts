import { describe, expect, it } from 'vitest';
import {
  actionRisk,
  EDITABLE_ACTIONS,
  EDITABLE_FIELDS,
  loadUserRules,
  previewRuleImpact,
  newRuleId,
  RULES_SCHEMA_VERSION,
  saveUserRules,
  validateUserRule,
} from '../src/services/rules';
import { loadEffectiveRules } from '../src/services/settings';
import { StorageKeys } from '../src/services/storage';
import { defaultRules } from '../src/core/rules/builtin';
import { TransactionKind } from '../src/core/model/kinds';
import { sortRules, type Rule } from '../src/core/rules/engine';
import { makeTransaction } from './fixtures';
import { memoryStore } from './host';

/**
 * Reglas de usuario: qué puede hacer una, y qué pasa con las guardadas.
 *
 * Una regla altera la interpretación financiera de un movimiento, así que la
 * pregunta no es qué puede hacer el motor sino qué debería poder pedirle una
 * pantalla. `set_kind` y `mark_transfer` cambian el tipo de actividad que se
 * escribe en Wealthfolio, y con él si el movimiento cuenta como gasto, como
 * ingreso o como nada. Eso no es una preferencia: es contabilidad.
 */

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'user.farmacia',
    name: 'Farmacias',
    enabled: true,
    priority: 500,
    match: 'any',
    conditions: [{ field: 'description', operator: 'contains', value: 'FARMACIA' }],
    actions: [{ type: 'set_category', value: 'salud' }],
    origin: 'user',
    ...overrides,
  };
}

describe('clasificación de riesgo de las acciones', () => {
  it('etiquetar es seguro', () => {
    expect(actionRisk('set_category')).toBe('safe');
    expect(actionRisk('set_merchant')).toBe('safe');
    expect(actionRisk('add_tag')).toBe('safe');
  });

  it('excluir un movimiento pide revisión', () => {
    expect(actionRisk('ignore')).toBe('review-required');
  });

  it('cambiar la interpretación financiera es peligroso', () => {
    expect(actionRisk('set_kind')).toBe('dangerous');
    expect(actionRisk('mark_transfer')).toBe('dangerous');
  });

  it('la pantalla sólo ofrece lo que no es peligroso', () => {
    expect(EDITABLE_ACTIONS.every((type) => actionRisk(type) !== 'dangerous')).toBe(true);
    expect(EDITABLE_ACTIONS).toContain('set_category');
    expect(EDITABLE_ACTIONS).not.toContain('set_kind');
  });
});

describe('validación de una regla de usuario', () => {
  it('acepta una regla de categorización', () => {
    expect(validateUserRule(rule()).errors).toEqual([]);
  });

  it('rechaza una acción peligrosa aunque el motor la soporte', () => {
    const result = validateUserRule(
      rule({ actions: [{ type: 'set_kind', value: TransactionKind.internal_transfer }] }),
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/interpretación/i);
  });

  it('rechaza una regla sin condiciones, que se aplicaría a todo', () => {
    expect(validateUserRule(rule({ conditions: [] })).errors[0]).toMatch(/condición/i);
  });

  it('rechaza una regla sin acciones, que no haría nada', () => {
    expect(validateUserRule(rule({ actions: [] })).errors[0]).toMatch(/acción/i);
  });

  it('rechaza una expresión regular que no compila, en vez de silenciarla', () => {
    // El motor traga un patrón inválido a propósito, para que una regla rota no
    // se lleve por delante toda la importación. En el editor eso sería lo
    // contrario de ayudar: la regla se guardaría sin decir que no funciona.
    const result = validateUserRule(
      rule({ conditions: [{ field: 'description', operator: 'matches', value: '([' }] }),
    );
    expect(result.errors[0]).toMatch(/expresión regular/i);
  });

  it('rechaza un valor vacío en una acción que lo necesita', () => {
    expect(validateUserRule(rule({ actions: [{ type: 'set_category' }] })).errors).toHaveLength(1);
  });

  it('rechaza un rango invertido', () => {
    const result = validateUserRule(
      rule({ conditions: [{ field: 'absAmount', operator: 'between', value: [100, 10] }] }),
    );
    expect(result.errors[0]).toMatch(/rango/i);
  });
});

describe('persistencia y migración de reglas', () => {
  it('lo guardado se lee igual', async () => {
    const store = memoryStore();
    await saveUserRules(store, [rule()]);

    expect(await loadUserRules(store)).toEqual([rule()]);
  });

  it('escribe una versión de esquema', async () => {
    const store = memoryStore();
    await saveUserRules(store, [rule()]);

    const raw = JSON.parse(store.data.get(StorageKeys.rules) as string) as { v: number };
    expect(raw.v).toBe(RULES_SCHEMA_VERSION);
  });

  it('lee el formato de 0.2.0-rc.1, que era una lista pelada', async () => {
    const store = memoryStore();
    await store.set(StorageKeys.rules, JSON.stringify([rule()]));

    expect(await loadUserRules(store)).toEqual([rule()]);
  });

  it('una clave ausente es una lista vacía, no un fallo', async () => {
    expect(await loadUserRules(memoryStore())).toEqual([]);
  });

  it('un valor ilegible no impide abrir el addon', async () => {
    const store = memoryStore();
    await store.set(StorageKeys.rules, 'no soy json');

    expect(await loadUserRules(store)).toEqual([]);
  });

  it('descarta campos que esta versión no conoce en vez de arrastrarlos', async () => {
    const store = memoryStore();
    await store.set(
      StorageKeys.rules,
      JSON.stringify({ v: 1, rules: [{ ...rule(), inventado: 'x', otro: 3 }] }),
    );

    const [loaded] = await loadUserRules(store);
    expect(loaded).not.toHaveProperty('inventado');
    expect(loaded?.id).toBe('user.farmacia');
  });

  it('descarta una regla guardada que no supera la validación', async () => {
    // El almacenamiento se replica entre dispositivos y lo escribe una versión
    // que podría no ser ésta. Una regla que la pantalla no puede producir
    // tampoco se acepta al leerla.
    const store = memoryStore();
    await store.set(
      StorageKeys.rules,
      JSON.stringify({
        v: 1,
        rules: [rule(), rule({ id: 'user.malo', actions: [{ type: 'mark_transfer' }] })],
      }),
    );

    const loaded = await loadUserRules(store);
    expect(loaded.map((r) => r.id)).toEqual(['user.farmacia']);
  });

  it('una regla de usuario siempre queda marcada como de usuario', async () => {
    const store = memoryStore();
    await store.set(
      StorageKeys.rules,
      JSON.stringify({ v: 1, rules: [{ ...rule(), origin: 'builtin' }] }),
    );

    expect((await loadUserRules(store))[0]?.origin).toBe('user');
  });

  it('el conjunto efectivo sigue mezclando predefinidas y de usuario', async () => {
    const store = memoryStore();
    await saveUserRules(store, [rule()]);

    const effective = await loadEffectiveRules(store);
    expect(effective.some((r) => r.id === 'user.farmacia')).toBe(true);
    expect(effective.some((r) => r.origin === 'builtin')).toBe(true);
  });
});

/**
 * Ver antes de guardar.
 *
 * El valor no está en «esta regla coincide con N filas» sino en «esta regla
 * cambia el resultado de N filas»: una regla de prioridad más alta con
 * `stopProcessing` puede estar tapando la mitad de las coincidencias, y contar
 * coincidencias prometería un efecto que no va a ocurrir.
 */
describe('vista previa del efecto de una regla', () => {
  const movements = [
    makeTransaction({ description: 'FARMACIA CRUZ VERDE', amount: -12_000, date: '2026-02-03' }),
    makeTransaction({ description: 'FARMACIA AHUMADA', amount: -8_000, date: '2026-02-05' }),
    makeTransaction({ description: 'SUPERMERCADO LIDER', amount: -45_000, date: '2026-02-06' }),
  ];

  it('cuenta las filas cuyo resultado cambia', () => {
    const preview = previewRuleImpact(rule(), [], movements, { accountId: 'acc-1' });

    expect(preview.evaluated).toBe(3);
    expect(preview.matched).toBe(2);
    expect(preview.changed).toBe(2);
  });

  it('no cuenta como cambio lo que otra regla ya hacía igual', () => {
    const existing = rule({ id: 'user.previa', priority: 100 });
    const preview = previewRuleImpact(rule(), [existing], movements, { accountId: 'acc-1' });

    expect(preview.matched).toBe(2);
    expect(preview.changed).toBe(0);
  });

  it('una regla tapada por otra con stopProcessing no promete nada', () => {
    const shield = rule({
      id: 'user.escudo',
      priority: 10,
      actions: [{ type: 'add_tag', value: 'revisado' }],
      stopProcessing: true,
    });
    const preview = previewRuleImpact(rule({ priority: 500 }), [shield], movements, {
      accountId: 'acc-1',
    });

    expect(preview.matched).toBe(0);
    expect(preview.changed).toBe(0);
  });

  it('separa cuántos movimientos quedarían fuera de la importación', () => {
    const preview = previewRuleImpact(
      rule({ actions: [{ type: 'ignore' }] }),
      [],
      movements,
      { accountId: 'acc-1' },
    );

    expect(preview.ignored).toBe(2);
  });

  it('devuelve unos pocos ejemplos, no la cartola entera', () => {
    const many = Array.from({ length: 40 }, (_, n) =>
      makeTransaction({ description: `FARMACIA ${n}`, amount: -1_000, date: '2026-02-03' }),
    );
    const preview = previewRuleImpact(rule(), [], many, { accountId: 'acc-1' });

    expect(preview.matched).toBe(40);
    expect(preview.samples.length).toBeLessThanOrEqual(5);
  });

  it('la regla candidata reemplaza a la que ya tenía su id', () => {
    // Editar una regla existente es guardar otra con el mismo id. Sin esto la
    // vista previa compararía el conjunto nuevo contra uno que contiene ambas
    // versiones y no cambiaría nunca.
    const existing = rule({ actions: [{ type: 'set_category', value: 'otros' }] });
    const preview = previewRuleImpact(
      rule({ actions: [{ type: 'set_category', value: 'salud' }] }),
      [existing],
      movements,
      { accountId: 'acc-1' },
    );

    expect(preview.changed).toBe(2);
  });

  it('desactivar una regla no cambia nada y se ve así', () => {
    const preview = previewRuleImpact(rule({ enabled: false }), [], movements, {
      accountId: 'acc-1',
    });

    expect(preview.matched).toBe(0);
    expect(preview.changed).toBe(0);
  });

  it('el producto de la cartola llega a la vista previa', () => {
    const preview = previewRuleImpact(
      rule({
        conditions: [{ field: 'product', operator: 'equals', value: 'credit_card' }],
        actions: [{ type: 'add_tag', value: 'tarjeta' }],
      }),
      defaultRules(),
      movements,
      { accountId: 'acc-1', product: 'credit_card' },
    );

    expect(preview.matched).toBe(3);
  });
});

/**
 * Una expresión regular escrita a mano, tratada como entrada hostil.
 *
 * No porque venga de un atacante —viene del propio usuario— sino porque el
 * editor la ejecuta en cada pulsación para calcular la vista previa. Un patrón
 * con retroceso catastrófico no compromete nada, pero cuelga la pestaña de
 * quien lo escribió, en medio de escribirlo, sin explicación.
 */
describe('expresiones regulares', () => {
  const withPattern = (value: string) =>
    validateUserRule(
      rule({ conditions: [{ field: 'description', operator: 'matches', value }] }),
    );

  it('una que no compila se rechaza antes de guardarse', () => {
    expect(withPattern('([').errors[0]).toMatch(/expresión regular/i);
  });

  it('una vacía se rechaza por vacía, no por inválida', () => {
    expect(withPattern('').errors[0]).toMatch(/valor/i);
  });

  it('una válida pasa', () => {
    expect(withPattern('^FARMACIA\\s+\\w+').errors).toEqual([]);
  });

  it('una desmesuradamente larga se rechaza', () => {
    expect(withPattern('a'.repeat(500)).errors[0]).toMatch(/larga/i);
  });

  it('los cuantificadores anidados se rechazan por lo que tardan, no por lo que hacen', () => {
    // `(a+)+$` sobre una glosa que casi encaja recorre exponencialmente. El
    // motor lo ejecutaría igual que cualquier otro patrón.
    expect(withPattern('(a+)+$').errors[0]).toMatch(/tardar|anidad/i);
    expect(withPattern('(x*)*y').errors[0]).toMatch(/tardar|anidad/i);
  });

  it('un cuantificador que no está anidado sigue permitido', () => {
    expect(withPattern('(FARMACIA|BOTICA)+').errors).toEqual([]);
    expect(withPattern('CRUZ\\s*VERDE').errors).toEqual([]);
  });

  it('una regla con patrón inválido guardada por otra versión no se carga', async () => {
    const store = memoryStore();
    await store.set(
      StorageKeys.rules,
      JSON.stringify({
        v: 1,
        rules: [rule({ conditions: [{ field: 'description', operator: 'matches', value: '([' }] })],
      }),
    );

    expect(await loadUserRules(store)).toEqual([]);
  });
});

/**
 * Identidad y orden.
 *
 * Una regla se identifica por su id: editarla es guardar otra con el mismo id,
 * y borrarla es quitarlo. Dos reglas compartiendo id convierten ambas
 * operaciones en un sorteo.
 */
describe('identidad de las reglas', () => {
  it('un id nuevo no choca con los que ya existen', () => {
    const existing = [rule({ id: 'user.a' }), rule({ id: 'user.b' })];
    const ids = new Set(existing.map((r) => r.id));

    for (let n = 0; n < 50; n += 1) {
      const id = newRuleId([...ids].map((value) => ({ id: value }) as Rule));
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });

  it('guardar dos reglas con el mismo id conserva una sola', async () => {
    const store = memoryStore();
    await saveUserRules(store, [
      rule({ id: 'user.x', name: 'Primera' }),
      rule({ id: 'user.x', name: 'Segunda' }),
    ]);

    const loaded = await loadUserRules(store);
    expect(loaded).toHaveLength(1);
    // La última gana: guardar es la operación de escritura, y la última
    // escritura es la intención más reciente.
    expect(loaded[0]?.name).toBe('Segunda');
  });

  it('leer un almacén con ids repetidos tampoco los duplica', async () => {
    const store = memoryStore();
    await store.set(
      StorageKeys.rules,
      JSON.stringify({
        v: 1,
        rules: [rule({ id: 'user.x', name: 'Primera' }), rule({ id: 'user.x', name: 'Segunda' })],
      }),
    );

    expect(await loadUserRules(store)).toHaveLength(1);
  });

  it('el orden se conserva entre guardar y leer', async () => {
    const store = memoryStore();
    const ids = ['user.c', 'user.a', 'user.b'];
    await saveUserRules(store, ids.map((id) => rule({ id, priority: 500 })));

    expect((await loadUserRules(store)).map((r) => r.id)).toEqual(ids);
  });

  it('el orden efectivo no depende del orden de escritura', () => {
    // `sortRules` ordena por prioridad y desempata por id, así que dos
    // conjuntos con las mismas reglas en distinto orden corren igual.
    const a = sortRules([rule({ id: 'user.b', priority: 500 }), rule({ id: 'user.a', priority: 500 })]);
    const b = sortRules([rule({ id: 'user.a', priority: 500 }), rule({ id: 'user.b', priority: 500 })]);

    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });
});

/**
 * Lo que una regla escrita por otra versión puede intentar.
 *
 * `origin` ya se forzaba, pero `priority` y `stopProcessing` viajaban tal cual,
 * y ésos son los dos campos con los que una regla «segura» desarma a una
 * peligrosa: prioridad 1 y `stopProcessing` cortan la evaluación antes de que
 * corra `builtin.transferencia-propia`, y un traspaso entre cuentas propias
 * vuelve a contarse como gasto. Ninguna acción arriesgada hace falta para eso,
 * así que la puerta de riesgo no se entera.
 *
 * La pantalla sólo sabe producir prioridad 500 sin corte, así que eso es lo
 * único que se acepta al leer.
 */
describe('una regla de usuario no puede colarse delante de las predefinidas', () => {
  it('la prioridad guardada se normaliza a la que produce la pantalla', async () => {
    const store = memoryStore();
    await store.set(
      StorageKeys.rules,
      JSON.stringify({ v: 1, rules: [{ ...rule(), priority: 1 }] }),
    );

    expect((await loadUserRules(store))[0]?.priority).toBe(500);
  });

  it('`stopProcessing` no sobrevive a la lectura', async () => {
    const store = memoryStore();
    await store.set(
      StorageKeys.rules,
      JSON.stringify({ v: 1, rules: [{ ...rule(), stopProcessing: true }] }),
    );

    expect((await loadUserRules(store))[0]?.stopProcessing).toBeUndefined();
  });

  it('ni a la escritura', async () => {
    const store = memoryStore();
    await saveUserRules(store, [{ ...rule(), priority: 1, stopProcessing: true }]);

    const raw = JSON.parse(store.data.get(StorageKeys.rules) as string) as {
      rules: Array<{ priority: number; stopProcessing?: boolean }>;
    };
    expect(raw.rules[0]?.priority).toBe(500);
    expect(raw.rules[0]?.stopProcessing).toBeUndefined();
  });

  it('una regla que se hace pasar por predefinida se descarta', async () => {
    // `loadEffectiveRules` deja fuera la predefinida cuyo id repite una del
    // usuario, para implementar «editar una predefinida». No existe esa
    // función en la pantalla, así que un id `builtin.*` en la clave del usuario
    // sólo puede *borrar* una regla auditada — con su interruptor todavía
    // encendido en la pantalla.
    const store = memoryStore();
    await store.set(
      StorageKeys.rules,
      JSON.stringify({ v: 1, rules: [rule({ id: 'builtin.transferencia-propia' })] }),
    );

    expect(await loadUserRules(store)).toEqual([]);
    const effective = await loadEffectiveRules(store);
    expect(effective.some((r) => r.id === 'builtin.transferencia-propia')).toBe(true);
  });
});

/**
 * La versión del esquema tiene que servir para algo.
 *
 * `v` se escribía y no se leía nunca, así que un valor escrito por una versión
 * posterior se interpretaba con las reglas de ésta —quedando en nada— y la
 * siguiente escritura lo pisaba en los dos dispositivos. Degradar donde había
 * que negarse.
 */
describe('versión del esquema', () => {
  const future = JSON.stringify({
    v: RULES_SCHEMA_VERSION + 1,
    rules: [{ id: 'user.a', name: 'A', actions: [{ type: 'set_category', params: { value: 'x' } }] }],
  });

  it('un esquema posterior no se interpreta con las reglas de esta versión', async () => {
    const store = memoryStore();
    await store.set(StorageKeys.rules, future);

    expect(await loadUserRules(store)).toEqual([]);
  });

  it('y no se sobreescribe', async () => {
    const store = memoryStore();
    await store.set(StorageKeys.rules, future);

    await expect(saveUserRules(store, [rule()])).rejects.toThrow(/versión/i);
    expect(store.data.get(StorageKeys.rules)).toBe(future);
  });

  it('el esquema actual sí se puede escribir', async () => {
    const store = memoryStore();
    await saveUserRules(store, [rule()]);
    await saveUserRules(store, [rule({ name: 'Otra' })]);

    expect((await loadUserRules(store))[0]?.name).toBe('Otra');
  });
});

describe('cuantificadores anidados en grupos sin captura', () => {
  const withPattern = (value: string) =>
    validateUserRule(rule({ conditions: [{ field: 'description', operator: 'matches', value }] }));

  it('`(?:...)+` también retrocede exponencialmente y también se rechaza', () => {
    // Medido: `(?:[A-Z]+)+$` sobre una glosa de 37 caracteres no termina.
    expect(withPattern('(?:[A-Z]+)+$').errors[0]).toMatch(/tardar|anidad/i);
  });

  it('un grupo sin captura sin cuantificador anidado sigue permitido', () => {
    expect(withPattern('(?:FARMACIA|BOTICA)').errors).toEqual([]);
  });

  it('una mirada hacia delante no se confunde con un grupo', () => {
    expect(withPattern('(?=FARMACIA).*').errors).toEqual([]);
  });
});

describe('campos que la pantalla ofrece', () => {
  it('no ofrece ninguno que la vista previa no pueda evaluar', () => {
    // `product` lo pone el parser de la cartola y `operationType` lo trae la
    // fila del banco; ninguno de los dos sobrevive en una Activity releída, así
    // que una condición sobre ellos daría siempre «no cambiaría ninguno» y
    // luego dispararía en cada fila al importar.
    expect(EDITABLE_FIELDS).not.toContain('product');
    expect(EDITABLE_FIELDS).not.toContain('operationType');
    expect(EDITABLE_FIELDS).toContain('description');
  });
});
