import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex, type ExistingMovement } from '../src/core/dedupe/classify';
import { computeFingerprint, computeWeakFingerprint } from '../src/core/dedupe/fingerprint';
import { toActivityCreate, readChileMetadata } from '../src/core/mapping/activities';
import { money, toDecimalString } from '../src/core/money';
import { TransactionKind } from '../src/core/model/kinds';
import { prepareImport, setRowSelection, type PreparedImport } from '../src/core/pipeline';
import { defaultRules } from '../src/core/rules/builtin';
import { fromText, loadFixture } from './fixtures';

const ACCOUNT = 'acct-banco-chile';
const EMPTY_INDEX = buildDuplicateIndex([]);

function prepare(fixture: string, existing: ExistingMovement[] = []): PreparedImport {
  return prepareImport({
    file: loadFixture(fixture),
    accountId: ACCOUNT,
    accountName: 'Cuenta Corriente',
    rules: defaultRules(),
    duplicateIndex: buildDuplicateIndex(existing),
  });
}

/** Turn a prepared import into the "already stored" shape, as a real import would. */
function asExisting(prepared: PreparedImport): ExistingMovement[] {
  return prepared.rows
    .filter((row) => row.willImport)
    .map((row, index) => ({
      fingerprint: row.transaction.fingerprint,
      weakFingerprint: row.weakFingerprint,
      activityId: `activity-${index}`,
      date: row.transaction.date,
      amount: row.transaction.amount,
      description: row.transaction.description,
    }));
}

describe('prepareImport', () => {
  const prepared = prepare('banco-chile-cuenta-corriente.csv');

  it('selects the bank parser automatically', () => {
    expect(prepared.parser.institution).toBe('banco-chile');
  });

  it('marks every row for import on a first run', () => {
    expect(prepared.totals.toImport).toBe(prepared.rows.length);
    expect(prepared.totals.exactDuplicates).toBe(0);
  });

  it('assigns a fingerprint to every row', () => {
    for (const row of prepared.rows) {
      expect(row.transaction.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('gives every row a distinct fingerprint', () => {
    const fingerprints = prepared.rows.map((row) => row.transaction.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('keeps the card payment out of expenses', () => {
    const payment = prepared.rows.find((row) => /PAGO TARJETA/.test(row.transaction.description))!;
    expect(payment.transaction.kind).toBe(TransactionKind.credit_card_payment);
    expect(toDecimalString(prepared.totals.cardPayments)).toBe('120000');
  });

  it('keeps the transfer to the user’s own account out of expenses', () => {
    const transfer = prepared.rows.find((row) => /CUENTA PROPIA/.test(row.transaction.description))!;
    expect(transfer.transaction.kind).toBe(TransactionKind.internal_transfer);
    expect(toDecimalString(prepared.totals.internalTransfers)).toBe('200000');
  });

  it('counts income and expenses without the neutral movements', () => {
    // Income: 1.850.000 salary + 45.000 received transfer.
    expect(toDecimalString(prepared.totals.income)).toBe('1895000');
    // Everything except the 120.000 card payment and the 200.000 own transfer.
    const expected = 85400 + 38500 + 5900 + 9900 + 12340 + 42150 + 7890 + 59990;
    expect(toDecimalString(prepared.totals.expenses)).toBe(String(expected));
  });

  it('categorises via the built-in rules', () => {
    const byDescription = (needle: string) =>
      prepared.rows.find((row) => row.transaction.description.includes(needle))!.transaction;

    expect(byDescription('LIDER').category).toBe('alimentacion.supermercado');
    expect(byDescription('COPEC').category).toBe('transporte.combustible');
    expect(byDescription('NETFLIX').category).toBe('suscripciones');
    expect(byDescription('CRUZ VERDE').category).toBe('salud.farmacia');
    expect(byDescription('COMISION').category).toBe('comisiones');
    expect(byDescription('SUELDO').category).toBe('ingresos.sueldo');
  });

  it('records which rules fired, so a categorisation can be explained', () => {
    const lider = prepared.rows.find((row) => /LIDER/.test(row.transaction.description))!;
    expect(lider.transaction.appliedRules).toContain('builtin.supermercado');
  });

  it('extracts merchants from acquirer noise', () => {
    const lider = prepared.rows.find((row) => /LIDER/.test(row.transaction.description))!;
    expect(lider.transaction.merchant).toBe('Lider');
    expect(lider.transaction.paymentProcessor).toBe('Webpay');
  });
});

describe('idempotency', () => {
  it('produces identical fingerprints across two independent parses', () => {
    const first = prepare('banco-chile-cuenta-corriente.csv');
    const second = prepare('banco-chile-cuenta-corriente.csv');
    expect(second.rows.map((r) => r.transaction.fingerprint)).toEqual(
      first.rows.map((r) => r.transaction.fingerprint),
    );
  });

  it('imports nothing on a second run of the same file', () => {
    const first = prepare('banco-chile-cuenta-corriente.csv');
    const second = prepare('banco-chile-cuenta-corriente.csv', asExisting(first));

    expect(second.totals.exactDuplicates).toBe(first.rows.length);
    expect(second.totals.toImport).toBe(0);
  });

  it('imports only the new rows from an overlapping file', () => {
    const first = prepare('banco-chile-cuenta-corriente.csv');
    const existing = asExisting(first);

    const overlapping = fromText(
      'febrero-marzo.csv',
      [
        'Banco de Chile - Cartola Cuenta Corriente',
        'Cuenta Corriente N: 00-123-45678-90',
        '',
        'Fecha;Descripcion;Cargo;Abono;Saldo;N Documento',
        // Already imported, byte-identical.
        '25/02/2026;UBER *TRIP SANTIAGO;7.890;;1.533.420;900011',
        '28/02/2026;COMPRA EN LINEA MERCADO LIBRE CHILE;59.990;;1.473.430;900012',
        // New.
        '02/03/2026;COMPRA JUMBO VITACURA;44.200;;1.429.230;900013',
      ].join('\n'),
    );

    const second = prepareImport({
      file: overlapping,
      accountId: ACCOUNT,
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex(existing),
    });

    expect(second.totals.exactDuplicates).toBe(2);
    expect(second.totals.toImport).toBe(1);
    expect(second.rows.find((row) => row.willImport)!.transaction.description).toContain('JUMBO');
  });

  it('catches a row the file itself repeats', () => {
    const duplicated = fromText(
      'repetido.csv',
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA LIDER;10.000;;90.000',
        '03/02/2026;COMPRA LIDER;10.000;;90.000',
      ].join('\n'),
    );

    const prepared = prepareImport({
      file: duplicated,
      accountId: ACCOUNT,
      rules: defaultRules(),
      duplicateIndex: EMPTY_INDEX,
    });

    expect(prepared.totals.exactDuplicates).toBe(1);
    expect(prepared.totals.toImport).toBe(1);
  });

  it('scopes identity to the account, so the same charge in two accounts stays two', () => {
    const first = prepare('banco-chile-cuenta-corriente.csv');
    const other = prepareImport({
      file: loadFixture('banco-chile-cuenta-corriente.csv'),
      accountId: 'a-different-account',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex(asExisting(first)),
    });
    expect(other.totals.exactDuplicates).toBe(0);
  });

  it('flags a near-match as probable rather than exact', () => {
    const existing: ExistingMovement[] = [
      {
        activityId: 'a1',
        weakFingerprint: computeWeakFingerprint(
          {
            date: '2026-02-04',
            amount: money(-85400, 0, 'CLP'),
          } as never,
          { accountId: ACCOUNT },
        ),
        date: '2026-02-04',
        amount: money(-85400, 0, 'CLP'),
        // Same movement, described differently by another export.
        description: 'COMPRA WEBPAY SUPERMERCADO LIDER LAS CONDES',
      },
    ];

    const prepared = prepare('banco-chile-cuenta-corriente.csv', existing);
    const lider = prepared.rows.find((row) => /LIDER/.test(row.transaction.description))!;

    expect(lider.duplicate.verdict).toBe('probable');
    expect(lider.willImport).toBe(false);
  });
});

describe('preview selection', () => {
  it('recomputes totals when a row is switched off', () => {
    const prepared = prepare('banco-chile-cuenta-corriente.csv');
    const sueldo = prepared.rows.find((row) => /SUELDO/.test(row.transaction.description))!;

    const updated = setRowSelection(prepared, sueldo.transaction.fingerprint, false);

    expect(updated.totals.toImport).toBe(prepared.totals.toImport - 1);
    expect(toDecimalString(updated.totals.income)).toBe('45000');
  });
});

describe('mapping to Wealthfolio activities', () => {
  const prepared = prepare('banco-chile-cuenta-corriente.csv');
  const runId = 'run-1';

  it('maps income to DEPOSIT with a positive amount', () => {
    const sueldo = prepared.rows.find((row) => /SUELDO/.test(row.transaction.description))!;
    const activity = toActivityCreate(sueldo.transaction, { accountId: ACCOUNT, runId });
    expect(activity.activityType).toBe('DEPOSIT');
    expect(activity.amount).toBe('1850000');
  });

  it('maps spending to WITHDRAWAL with a positive amount', () => {
    const lider = prepared.rows.find((row) => /LIDER/.test(row.transaction.description))!;
    const activity = toActivityCreate(lider.transaction, { accountId: ACCOUNT, runId });
    expect(activity.activityType).toBe('WITHDRAWAL');
    expect(activity.amount).toBe('85400');
  });

  it('maps an internal transfer to TRANSFER_OUT so it nets to zero', () => {
    const transfer = prepared.rows.find((row) => /CUENTA PROPIA/.test(row.transaction.description))!;
    expect(toActivityCreate(transfer.transaction, { accountId: ACCOUNT, runId }).activityType).toBe(
      'TRANSFER_OUT',
    );
  });

  it('maps a card payment to TRANSFER_OUT, never WITHDRAWAL', () => {
    const payment = prepared.rows.find((row) => /PAGO TARJETA/.test(row.transaction.description))!;
    expect(toActivityCreate(payment.transaction, { accountId: ACCOUNT, runId }).activityType).toBe(
      'TRANSFER_OUT',
    );
  });

  it('maps a bank fee to FEE', () => {
    const fee = prepared.rows.find((row) => /COMISION/.test(row.transaction.description))!;
    expect(toActivityCreate(fee.transaction, { accountId: ACCOUNT, runId }).activityType).toBe(
      'FEE',
    );
  });

  it('round-trips the fingerprint through activity metadata', () => {
    const row = prepared.rows[0]!;
    const activity = toActivityCreate(row.transaction, {
      accountId: ACCOUNT,
      runId,
      weakFingerprint: row.weakFingerprint,
    });
    const metadata = readChileMetadata(activity.metadata as Record<string, unknown>);

    expect(metadata?.fp).toBe(row.transaction.fingerprint);
    expect(metadata?.wfp).toBe(row.weakFingerprint);
    expect(metadata?.runId).toBe(runId);
    expect(metadata?.parserVersion).toBe(row.transaction.sourceParserVersion);
  });

  it('rebuilds the duplicate index from stored metadata', () => {
    const row = prepared.rows[0]!;
    const activity = toActivityCreate(row.transaction, { accountId: ACCOUNT, runId });
    const metadata = readChileMetadata(activity.metadata as Record<string, unknown>)!;

    const index = buildDuplicateIndex([
      {
        fingerprint: metadata.fp,
        activityId: 'a1',
        date: row.transaction.date,
        amount: row.transaction.amount,
        description: row.transaction.description,
      },
    ]);

    expect(index.byFingerprint.has(computeFingerprint(row.transaction, { accountId: ACCOUNT }))).toBe(
      true,
    );
  });
});
