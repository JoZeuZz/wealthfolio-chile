import { describe, expect, it } from 'vitest';
import {
  actionRisk,
  EDITABLE_ACTIONS,
  loadUserRules,
  previewRuleImpact,
  RULES_SCHEMA_VERSION,
  saveUserRules,
  validateUserRule,
} from '../src/services/rules';
import { loadEffectiveRules } from '../src/services/settings';
import { StorageKeys } from '../src/services/storage';
import { defaultRules } from '../src/core/rules/builtin';
import { TransactionKind } from '../src/core/model/kinds';
import type { Rule } from '../src/core/rules/engine';
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
