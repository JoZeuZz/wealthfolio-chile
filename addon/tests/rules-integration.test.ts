import { describe, expect, it } from 'vitest';
import { computeFingerprint } from '../src/core/dedupe/fingerprint';
import { readChileMetadata, toActivityCreate } from '../src/core/mapping/activities';
import { reconcileWindow } from '../src/services/reconciliation';
import { TransactionKind } from '../src/core/model/kinds';
import { prepareImportFromHost } from '../src/services/import-preparation';
import { saveUserRules } from '../src/services/rules';
import { saveSettings, DEFAULT_SETTINGS, loadEffectiveRules } from '../src/services/settings';
import type { Rule } from '../src/core/rules/engine';
import { fromText, makeTransaction } from './fixtures';
import { activityStub, fakeHost } from './host';

/**
 * De la pantalla de configuración a la importación real.
 *
 * Los tests de `rules-service` prueban que una regla se guarda y que la vista
 * previa calcula bien. Eso no demuestra la única cosa que le importa a un
 * usuario: que la regla que guardó cambie lo que se importa. Una pantalla que
 * escribe JSON en un almacén que el pipeline no lee es peor que no tener
 * pantalla, porque promete un control que no existe.
 *
 * Estos tests recorren el circuito entero por donde pasa la aplicación real:
 *
 *   almacenamiento del host
 *     → `loadEffectiveRules`
 *     → `prepareImportFromHost`
 *     → `pipeline.applyRulesToBatch`
 *     → filas de la vista previa
 *
 * `prepareImportFromHost` es exactamente la función que llama
 * `ImportWizardPage`, y el `fakeHost` es el mismo doble que usan los tests de
 * servicios. No se le pasa ninguna regla a mano: si la regla no llega, el test
 * falla.
 */

const CARTOLA = [
  'Fecha;Descripcion;Cargo;Abono;Saldo',
  '03/02/2026;FARMACIA AHUMADA PROVIDENCIA;12.000;;88.000',
  '04/02/2026;SUPERMERCADO LIDER;45.000;;43.000',
  '05/02/2026;INTERESES POR SOBREGIRO;8.900;;34.100',
].join('\n');

function userRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'user.farmacia',
    name: 'Farmacias',
    enabled: true,
    priority: 500,
    match: 'all',
    conditions: [{ field: 'description', operator: 'contains', value: 'FARMACIA' }],
    actions: [{ type: 'set_category', value: 'mi-farmacia' }],
    origin: 'user',
    ...overrides,
  };
}

async function prepare(host: ReturnType<typeof fakeHost>, text = CARTOLA) {
  return prepareImportFromHost(host.ctx, {
    file: fromText('cartola.csv', text),
    accountId: 'acc-1',
    accountName: 'Cuenta corriente',
    parserId: 'generico.cuenta',
  });
}

function rowFor(
  result: Awaited<ReturnType<typeof prepare>>,
  needle: string,
) {
  return result.prepared?.rows.find((row) => row.transaction.description.includes(needle));
}

describe('una regla guardada llega a la importación', () => {
  it('sin la regla, la farmacia lleva la categoría que puso la predefinida', async () => {
    const host = fakeHost();

    const before = await prepare(host);

    // `builtin.farmacia` ya la categoriza: el punto de la regla de usuario no
    // es rellenar un hueco, es sobreescribir una decisión previa.
    expect(rowFor(before, 'FARMACIA')?.transaction.category).toBe('salud.farmacia');
  });

  it('con la regla guardada en el almacenamiento del host, sí la lleva', async () => {
    const host = fakeHost();
    await saveUserRules(host.store, [userRule()]);

    const after = await prepare(host);

    const row = rowFor(after, 'FARMACIA');
    expect(row?.transaction.category).toBe('mi-farmacia');
    expect(row?.transaction.appliedRules).toContain('user.farmacia');
  });

  it('y no toca las filas que no coinciden', async () => {
    const host = fakeHost();
    await saveUserRules(host.store, [userRule()]);

    const after = await prepare(host);

    expect(rowFor(after, 'LIDER')?.transaction.category).not.toBe('mi-farmacia');
  });

  it('una regla deshabilitada se guarda y no se aplica', async () => {
    const host = fakeHost();
    await saveUserRules(host.store, [userRule({ enabled: false })]);

    const after = await prepare(host);

    expect(rowFor(after, 'FARMACIA')?.transaction.category).toBe('salud.farmacia');
    expect(rowFor(after, 'FARMACIA')?.transaction.appliedRules).not.toContain('user.farmacia');
    // Guardada sí está: desactivada no es lo mismo que borrada.
    expect((await loadEffectiveRules(host.store)).some((r) => r.id === 'user.farmacia')).toBe(true);
  });

  it('una regla `ignore` deja la fila fuera de lo que se va a escribir', async () => {
    const host = fakeHost();
    await saveUserRules(host.store, [
      userRule({ id: 'user.ignorar', actions: [{ type: 'ignore' }] }),
    ]);

    const after = await prepare(host);

    const row = rowFor(after, 'FARMACIA');
    expect(row?.ignoredByRule).toBe(true);
    expect(row?.willImport).toBe(false);
  });
});

describe('desactivar una regla predefinida llega a la importación', () => {
  it('por defecto el interés se clasifica como tal', async () => {
    const host = fakeHost();

    const result = await prepare(host);

    const row = rowFor(result, 'INTERESES');
    expect(row?.transaction.kind).toBe(TransactionKind.interest);
    expect(row?.transaction.appliedRules).toContain('builtin.intereses');
  });

  it('con la regla desactivada en Settings, deja de aplicarse', async () => {
    const host = fakeHost();
    await saveSettings(host.store, {
      ...DEFAULT_SETTINGS,
      disabledBuiltinRules: ['builtin.intereses'],
    });

    const result = await prepare(host);

    const row = rowFor(result, 'INTERESES');
    expect(row?.transaction.appliedRules).not.toContain('builtin.intereses');
    expect(row?.transaction.kind).not.toBe(TransactionKind.interest);
  });

  it('y volver a activarla la devuelve', async () => {
    const host = fakeHost();
    await saveSettings(host.store, {
      ...DEFAULT_SETTINGS,
      disabledBuiltinRules: ['builtin.intereses'],
    });
    await saveSettings(host.store, { ...DEFAULT_SETTINGS, disabledBuiltinRules: [] });

    const result = await prepare(host);

    expect(rowFor(result, 'INTERESES')?.transaction.kind).toBe(TransactionKind.interest);
  });
});

/**
 * Precedencia, fijada aquí para que no cambie por accidente.
 *
 * `loadEffectiveRules` devuelve las predefinidas y luego las del usuario, y
 * `sortRules` ordena por prioridad y desempata por id. Las predefinidas ocupan
 * de 10 a 110 y una regla nueva de la pantalla nace en 500, así que el orden
 * efectivo es:
 *
 *   parser y clasificación por producto
 *     → reglas predefinidas
 *     → reglas del usuario
 *
 * Con una consecuencia deliberada: las tres predefinidas que llevan
 * `stopProcessing` —pago de tarjeta, traspaso entre cuentas propias y traspaso
 * en cuenta— blindan la fila y una regla del usuario no llega a verla. Son
 * exactamente las que deciden si un movimiento cuenta como gasto, así que esa
 * es la dirección correcta del blindaje: una regla de etiquetado no puede
 * deshacer una decisión de interpretación financiera. Cuando ocurre, la vista
 * previa del editor dice «no cambiaría ninguno», que es la señal honesta.
 */
describe('precedencia entre reglas predefinidas y de usuario', () => {
  it('las predefinidas corren antes que las del usuario', async () => {
    const host = fakeHost();
    await saveUserRules(host.store, [userRule({ priority: 500 })]);
    const rules = await loadEffectiveRules(host.store);

    const origins = rules.map((rule) => rule.origin);
    const lastBuiltin = origins.lastIndexOf('builtin');
    const firstUser = origins.indexOf('user');

    expect(lastBuiltin).toBeGreaterThanOrEqual(0);
    expect(firstUser).toBeGreaterThan(lastBuiltin);
  });

  it('una regla de usuario refina lo que una predefinida ya categorizó', async () => {
    const host = fakeHost();
    await saveUserRules(host.store, [
      userRule({
        id: 'user.supermercado',
        conditions: [{ field: 'description', operator: 'contains', value: 'LIDER' }],
        actions: [{ type: 'set_category', value: 'mi-super' }],
      }),
    ]);

    const result = await prepare(host);

    // `builtin.supermercados` corre antes y pone la suya; la del usuario, al
    // correr después, gana.
    const row = rowFor(result, 'LIDER');
    expect(row?.transaction.appliedRules).toContain('builtin.supermercado');
    expect(row?.transaction.category).toBe('mi-super');
  });

  it('una predefinida con stopProcessing blinda la fila, y eso es lo pretendido', async () => {
    const host = fakeHost();
    await saveUserRules(host.store, [
      userRule({
        id: 'user.pago',
        conditions: [{ field: 'description', operator: 'contains', value: 'PAGO TARJETA' }],
        actions: [{ type: 'set_category', value: 'ocio' }],
      }),
    ]);

    const result = await prepare(
      host,
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;PAGO TARJETA VISA;350.000;;650.000',
      ].join('\n'),
    );

    const row = rowFor(result, 'PAGO TARJETA');
    expect(row?.transaction.appliedRules).toEqual(['builtin.pago-tarjeta']);
    expect(row?.transaction.category).toBe('pago-tarjeta');
  });

  it('una regla de usuario no puede reclasificar el tipo, aunque lo intente al guardarla', async () => {
    const host = fakeHost();
    // Escrito directamente en el almacén, saltándose el editor: es lo que haría
    // otra versión del addon, o alguien editando el valor sincronizado.
    await host.store.set(
      'wfcl.rules',
      JSON.stringify({
        v: 1,
        rules: [
          userRule({
            id: 'user.malo',
            actions: [{ type: 'set_kind', value: TransactionKind.internal_transfer }],
          }),
        ],
      }),
    );

    const result = await prepare(host);

    const row = rowFor(result, 'FARMACIA');
    expect(row?.transaction.appliedRules).not.toContain('user.malo');
    expect(row?.transaction.kind).not.toBe(TransactionKind.internal_transfer);
  });
});

/**
 * Cambiar una regla no puede cambiar la identidad de un movimiento.
 *
 * La huella se calcula sobre cuenta, fecha, monto, moneda, glosa normalizada y
 * referencia — nada que una regla toque. Si `category`, `merchant` o `tags`
 * entraran en la receta, editar una regla y reimportar el mismo archivo daría
 * huellas nuevas, el índice de duplicados no reconocería nada y el mes entero
 * entraría por segunda vez.
 */
describe('las reglas no mueven la huella', () => {
  it('la huella es la misma con y sin regla de categorización', async () => {
    const plain = fakeHost();
    const ruled = fakeHost();
    await saveUserRules(ruled.store, [
      userRule({
        actions: [
          { type: 'set_category', value: 'mi-farmacia' },
          { type: 'set_merchant', value: 'Farmacia Ahumada' },
          { type: 'add_tag', value: 'salud' },
        ],
      }),
    ]);

    const before = await prepare(plain);
    const after = await prepare(ruled);

    const a = rowFor(before, 'FARMACIA');
    const b = rowFor(after, 'FARMACIA');

    expect(b?.transaction.category).toBe('mi-farmacia');
    expect(b?.transaction.merchant).toBe('Farmacia Ahumada');
    expect(b?.transaction.fingerprint).toBe(a?.transaction.fingerprint);
    expect(b?.weakFingerprint).toBe(a?.weakFingerprint);
  });

  it('y la receta de la huella no lee ninguno de esos campos', () => {
    const scope = { accountId: 'acc-1' };
    const base = {
      date: '2026-02-03',
      amount: { minor: -12_000, scale: 0, currency: 'CLP' },
      description: 'FARMACIA AHUMADA',
      reference: undefined,
    } as unknown as Parameters<typeof computeFingerprint>[0];

    const withLabels = {
      ...base,
      category: 'salud.farmacia',
      merchant: 'Farmacia Ahumada',
      tags: ['salud'],
      kind: TransactionKind.expense,
    } as unknown as Parameters<typeof computeFingerprint>[0];

    expect(computeFingerprint(withLabels, scope)).toBe(computeFingerprint(base, scope));
  });

  it('reimportar tras cambiar una regla reconoce el movimiento como duplicado', async () => {
    const host = fakeHost();
    const first = await prepare(host);
    const row = rowFor(first, 'FARMACIA');
    expect(row?.duplicate.verdict).toBe('none');

    // El movimiento ya está en el host, escrito con la huella de antes.
    host.activities = [
      activityStub({
        id: 'act-1',
        accountId: 'acc-1',
        activityType: 'WITHDRAWAL',
        amount: '12000',
        currency: 'CLP',
        date: '2026-02-03',
        comment: 'FARMACIA AHUMADA PROVIDENCIA',
        metadata: {
          fp: row?.transaction.fingerprint as string,
          wfp: row?.weakFingerprint as string,
        },
      }),
    ];

    await saveUserRules(host.store, [userRule()]);
    const second = await prepare(host);

    expect(rowFor(second, 'FARMACIA')?.duplicate.verdict).toBe('exact');
  });
});

/**
 * Qué alcanza una regla, y qué no.
 *
 * Una regla vale para lo que se lea a partir de ahora. No recalcula lo ya
 * importado, y guardarla no escribe nada en Wealthfolio: `saveUserRules` toca
 * una clave del almacén del addon y nada más. Lo contrario —reinterpretar en
 * masa Activities existentes al guardar una regla— reescribiría contabilidad
 * que el usuario puede haber corregido a mano en el host.
 */
describe('alcance de una regla', () => {
  it('guardarla no escribe ninguna Activity', async () => {
    const host = fakeHost();

    await saveUserRules(host.store, [userRule()]);
    await saveSettings(host.store, { ...DEFAULT_SETTINGS, disabledBuiltinRules: ['builtin.intereses'] });

    expect(host.saveManyCalls).toHaveLength(0);
  });
});

/**
 * La ventana de conciliación no puede ser decoración.
 *
 * `reconcileWindow` lee `transferWindowDays` de los ajustes, así que cambiar el
 * número en la pantalla tiene que cambiar qué pares se proponen. Se comprueba
 * por el efecto observable —dos patas separadas tres días— y no leyendo el
 * ajuste de vuelta, que es lo que un test decorativo haría.
 */
describe('la ventana de conciliación que guarda Settings se usa', () => {
  function legs() {
    const out = toActivityCreate(
      makeTransaction({
        description: 'TRANSFERENCIA A CUENTA PROPIA',
        amount: -200_000,
        date: '2026-02-03',
        kind: TransactionKind.internal_transfer,
      }),
      { accountId: 'acc-1', runId: 'run-1' },
    );
    const income = toActivityCreate(
      makeTransaction({
        description: 'TRANSFERENCIA DESDE CUENTA PROPIA',
        amount: 200_000,
        date: '2026-02-06',
        kind: TransactionKind.internal_transfer,
      }),
      { accountId: 'acc-2', runId: 'run-1' },
    );

    return [
      activityStub({
        id: 'out-1',
        accountId: 'acc-1',
        activityType: out.activityType,
        amount: '200000',
        date: '2026-02-03',
        comment: out.comment as string,
        metadata: readChileMetadata(out.metadata as string) as unknown as Record<string, unknown>,
      }),
      activityStub({
        id: 'in-1',
        accountId: 'acc-2',
        activityType: income.activityType,
        amount: '200000',
        date: '2026-02-06',
        comment: income.comment as string,
        metadata: readChileMetadata(income.metadata as string) as unknown as Record<string, unknown>,
      }),
    ];
  }

  it('con un día de margen, tres días de diferencia no se emparejan', async () => {
    const host = fakeHost({ activities: legs() });
    await saveSettings(host.store, { ...DEFAULT_SETTINGS, transferWindowDays: 1 });

    const result = await reconcileWindow(host.ctx);

    expect(result.transfers).toHaveLength(0);
  });

  it('con cinco, sí', async () => {
    const host = fakeHost({ activities: legs() });
    await saveSettings(host.store, { ...DEFAULT_SETTINGS, transferWindowDays: 5 });

    const result = await reconcileWindow(host.ctx);

    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]?.outflow.accountId).toBe('acc-1');
  });
});

/**
 * Que falle una lectura no puede volver a encender lo que el usuario apagó.
 *
 * `loadEffectiveRules` leía ajustes y reglas bajo un solo `Promise.all`, así
 * que un rechazo en cualquiera de las dos claves tumbaba las dos, y
 * `prepareImportFromHost` caía a `defaultRules()`: todas las predefinidas
 * encendidas, incluidas las tres que deciden si un movimiento es gasto. El
 * aviso decía «se usaron sólo las reglas predefinidas» y no que las apagadas
 * habían vuelto.
 */
describe('una lectura rota no reactiva reglas apagadas', () => {
  it('si sólo fallan las reglas del usuario, los interruptores se respetan', async () => {
    const host = fakeHost();
    await saveSettings(host.store, {
      ...DEFAULT_SETTINGS,
      disabledBuiltinRules: ['builtin.intereses'],
    });
    const original = host.store.get.bind(host.store);
    host.store.get = async (key: string) => {
      if (key === 'wfcl.rules') throw new Error('almacenamiento no disponible');
      return original(key);
    };

    const result = await prepare(host);

    expect(rowFor(result, 'INTERESES')?.transaction.kind).not.toBe(TransactionKind.interest);
  });
});
