import { describe, expect, it } from 'vitest';
import { TransactionKind } from '../src/core/model/kinds';
import { prepareImportFromHost } from '../src/services/import-preparation';
import { StorageKeys } from '../src/services/storage';
import { fromText, loadFixture } from './fixtures';
import { activityStub, fakeHost } from './host';

/**
 * Preparing a preview against a live host.
 *
 * The rule under test: a duplicate check that could not run must block the
 * import. Falling back to an empty index would show every row as new and let a
 * confirmed month of expenses land twice.
 */

const ACCOUNT = 'acc-1';

function ourMetadata(fp: string) {
  return {
    fp,
    wfp: `${fp}-weak`,
    inst: 'banco-chile',
    parser: 'banco-chile.cartola-csv',
    parserVersion: '1.0.0',
    fileHash: 'file-hash',
    runId: 'run-1',
    kind: TransactionKind.expense,
  };
}

describe('happy path', () => {
  it('parses, reads the host and allows importing', async () => {
    const host = fakeHost();

    const result = await prepareImportFromHost(host.ctx, {
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: ACCOUNT,
      accountName: 'Cuenta corriente',
    });

    expect(result.parse.status).toBe('ok');
    expect(result.duplicateIndex.status).toBe('ready');
    expect(result.rules.status).toBe('ok');
    expect(result.canImport).toBe(true);
    expect(result.prepared?.rows.length).toBeGreaterThan(0);
  });

  it('asks the host only for the statement period, with a margin', async () => {
    const host = fakeHost();

    const result = await prepareImportFromHost(host.ctx, {
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: ACCOUNT,
    });

    const period = result.prepared?.statement.period;
    expect(period?.from).toBeTruthy();

    // The probe pass runs with no index, so the only search is the scoped one.
    const filters = host.searchCalls[0]?.filters;
    expect(filters?.['accountIds']).toBe(ACCOUNT);
    expect(String(filters?.['dateFrom']) < String(period?.from)).toBe(true);
    expect(String(filters?.['dateTo']) > String(period?.to)).toBe(true);
  });

  it('finds an existing movement and marks it as an exact duplicate', async () => {
    // First pass: import into an empty host to learn the fingerprints.
    const empty = fakeHost();
    const first = await prepareImportFromHost(empty.ctx, {
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: ACCOUNT,
    });
    const row = first.prepared?.rows[0];
    expect(row).toBeDefined();

    // Second pass: the host now holds that movement.
    const host = fakeHost({
      activities: [
        activityStub({
          accountId: ACCOUNT,
          activityType: 'WITHDRAWAL',
          amount: '1000',
          date: row?.transaction.date as string,
          comment: row?.transaction.description as string,
          metadata: {
            ...ourMetadata(row?.transaction.fingerprint as string),
            wfp: row?.weakFingerprint as string,
          },
        }),
      ],
    });

    const second = await prepareImportFromHost(host.ctx, {
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: ACCOUNT,
    });

    const sameRow = second.prepared?.rows.find(
      (candidate) => candidate.transaction.fingerprint === row?.transaction.fingerprint,
    );
    expect(sameRow?.duplicate.verdict).toBe('exact');
    expect(sameRow?.willImport).toBe(false);
    expect(second.canImport).toBe(true);
  });
});

describe('duplicate index unavailable', () => {
  it('still shows a preview but refuses to import when the host read fails', async () => {
    const host = fakeHost();
    host.searchError = new Error('backend unavailable');

    const result = await prepareImportFromHost(host.ctx, {
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: ACCOUNT,
    });

    expect(result.parse.status).toBe('ok');
    expect(result.prepared?.rows.length).toBeGreaterThan(0);
    expect(result.duplicateIndex.status).toBe('unavailable');
    expect(result.duplicateIndex).toMatchObject({ reason: 'error' });
    expect(result.canImport).toBe(false);
  });

  it('does not pretend every row is new when it could not check', async () => {
    const host = fakeHost();
    host.searchError = new Error('backend unavailable');

    const result = await prepareImportFromHost(host.ctx, {
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: ACCOUNT,
    });

    // Rows are still selectable — the preview is honest about what the parser
    // produced — but the gate above stops them from being written.
    expect(result.prepared?.totals.toImport).toBeGreaterThan(0);
    expect(result.canImport).toBe(false);
  });

  it('blocks the import when the account is too large to scan fully', async () => {
    const activities = Array.from({ length: 20_001 }, (_, i) =>
      activityStub({
        accountId: ACCOUNT,
        activityType: 'WITHDRAWAL',
        amount: '1000',
        date: '2026-03-06',
        metadata: ourMetadata(`fp-${i}`),
      }),
    );
    const host = fakeHost({ activities });

    const result = await prepareImportFromHost(host.ctx, {
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: ACCOUNT,
    });

    expect(result.duplicateIndex).toMatchObject({ status: 'unavailable', reason: 'truncated' });
    expect(result.canImport).toBe(false);
  });

  it('reports the host error message so the user can act on it', async () => {
    const host = fakeHost();
    host.searchError = new Error('connection refused');

    const result = await prepareImportFromHost(host.ctx, {
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: ACCOUNT,
    });

    expect(
      result.duplicateIndex.status === 'unavailable' ? result.duplicateIndex.message : '',
    ).toContain('connection refused');
  });
});

describe('unparseable file', () => {
  it('reports a parse error and no preview', async () => {
    const host = fakeHost();

    const result = await prepareImportFromHost(host.ctx, {
      file: fromText('ruido.csv', 'esto no es una cartola\nni de cerca\n'),
      accountId: ACCOUNT,
    });

    expect(result.parse.status).toBe('error');
    expect(result.prepared).toBeUndefined();
    expect(result.canImport).toBe(false);
  });

  it('does not bother the host when the file cannot be read', async () => {
    const host = fakeHost();

    await prepareImportFromHost(host.ctx, {
      file: fromText('ruido.csv', 'esto no es una cartola\nni de cerca\n'),
      accountId: ACCOUNT,
    });

    expect(host.searchCalls).toHaveLength(0);
  });
});

describe('rules', () => {
  it('falls back to the built-ins when storage refuses to answer', async () => {
    const host = fakeHost();
    host.store.failWith = new Error('storage unavailable');

    const result = await prepareImportFromHost(host.ctx, {
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: ACCOUNT,
    });

    expect(result.rules.status).toBe('fallback');
    // Degraded categorisation does not make the import unsafe.
    expect(result.canImport).toBe(true);
    expect(result.prepared?.rows.length).toBeGreaterThan(0);
  });

  it('uses the user rules when they are readable', async () => {
    const host = fakeHost();
    await host.store.set(StorageKeys.rules, JSON.stringify([]));

    const result = await prepareImportFromHost(host.ctx, {
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: ACCOUNT,
    });

    expect(result.rules.status).toBe('ok');
  });
});

/**
 * El segundo gate, junto al de duplicados.
 *
 * Hasta 0.1.1 `validation.ok` se calculaba y no lo miraba nadie: una cartola con
 * filas ilegibles mostraba el resto de las filas, con el botón de confirmar
 * activo, y escribía en la contabilidad el subconjunto que sí se había podido
 * leer. El usuario veía "importados: 11" sin forma de saber que el archivo
 * tenía 12 movimientos.
 */
describe('cartola inválida', () => {
  const brokenStatement = [
    'Fecha;Descripcion;Cargo;Abono;Saldo',
    '03/02/2026;COMPRA SUPERMERCADO;10.000;;90.000',
    '05/02/2026;FILA IMPOSIBLE;5.000;5.000;85.000',
    '06/02/2026;PAGO SERVICIO;5.000;;80.000',
  ].join('\n');

  it('bloquea la importación aunque el resto de las filas se hayan leído bien', async () => {
    const host = fakeHost();

    const result = await prepareImportFromHost(host.ctx, {
      file: fromText('cartola.csv', brokenStatement),
      accountId: ACCOUNT,
      parserId: 'generico.cuenta',
    });

    expect(result.parse.status).toBe('ok');
    expect(result.duplicateIndex.status).toBe('ready');
    expect(result.prepared?.validation.ok).toBe(false);
    expect(result.canImport).toBe(false);
  });

  it('sigue mostrando la vista previa para que se vea qué se leyó', async () => {
    const host = fakeHost();

    const result = await prepareImportFromHost(host.ctx, {
      file: fromText('cartola.csv', brokenStatement),
      accountId: ACCOUNT,
      parserId: 'generico.cuenta',
    });

    expect(result.prepared?.rows).toHaveLength(2);
  });

  it('dice por qué está bloqueada, con las filas concretas', async () => {
    const host = fakeHost();

    const result = await prepareImportFromHost(host.ctx, {
      file: fromText('cartola.csv', brokenStatement),
      accountId: ACCOUNT,
      parserId: 'generico.cuenta',
    });

    const blocker = result.blockers.find((entry) => entry.code === 'statement-invalid');
    expect(blocker).toBeDefined();
    expect(blocker?.issues.some((issue) => issue.line === 3)).toBe(true);
  });

  it('no bloquea por advertencias', async () => {
    const host = fakeHost();

    // Perfil sin validar (`profile-unverified`) + fecha ambigua: dos warnings,
    // ningún error. Advertir e impedir no son lo mismo.
    const result = await prepareImportFromHost(host.ctx, {
      file: loadFixture('banco-estado-cuentarut.csv'),
      accountId: ACCOUNT,
    });

    expect(result.prepared?.validation.issues.some((i) => i.level === 'warning')).toBe(true);
    expect(result.prepared?.validation.ok).toBe(true);
    expect(result.canImport).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it('acumula los bloqueos en vez de reportar sólo el primero', async () => {
    const host = fakeHost();
    host.searchError = new Error('backend unavailable');

    const result = await prepareImportFromHost(host.ctx, {
      file: fromText('cartola.csv', brokenStatement),
      accountId: ACCOUNT,
      parserId: 'generico.cuenta',
    });

    expect(result.blockers.map((entry) => entry.code).sort()).toEqual([
      'duplicate-check-unavailable',
      'statement-invalid',
    ]);
  });
});
