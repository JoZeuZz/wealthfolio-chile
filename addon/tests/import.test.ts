import { describe, expect, it } from 'vitest';
import {
  buildDuplicateIndex,
  classifyDuplicate,
  type ExistingMovement,
} from '../src/core/dedupe/classify';
import { computeFingerprint, computeWeakFingerprint } from '../src/core/dedupe/fingerprint';
import { toActivityCreate, readChileMetadata } from '../src/core/mapping/activities';
import { money, toDecimalString } from '../src/core/money';
import { TransactionKind } from '../src/core/model/kinds';
import { prepareImport, setRowSelection, type PreparedImport } from '../src/core/pipeline';
import { defaultRules } from '../src/core/rules/builtin';
import { fromText, loadFixture, makeTransaction } from './fixtures';

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

    // Posible, no exacto: un archivo que repite una línea y un día con dos
    // compras iguales se ven igual desde aquí. Queda desmarcada de todos modos,
    // pero la etiqueta dice lo que de verdad se sabe y la fila se puede marcar
    // por separado.
    expect(prepared.totals.probableDuplicates).toBe(1);
    expect(prepared.totals.exactDuplicates).toBe(0);
    expect(prepared.totals.toImport).toBe(1);
    expect(prepared.rows[1]?.duplicate.reason_code).toBe('repeated-within-file');
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

    const updated = setRowSelection(prepared, sueldo.key, false);

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

/**
 * La huella no puede depender de cómo el banco escribió los decimales.
 *
 * `toDecimalString` codifica la escala: `{minor:-12345, scale:0}` da `-12345`
 * y `{minor:-1234500, scale:2}` da `-12345.00`. Son el mismo dinero —`equals`
 * de `core/money` lo dice— pero producían huellas distintas, fuerte **y**
 * débil. El mismo período reexportado con `1.234,00` en vez de `1.234` volvía
 * como `nuevo`, ni siquiera como posible duplicado, y se escribía entero por
 * segunda vez con todas las filas marcadas por defecto.
 *
 * Es exactamente el escenario que el encabezado de `money.ts` describe: «la
 * misma cuenta CLP exporta `1.234` en un informe y `1.234,00` en otro».
 */
describe('la huella ignora la escala decimal', () => {
  const base = {
    date: '2026-02-04',
    description: 'COMPRA SUPERMERCADO LIDER',
    kind: TransactionKind.expense,
  };
  const scope = { accountId: 'acc-1' };

  /** The same movement, written with the scale a given export happened to use. */
  const scaled = (minor: number, scale: number) => ({
    ...makeTransaction({ ...base, amount: minor }),
    amount: money(minor, scale, 'CLP'),
  });

  it('el mismo monto con dos escalas produce la misma huella fuerte', () => {
    const withoutDecimals = scaled(-12345, 0);
    const withDecimals = scaled(-1234500, 2);

    expect(computeFingerprint(withDecimals, scope)).toBe(
      computeFingerprint(withoutDecimals, scope),
    );
  });

  it('y la misma huella débil', () => {
    const withoutDecimals = scaled(-12345, 0);
    const withDecimals = scaled(-1234500, 2);

    expect(computeWeakFingerprint(withDecimals, scope)).toBe(
      computeWeakFingerprint(withoutDecimals, scope),
    );
  });

  it('un decimal que no es cero sigue siendo otro movimiento', () => {
    const exact = scaled(-1234500, 2);
    const cents = scaled(-1234550, 2);

    expect(computeFingerprint(cents, scope)).not.toBe(computeFingerprint(exact, scope));
  });

  it('reimportar el mismo período con decimales no duplica nada', () => {
    const asImported = scaled(-12345, 0);
    const index = buildDuplicateIndex([
      {
        fingerprint: computeFingerprint(asImported, scope),
        activityId: 'act-1',
        date: base.date,
        amount: money(-12345, 0, 'CLP'),
        description: base.description,
      },
    ]);

    const reExported = scaled(-1234500, 2);
    const finding = classifyDuplicate(
      { ...reExported, fingerprint: computeFingerprint(reExported, scope) },
      index,
      scope,
      new Map(),
    );

    expect(finding.verdict).toBe('exact');
    expect(finding.reason_code).toBe('exact-fingerprint');
  });
});

/**
 * `IVA` como subcadena.
 *
 * `builtin.impuestos` usaba `contains('IVA')` contra la glosa normalizada, así
 * que `CLINICA PRIVADA`, `CONSULTA PRIVADA` o `UNIVERSIDAD` se clasificaban
 * como impuesto. El total no cambia —el impuesto también es gasto— pero la
 * categoría sí, y una categoría equivocada es un panel que miente sobre en qué
 * se va la plata.
 */
describe('IVA es una palabra, no una subcadena', () => {
  function kindAndCategory(description: string) {
    const prepared = prepareImport({
      file: fromText(
        'cartola.csv',
        ['Fecha;Descripcion;Cargo;Abono', `03/02/2026;${description};10.000;`].join('\n'),
      ),
      accountId: ACCOUNT,
      parserId: 'generico.cuenta',
      rules: defaultRules(),
      duplicateIndex: EMPTY_INDEX,
    });
    const row = prepared.rows[0]?.transaction;
    return { kind: row?.kind, category: row?.category };
  }

  it('una clínica privada no es un impuesto', () => {
    expect(kindAndCategory('CLINICA PRIVADA SANTA MARIA').kind).not.toBe(TransactionKind.tax);
  });

  it('una universidad tampoco', () => {
    expect(kindAndCategory('PAGO UNIVERSIDAD DE CHILE').kind).not.toBe(TransactionKind.tax);
  });

  it('pero el IVA sí', () => {
    expect(kindAndCategory('IVA SERVICIOS BANCARIOS')).toMatchObject({
      kind: TransactionKind.tax,
      category: 'impuestos',
    });
  });

  it('y también en medio de la glosa', () => {
    expect(kindAndCategory('COMISION MAS IVA').kind).toBe(TransactionKind.tax);
  });
});
