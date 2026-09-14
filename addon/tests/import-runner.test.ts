import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { METADATA_NAMESPACE, readChileMetadata } from '../src/core/mapping/activities';
import { prepareImport, setRowSelection, type PreparedImport } from '../src/core/pipeline';
import { defaultRules } from '../src/core/rules/builtin';
import { ImportHistory } from '../src/services/import-history';
import { buildBreakdown, runImport } from '../src/services/import-runner';
import { fromText, loadFixture } from './fixtures';
import { fakeHost } from './host';

/**
 * Writing an approved preview.
 *
 * The distinction under test is the one BUG 3 was about: `created`, `failed`
 * and the four reasons a row was never attempted are four different facts, and
 * collapsing them into "skipped" hides the only one that costs the user money.
 */

const ACCOUNT = 'acc-1';

/** Raw CSV instead of a named fixture, for the rows a fixture does not contain. */
function prepareText(text: string): PreparedImport {
  return prepareImport({
    file: fromText('cartola.csv', text),
    accountId: ACCOUNT,
    accountName: 'Cuenta corriente',
    rules: defaultRules(),
    duplicateIndex: buildDuplicateIndex([]),
  });
}

function prepare(overrides: { file?: string } = {}): PreparedImport {
  return prepareImport({
    file: loadFixture(overrides.file ?? 'banco-chile-cuenta-corriente.csv'),
    accountId: ACCOUNT,
    accountName: 'Cuenta corriente',
    rules: defaultRules(),
    duplicateIndex: buildDuplicateIndex([]),
  });
}

describe('saveMany', () => {
  it('writes every approved row and reports a completed run', async () => {
    const host = fakeHost();
    const prepared = prepare();
    const selected = prepared.rows.filter((row) => row.willImport).length;
    expect(selected).toBeGreaterThan(0);

    const result = await runImport({
      ctx: host.ctx,
      prepared,
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(result.status).toBe('completed');
    expect(result.breakdown.created).toBe(selected);
    expect(result.breakdown.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.historyRecorded).toBe(true);
  });

  it('sends creates, never updates or deletes', async () => {
    const host = fakeHost();
    await runImport({
      ctx: host.ctx,
      prepared: prepare(),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    for (const call of host.saveManyCalls) {
      expect(call.request.creates?.length).toBeGreaterThan(0);
      expect(call.request.updates).toBeUndefined();
      expect(call.request.deleteIds).toBeUndefined();
    }
  });

  it('invalidates the activity and portfolio queries once written', async () => {
    const host = fakeHost();
    await runImport({
      ctx: host.ctx,
      prepared: prepare(),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(host.invalidatedKeys).toContainEqual(['activities']);
    expect(host.invalidatedKeys).toContainEqual(['portfolio']);
  });

  it('carries our metadata into the creation payload', async () => {
    const host = fakeHost();
    const prepared = prepare();

    await runImport({
      ctx: host.ctx,
      prepared,
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    const firstCreate = host.saveManyCalls[0]?.request.creates?.[0];
    const metadata = readChileMetadata(firstCreate?.metadata);

    expect(metadata?.fp).toBeTruthy();
    expect(metadata?.wfp).toBeTruthy();
    expect(metadata?.inst).toBe(prepared.statement.institution);
    expect(metadata?.parserVersion).toBe(prepared.statement.parserVersion);
    expect(metadata?.runId).toMatch(/^run-/);
    expect(typeof firstCreate?.metadata).toBe('string');
    expect(JSON.parse(firstCreate?.metadata as string)[METADATA_NAMESPACE]).toBeDefined();
  });

  it('stamps every row of a run with the same run id', async () => {
    const host = fakeHost();
    await runImport({
      ctx: host.ctx,
      prepared: prepare(),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    const runIds = new Set(
      host.saveManyCalls
        .flatMap((call) => call.request.creates ?? [])
        .map((create) => readChileMetadata(create.metadata)?.runId),
    );

    expect(runIds.size).toBe(1);
  });
});

describe('batching', () => {
  it('splits more than 100 rows into several batches', async () => {
    const host = fakeHost();
    const prepared = prepare();

    // Grow the preview to 250 approved rows by cloning what the fixture gave us.
    const template = prepared.rows.find((row) => row.willImport);
    expect(template).toBeDefined();
    const rows = Array.from({ length: 250 }, (_, i) => ({
      ...(template as NonNullable<typeof template>),
      transaction: {
        ...(template as NonNullable<typeof template>).transaction,
        fingerprint: `synthetic-${i}`,
      },
      weakFingerprint: `synthetic-weak-${i}`,
      willImport: true,
    }));

    const result = await runImport({
      ctx: host.ctx,
      prepared: { ...prepared, rows },
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(host.saveManyCalls).toHaveLength(3);
    expect(host.saveManyCalls[0]?.request.creates).toHaveLength(100);
    expect(host.saveManyCalls[2]?.request.creates).toHaveLength(50);
    expect(result.breakdown.created).toBe(250);
    expect(result.status).toBe('completed');
  });
});

describe('partial and total failure', () => {
  it('reports a partial run when the host rejects some rows', async () => {
    const host = fakeHost();
    const prepared = prepare();
    const selected = prepared.rows.filter((row) => row.willImport).length;
    // The single batch creates only two of the approved rows.
    host.saveManyPlan = [2];

    const result = await runImport({
      ctx: host.ctx,
      prepared,
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(result.status).toBe('partial');
    expect(result.breakdown.created).toBe(2);
    expect(result.breakdown.failed).toBe(selected - 2);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.run.status).toBe('partial');
    expect(result.run.failedRows).toBe(selected - 2);
  });

  it('reports a failed run when no row survives', async () => {
    const host = fakeHost();
    host.saveManyPlan = ['throw'];

    const result = await runImport({
      ctx: host.ctx,
      prepared: prepare(),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(result.status).toBe('failed');
    expect(result.breakdown.created).toBe(0);
    expect(result.errors).toContain('host rejected the batch');
    expect(host.logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('does not retry a batch that threw', async () => {
    const host = fakeHost();
    host.saveManyPlan = ['throw'];

    await runImport({
      ctx: host.ctx,
      prepared: prepare(),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(host.saveManyCalls).toHaveLength(1);
  });

  it('keeps a successful write when the history cannot be recorded', async () => {
    const host = fakeHost();
    const prepared = prepare();
    const selected = prepared.rows.filter((row) => row.willImport).length;

    // Everything is written, then storage refuses the history entry.
    const original = host.store.set.bind(host.store);
    host.store.set = async () => {
      throw new Error('storage full');
    };

    const result = await runImport({
      ctx: host.ctx,
      prepared,
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });
    host.store.set = original;

    expect(result.breakdown.created).toBe(selected);
    expect(result.status).toBe('completed');
    expect(result.historyRecorded).toBe(false);
    expect(result.errors.join(' ')).toContain('historial');
  });
});

describe('history recording', () => {
  it('writes one run with the full breakdown', async () => {
    const host = fakeHost();
    const prepared = prepare();

    const result = await runImport({
      ctx: host.ctx,
      prepared,
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    const runs = await new ImportHistory(host.store).all();
    expect(runs).toHaveLength(1);

    const stored = runs[0];
    expect(stored?.id).toBe(result.run.id);
    expect(stored?.accountId).toBe(ACCOUNT);
    expect(stored?.fileHash).toBe(prepared.fileHash);
    expect(stored?.detectedRows).toBe(prepared.rows.length);
    expect(stored?.selectedRows).toBe(result.breakdown.selected);
    expect(stored?.importedRows).toBe(result.breakdown.created);
    expect(stored?.parserVersion).toBe(prepared.statement.parserVersion);
  });

  it('never logs a description or an amount', async () => {
    const host = fakeHost();
    await runImport({
      ctx: host.ctx,
      prepared: prepare(),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    const logged = host.logs.map((entry) => entry.message).join('\n');
    expect(logged).not.toMatch(/\d{1,3}(\.\d{3})+/);
    expect(logged).not.toContain('Cuenta corriente');
  });
});

describe('buildBreakdown', () => {
  const row = (overrides: {
    willImport: boolean;
    verdict?: 'exact' | 'probable' | 'none';
    ignoredByRule?: boolean;
    reasonCode?: string;
  }) =>
    ({
      transaction: {},
      weakFingerprint: 'w',
      duplicate: { verdict: overrides.verdict ?? 'none', reason: '', reason_code: overrides.reasonCode },
      ignoredByRule: overrides.ignoredByRule ?? false,
      willImport: overrides.willImport,
    }) as never;

  it('attributes every row to exactly one outcome', () => {
    const breakdown = buildBreakdown(
      [
        row({ willImport: true }),
        row({ willImport: true }),
        row({ willImport: false, verdict: 'exact' }),
        row({ willImport: false, verdict: 'probable' }),
        row({ willImport: false, ignoredByRule: true }),
        row({ willImport: false }),
      ],
      2,
    );

    expect(breakdown).toEqual({
      detected: 6,
      selected: 2,
      created: 2,
      failed: 0,
      skippedExactDuplicate: 1,
      skippedProbableDuplicate: 1,
      skippedByRule: 1,
      skippedByUser: 1,
    });
  });

  it('counts approved-but-unwritten rows as failed, not skipped', () => {
    const breakdown = buildBreakdown([row({ willImport: true }), row({ willImport: true })], 1);
    expect(breakdown.failed).toBe(1);
    expect(breakdown.skippedByUser).toBe(0);
  });

  it('attributes a duplicate the user unticked to the duplicate, not to the user', () => {
    const breakdown = buildBreakdown(
      [row({ willImport: false, verdict: 'exact', ignoredByRule: true })],
      0,
    );
    expect(breakdown.skippedExactDuplicate).toBe(1);
    expect(breakdown.skippedByRule).toBe(0);
  });

  it('never reports more created than were approved', () => {
    const breakdown = buildBreakdown([row({ willImport: true })], 99);
    expect(breakdown.created).toBe(1);
    expect(breakdown.failed).toBe(0);
  });

  it('tracks a row the user unticked in the preview', () => {
    const prepared = prepare();
    const first = prepared.rows.find((r) => r.willImport);
    const toggled = setRowSelection(prepared, first?.key as string, false);

    const breakdown = buildBreakdown(toggled.rows, 0);
    expect(breakdown.skippedByUser).toBeGreaterThanOrEqual(1);
  });

  it('un legacy-source-conflict con willImport forzado a true nunca se cuenta como selected/failed — nunca cruzó el write gate', () => {
    // P2 (re-review OpenCode): `runImport` ya filtra `legacy-source-conflict`
    // del set que llega a `saveMany` aunque `willImport` venga forzado en
    // `true` sin pasar por `setRowSelection`. `buildBreakdown` debe usar la
    // misma regla, o reporta `failed: 1` como si Wealthfolio hubiera
    // rechazado una fila que nunca se intentó guardar.
    const breakdown = buildBreakdown(
      [row({ willImport: true, verdict: 'probable', reasonCode: 'legacy-source-conflict' })],
      0,
    );

    expect(breakdown.selected).toBe(0);
    expect(breakdown.failed).toBe(0);
    expect(breakdown.skippedProbableDuplicate).toBe(1);
  });
});

describe('el historial cuenta las filas que el parser descartó', () => {
  it('guarda cuántas se omitieron por no ser movimientos', async () => {
    // Sin esto el historial responde «detectados» y «creados» pero no «de
    // cuántas filas salieron», que es la mitad de la pregunta cuando algo no
    // cuadra.
    const host = fakeHost();
    const prepared = prepareImport({
      file: fromText(
        'cartola.csv',
        [
          'Fecha;Descripcion;Cargo;Abono;Saldo',
          '2026-02-03;COMPRA UNO;10.000;;90.000',
          '',
          '2026-02-04;TOTAL DEL PERIODO;;;90.000',
          '2026-02-05;COMPRA DOS;5.000;;85.000',
        ].join('\n'),
      ),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });

    const result = await runImport({
      ctx: host.ctx,
      prepared,
      accountId: 'acc-1',
      accountName: 'Cuenta',
    });

    expect(result.run.skippedRows).toBe(2);
    expect(result.run.detectedRows).toBe(2);
  });
});

/**
 * Dos identidades para el mismo movimiento no pueden discrepar.
 *
 * Wealthfolio calcula su propia clave de idempotencia y la protege con un
 * índice único, y esa clave **no** incluye la referencia bancaria: es
 * `(cuenta, tipo, fecha, símbolo, cantidad, precio, monto, comisión, moneda,
 * sourceRecordId, notes)`. La nuestra sí incluye la referencia. Dos giros de
 * $20.000 el mismo día con la misma glosa y documentos 4417 y 4418 son dos
 * movimientos para nosotros y uno para el host.
 *
 * Comprobado contra un host 3.7.0 real: el `POST /activities/bulk` devuelve
 * `400 Duplicate activity detected. A matching activity already exists.` y —
 * porque el create masivo es un `insert_into` sin `ON CONFLICT` dentro de una
 * sola transacción— **no escribe ninguna** de las filas del lote. Con lotes de
 * 100, dos giros iguales cuestan 100 movimientos. La vista previa dice que
 * todas son nuevas y el error habla de un duplicado que el usuario no puede
 * encontrar: la única salida es desmarcar una fila, que borra un giro real.
 *
 * Mandar nuestra huella como `idempotencyKey` deja una sola función de
 * identidad. El campo no está declarado en `ActivityCreate` del SDK 3.7.0 pero
 * el backend lo respeta tal cual — verificado contra el host real.
 */
describe('la clave de idempotencia del host es la nuestra', () => {
  it('cada actividad lleva su huella como clave', async () => {
    const prepared = prepare();
    const host = fakeHost();

    await runImport({
      ctx: host.ctx,
      prepared,
      accountId: ACCOUNT,
      accountName: 'Banco de Chile',
    });

    const creates = host.saveManyCalls[0]?.request.creates ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const [i, create] of creates.entries()) {
      const row = prepared.rows.filter((r) => r.willImport)[i];
      expect((create as { idempotencyKey?: string }).idempotencyKey).toBe(
        row?.transaction.fingerprint,
      );
    }
  });

  it('dos filas indistinguibles del mismo archivo no comparten clave', async () => {
    const prepared = prepareText(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo;N Documento',
        '14/02/2026;GIRO CAJERO AUTOMATICO;20.000;;980.000;4417',
        '14/02/2026;GIRO CAJERO AUTOMATICO;20.000;;960.000;4418',
      ].join('\n'),
    );

    // Las dos filas se importan sólo si el usuario marca la segunda; el
    // objetivo aquí es que, cuando lo haga, el host no rechace el lote.
    const second = prepared.rows[1];
    const all = setRowSelection(prepared, second?.key as string, true);
    const host = fakeHost();

    await runImport({
      ctx: host.ctx,
      prepared: all,
      accountId: ACCOUNT,
      accountName: 'Banco de Chile',
    });

    const keys = (host.saveManyCalls[0]?.request.creates ?? []).map(
      (c) => (c as { idempotencyKey?: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

/**
 * Marcar una fila no puede arrastrar a otra.
 *
 * `setRowSelection` buscaba por huella, y dos filas indistinguibles del mismo
 * archivo comparten huella: marcar una marcaba las dos. Justo el caso donde el
 * usuario más necesita decidir fila por fila — el archivo lista un movimiento
 * dos veces, o hubo dos cafés del mismo precio — era el único donde no podía.
 */
describe('la selección es por fila, no por huella', () => {
  it('marcar la segunda de dos filas iguales no marca la primera', () => {
    const prepared = prepareText(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo;N Documento',
        '14/02/2026;GIRO CAJERO AUTOMATICO;20.000;;980.000;4417',
        '14/02/2026;GIRO CAJERO AUTOMATICO;20.000;;960.000;4418',
      ].join('\n'),
    );

    const updated = setRowSelection(prepared, prepared.rows[1]?.key as string, false);

    expect(updated.rows[0]?.willImport).toBe(true);
    expect(updated.rows[1]?.willImport).toBe(false);
  });

  it('cada fila tiene una clave distinta aunque compartan huella', () => {
    const prepared = prepareText(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '14/02/2026;GIRO CAJERO AUTOMATICO;20.000;;980.000',
        '14/02/2026;GIRO CAJERO AUTOMATICO;20.000;;960.000',
      ].join('\n'),
    );

    expect(prepared.rows[0]?.transaction.fingerprint).toBe(
      prepared.rows[1]?.transaction.fingerprint,
    );
    expect(prepared.rows[0]?.key).not.toBe(prepared.rows[1]?.key);
  });
});
