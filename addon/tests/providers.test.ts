import { describe, expect, it } from 'vitest';
import { computeFileHash } from '../src/core/dedupe/fingerprint';
import { METADATA_NAMESPACE, toActivityCreate } from '../src/core/mapping/activities';
import { toDecimalString } from '../src/core/money';
import { Direction, TransactionKind } from '../src/core/model/kinds';
import { loadWorkbook } from '../src/core/parsing/workbook';
import { detectAll, getParser, listInstitutions, PARSERS } from '../src/core/providers/registry';
import type { ParserInput } from '../src/core/providers/parser';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { prepareImport } from '../src/core/pipeline';
import { defaultRules } from '../src/core/rules/builtin';
import { fromText, fromXlsxRows, loadFixture } from './fixtures';
import type { SourceFile } from '../src/core/parsing/tabular';

function inputForFile(file: SourceFile): ParserInput {
  return { file, sheets: loadWorkbook(file).sheets, fileHash: computeFileHash(file.bytes) };
}

function inputFor(name: string): ParserInput {
  return inputForFile(loadFixture(name));
}

describe('registry', () => {
  it('exposes unique parser ids', () => {
    const ids = PARSERS.map((parser) => parser.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('groups parsers by institution for the picker', () => {
    const institutions = listInstitutions().map((entry) => entry.id);
    expect(institutions).toContain('banco-chile');
    expect(institutions).toContain('banco-estado');
    expect(institutions).toContain('banco-falabella');
    expect(institutions).toContain('generico');
  });
});

describe('detection', () => {
  it('ranks Banco de Chile first for its own cartola', () => {
    const detections = detectAll(inputFor('banco-chile-cuenta-corriente.csv'));
    expect(detections[0]!.institution).toBe('banco-chile');
    expect(detections[0]!.score).toBeGreaterThan(0.7);
  });

  it('ranks BancoEstado first for a CuentaRUT export', () => {
    const detections = detectAll(inputFor('banco-estado-cuentarut.csv'));
    expect(detections[0]!.institution).toBe('banco-estado');
  });

  it('ranks Falabella first for a CMR statement', () => {
    const detections = detectAll(inputFor('falabella-cmr.csv'));
    expect(detections[0]!.institution).toBe('banco-falabella');
  });

  it('still offers the generic parser for an unbranded file', () => {
    const file = fromText(
      'export.csv',
      ['Fecha;Descripcion;Cargo;Abono;Saldo', '03/02/2026;COMPRA ALGO;1.000;;9.000'].join('\n'),
    );
    const detections = detectAll({
      file,
      sheets: loadWorkbook(file).sheets,
      fileHash: computeFileHash(file.bytes),
    });
    expect(detections.length).toBeGreaterThan(0);
    expect(detections.some((d) => d.institution === 'generico')).toBe(true);
  });

  it('does not mistake a cartola for a card statement because a row mentions a card', () => {
    // Regression: marker scanning used to read the movement rows, so the single
    // `PAGO TARJETA DE CREDITO CMR` line made the card parser outrank the
    // current-account one — and every purchase came back classified as a
    // credit-card charge.
    const detections = detectAll(inputFor('banco-chile-cuenta-corriente.csv'));
    expect(detections[0]!.parser).toBe('banco-chile.cuenta-corriente');
  });

  it('prefers a card parser when the file has cuotas and no balance column', () => {
    const detections = detectAll(inputFor('falabella-cmr.csv'));
    expect(detections[0]!.parser).toBe('banco-falabella.cmr');
  });

  it('reports zero for a file with no usable header', () => {
    const file = fromText('ruido.csv', 'hola;mundo\notra;fila');
    const detections = detectAll({
      file,
      sheets: loadWorkbook(file).sheets,
      fileHash: computeFileHash(file.bytes),
    });
    expect(detections).toHaveLength(0);
  });
});

describe('Banco de Chile parser', () => {
  const parser = getParser('banco-chile.cuenta-corriente')!;
  const statement = parser.parse(inputFor('banco-chile-cuenta-corriente.csv'));

  it('reads every movement row and skips the totals line', () => {
    expect(statement.transactions).toHaveLength(12);
  });

  it('signs cargos negative and abonos positive', () => {
    const sueldo = statement.transactions[0]!;
    expect(sueldo.direction).toBe(Direction.in);
    expect(toDecimalString(sueldo.amount)).toBe('1850000');

    const compra = statement.transactions[1]!;
    expect(compra.direction).toBe(Direction.out);
    expect(toDecimalString(compra.amount)).toBe('-85400');
  });

  it('recovers the account number and period from the preamble', () => {
    expect(statement.account.number).toBe('00-123-45678-90');
    expect(statement.period).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('carries the running balance', () => {
    expect(toDecimalString(statement.transactions[0]!.balanceAfter!)).toBe('2010500');
  });

  it('flags the profile as awaiting a real sample', () => {
    expect(statement.issues.some((issue) => issue.code === 'profile-unverified')).toBe(true);
  });

  it('validates the balance walk', () => {
    const result = parser.validate(statement);
    expect(result.summary.balanceReconciles).toBe(true);
  });
});

describe('BancoEstado parser', () => {
  const parser = getParser('banco-estado.cuenta')!;
  const statement = parser.parse(inputFor('banco-estado-cuentarut.csv'));

  it('skips the SALDO ANTERIOR row', () => {
    expect(statement.transactions).toHaveLength(8);
    expect(statement.transactions.some((t) => /SALDO ANTERIOR/i.test(t.description))).toBe(false);
  });

  it('reads the transfer that arrives from the other bank', () => {
    const abono = statement.transactions.find((t) => /ABONO TRANSFERENCIA/.test(t.description))!;
    expect(abono.direction).toBe(Direction.in);
    expect(toDecimalString(abono.amount)).toBe('200000');
  });

  it('walks the declared balances without a mismatch', () => {
    expect(parser.validate(statement).summary.balanceReconciles).toBe(true);
  });
});

/**
 * The date layout a real CuentaRUT export actually has (calibrated 2026-09):
 * the date cell carries no year, and the period is declared in the preamble
 * without the `DESDE`/`PERÍODO` wording `readPeriod` looked for until now.
 * This used to make the file unimportable — every transaction row failed
 * with "no se pudo leer la fecha". Confirmed against the real file with
 * `pnpm calibrate`; this fixture is the synthetic equivalent, not the file
 * itself — see docs/REAL_SAMPLE_WORKFLOW.md. Amounts here stay dot-formatted
 * (the CSV convention this profile already assumed); the comma-thousands
 * quirk below is XLSX-specific and covered separately.
 */
describe('BancoEstado parser — fecha sin año en un CSV', () => {
  const parser = getParser('banco-estado.cuenta')!;
  const statement = parser.parse(inputFor('banco-estado-cuentarut-sin-ano.csv'));

  it('reads every movement row, none failed', () => {
    expect(statement.rowStats).toMatchObject({ failed: 0 });
    expect(statement.transactions).toHaveLength(6);
  });

  it('infers the year from the period declared without a DESDE/PERÍODO keyword', () => {
    expect(statement.period).toEqual({ from: '2025-09-01', to: '2025-09-24' });
    expect(statement.transactions[0]!.date).toBe('2025-09-03');
    expect(statement.transactions[5]!.date).toBe('2025-09-24');
  });

  it('walks the balance column without a mismatch', () => {
    expect(parser.validate(statement).summary.balanceReconciles).toBe(true);
  });

  it('skips the TOTAL footer and the trailing note', () => {
    expect(statement.rowStats.skipped).toBeGreaterThanOrEqual(3);
    expect(statement.transactions.some((t) => /TOTAL/.test(t.description))).toBe(false);
  });
});

describe('BancoEstado parser — período declarado', () => {
  it('uses Fecha Inicio and Fecha Final to infer a year-less movement date', () => {
    const parser = getParser('banco-estado.cuenta')!;
    const file = fromText(
      'cuentarut-fecha-final.csv',
      [
        'BancoEstado',
        'Fecha Inicio;01/09/2025;Fecha Final;24/09/2025',
        '',
        'Fecha;N Documento;Descripcion;Abono;Cargo;Saldo',
        '03/sep;900101;COMPRA SINTETICA;;12.450;137.550',
      ].join('\n'),
    );

    const statement = parser.parse(inputForFile(file));

    expect(statement.period).toEqual({ from: '2025-09-01', to: '2025-09-24' });
    expect(statement.transactions[0]?.date).toBe('2025-09-03');
    expect(parser.validate(statement).ok).toBe(true);
  });

  it('does not treat an unlabelled preamble date pair as the statement period', () => {
    const parser = getParser('banco-estado.cuenta')!;
    const file = fromText(
      'cuentarut-sin-periodo.csv',
      [
        'BancoEstado',
        'Fechas informativas 01/08/2025 y 31/08/2025',
        '',
        'Fecha;N Documento;Descripcion;Abono;Cargo;Saldo',
        '03/sep;900101;COMPRA SINTETICA;;12.450;137.550',
      ].join('\n'),
    );

    const statement = parser.parse(inputForFile(file));

    expect(statement.period).toEqual({});
    expect(statement.rowStats.failed).toBe(1);
  });

  it('rejects an inverted labelled period instead of using it to infer a year', () => {
    const parser = getParser('banco-estado.cuenta')!;
    const file = fromText(
      'cuentarut-periodo-invertido.csv',
      [
        'BancoEstado',
        'Fecha Inicio;24/09/2025;Fecha Termino;01/09/2025',
        '',
        'Fecha;N Documento;Descripcion;Abono;Cargo;Saldo',
        '03/sep;900101;COMPRA SINTETICA;;12.450;137.550',
      ].join('\n'),
    );

    const statement = parser.parse(inputForFile(file));

    expect(statement.period).toEqual({});
    expect(parser.validate(statement).ok).toBe(false);
  });
});

/**
 * The exact real-file shape: an XLSX (not CSV) whose `Cargo`/`Abono` cells
 * print a comma thousands separator while `Saldo`, in the same row, prints a
 * dot. Built in-memory with `fromXlsxRows` so the magic-byte detection that
 * scopes `spreadsheetColumnNumberFormats` to spreadsheet sources is genuinely
 * exercised, not assumed from a `.csv` extension. Confirmed against the real
 * file by reconciling the balance walk under both readings of the comma
 * (thousands-separator: 35/35 steps matched; decimal-mark: 0/35).
 */
describe('BancoEstado parser — XLSX real con coma en Cargo/Abono', () => {
  const parser = getParser('banco-estado.cuenta')!;
  const file = fromXlsxRows('cuentarut.xlsx', [
    ['BancoEstado'],
    ['CuentaRUT N: 87654321'],
    ['Titular', 'CLIENTE SINTETICO'],
    ['Fecha Inicio', '01/09/2025', 'Fecha Termino', '24/09/2025'],
    [],
    ['Fecha', 'N Documento', 'Descripcion', 'Abono', 'Cargo', 'Saldo'],
    ['03/sep', '900101', 'COMPRA SINTETICA SUPERMERCADO', '', '12,450', '137.550'],
    ['05/sep', '900102', 'ABONO TRANSFERENCIA SINTETICA', '45,000', '', '182.550'],
    ['09/sep', '900103', 'GIRO CAJERO SINTETICO', '', '20,000', '162.550'],
    ['15/sep', '900104', 'PAGO SERVICIO SINTETICO', '', '8,900', '153.650'],
    ['20/sep', '900105', 'COMPRA SINTETICA FARMACIA', '', '3,200', '150.450'],
    ['24/sep', '900106', 'ABONO DEVOLUCION SINTETICA', '5,000', '', '155.450'],
    ['', '', 'TOTAL CARGOS Y ABONOS DEL PERIODO $', '44.550', '49.650', ''],
    ['NOTA:', '', '', '', '', ''],
    ['Este documento es una representacion sintetica sin valor real.', '', '', '', '', ''],
  ]);
  const statement = parser.parse(inputForFile(file));

  it('reads every movement row, none failed', () => {
    expect(statement.rowStats).toMatchObject({ failed: 0 });
    expect(statement.transactions).toHaveLength(6);
  });

  it('reads a comma-thousands Cargo as pesos, not as a decimal fraction', () => {
    const compra = statement.transactions[0]!;
    expect(compra.direction).toBe(Direction.out);
    expect(toDecimalString(compra.amount)).toBe('-12450');
  });

  it('keeps dot-thousands Cargo under the statement format', () => {
    const file = fromXlsxRows('cuentarut-dot-thousands.xlsx', [
      ['BancoEstado'],
      ['Fecha Inicio', '01/09/2025', 'Fecha Termino', '24/09/2025'],
      [],
      ['Fecha', 'N Documento', 'Descripcion', 'Abono', 'Cargo', 'Saldo'],
      ['03/sep', '900101', 'COMPRA SINTETICA', '', '12.450', '137.550'],
    ]);

    const statement = parser.parse(inputForFile(file));
    expect(statement.transactions[0]?.amount).toMatchObject({ minor: -12450, scale: 0 });
  });

  it('reads a comma-thousands Abono the same way', () => {
    const abono = statement.transactions.find((t) => /ABONO TRANSFERENCIA/.test(t.description))!;
    expect(abono.direction).toBe(Direction.in);
    expect(toDecimalString(abono.amount)).toBe('45000');
  });

  it('walks the dot-formatted balance column without a mismatch', () => {
    expect(parser.validate(statement).summary.balanceReconciles).toBe(true);
  });
});

/**
 * The comma override is scoped to spreadsheet sources on purpose: nothing has
 * confirmed it for a `.csv` export of the same bank. A CSV that happened to
 * use a comma would be an entirely new, unconfirmed layout question, not this
 * one — so it stays read at the profile's default `es-CL` and is refused as
 * malformed rather than silently guessed at.
 */
describe('BancoEstado parser — la coma no se asume fuera de XLSX', () => {
  it('blocks an ambiguous comma amount and records parser version 0.2.0 in metadata', () => {
    const parser = getParser('banco-estado.cuenta')!;
    const file = fromText(
      'cuentarut.csv',
      [
        'BancoEstado',
        'Fecha Inicio;01/09/2025;Fecha Termino;24/09/2025',
        '',
        'Fecha;N Documento;Descripcion;Abono;Cargo;Saldo',
        '03/sep;900101;COMPRA SINTETICA;;12,450;137.550',
      ].join('\n'),
    );
    const statement = parser.parse(inputForFile(file));
    const compra = statement.transactions[0]!;
    // es-CL reads a lone comma with a 3-digit tail as the (ambiguous) decimal
    // mark, not as thousands — a thousand-fold misread this test pins down
    // as a known, flagged limitation of the CSV path, not a silent one.
    expect(toDecimalString(compra.amount)).not.toBe('-12450');
    expect(compra.warnings.some((w) => w.code === 'ambiguous-amount-format')).toBe(true);
    expect(parser.validate(statement).ok).toBe(false);

    const activity = toActivityCreate(compra, {
      accountId: 'acc-synthetic',
      runId: 'run-synthetic',
    });
    if (typeof activity.metadata !== 'string') throw new Error('expected serialized metadata');
    const metadata = JSON.parse(activity.metadata) as Record<string, { parserVersion?: string }>;
    expect(metadata[METADATA_NAMESPACE]?.parserVersion).toBe('0.2.0');
  });
});

describe('Falabella CMR parser', () => {
  const parser = getParser('banco-falabella.cmr')!;
  const statement = parser.parse(inputFor('falabella-cmr.csv'));

  it('treats card charges as purchases, not generic expenses', () => {
    const purchase = statement.transactions[0]!;
    expect(purchase.kind).toBe(TransactionKind.credit_card_purchase);
    expect(purchase.direction).toBe(Direction.out);
  });

  it('inverts the sign so a positive charge is an outflow', () => {
    expect(toDecimalString(statement.transactions[0]!.amount)).toBe('-49990');
  });

  it('treats a negative charge as money coming back to the card', () => {
    const payment = statement.transactions.find((t) => /PAGO RECIBIDO/.test(t.description))!;
    expect(payment.direction).toBe(Direction.in);
    expect(toDecimalString(payment.amount)).toBe('120000');
  });

  it('reads the installment counter from the dedicated column', () => {
    const cuota = statement.transactions[0]!;
    expect(cuota.installment).toMatchObject({ current: 2, total: 6, confidence: 'confirmed' });
  });

  it('reads a bare counter from the description as a suggestion only', () => {
    const ripley = statement.transactions.find((t) => /RIPLEY/.test(t.description))!;
    expect(ripley.installment).toMatchObject({ current: 1, total: 3 });
  });
});

/**
 * Los dos perfiles que nunca había leído ningún test.
 *
 * `banco-chile.tarjeta` y `banco-falabella.cuenta` existían en el registro,
 * aparecían en el selector del wizard y jamás habían parseado un archivo. Que
 * un perfil compile no dice nada sobre si mapea las columnas que dice mapear.
 */
describe('Banco de Chile — tarjeta de crédito', () => {
  const prepared = () =>
    prepareImport({
      file: loadFixture('banco-chile-tarjeta.csv'),
      accountId: 'acc-card',
      parserId: 'banco-chile.tarjeta',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });

  it('se detecta a sí mismo por encima del resto', () => {
    const detections = detectAll(inputFor('banco-chile-tarjeta.csv'));
    expect(detections[0]?.parser).toBe('banco-chile.tarjeta');
  });

  it('lee los siete movimientos y descarta el encabezado', () => {
    expect(prepared().statement.rowStats).toMatchObject({ mapped: 7, failed: 0 });
  });

  it('invierte el signo: un cargo positivo es dinero que sale', () => {
    const compra = prepared().rows.find((r) =>
      r.transaction.description.includes('SUPERMERCADO SINTETICO PROVIDENCIA'),
    );
    expect(compra?.transaction.amount.minor).toBe(-38500);
    expect(compra?.transaction.kind).toBe(TransactionKind.credit_card_purchase);
  });

  it('distingue el pago recibido de la devolución', () => {
    const rows = prepared().rows;
    const pago = rows.find((r) => r.transaction.description.includes('PAGO RECIBIDO'));
    const devolucion = rows.find((r) => r.transaction.description.includes('DEVOLUCION'));

    expect(pago?.transaction.kind).toBe(TransactionKind.credit_card_payment);
    expect(devolucion?.transaction.kind).toBe(TransactionKind.refund);
  });

  it('separa comisión de interés', () => {
    const rows = prepared().rows;
    expect(rows.find((r) => r.transaction.description.includes('COMISION'))?.transaction.kind).toBe(
      TransactionKind.fee,
    );
    expect(rows.find((r) => r.transaction.description.includes('INTERESES'))?.transaction.kind).toBe(
      TransactionKind.interest,
    );
  });

  it('lee la cuota y admite no saber si el monto es la cuota o la compra', () => {
    const cuota = prepared().rows.find((r) => r.transaction.installment !== undefined);
    expect(cuota?.transaction.installment).toMatchObject({ current: 2, total: 3 });
    // El estado de cuenta no etiqueta la columna, así que la incertidumbre viaja
    // con la fila en vez de resolverse por suposición.
    expect(cuota?.transaction.warnings.map((w) => w.code)).toContain(
      'ambiguous-installment-amount',
    );
  });

  it('sigue marcado como pendiente de una cartola real', () => {
    expect(prepared().parser.profile.validationStatus).toBe('pending-real-sample');
  });
});

/**
 * Movimientos Internacionales es un layout real de Banco de Chile, no un
 * error de lectura: su única columna de monto utilizable, "Monto (USD)", no
 * está en la moneda de la cuenta. Mapearla obligaría a mentir en algún punto
 * de la tubería — ver `banco-chile-tarjeta-currency.test.ts` para la
 * evidencia (`account-mismatch` engañoso o `MoneyError`) — así que el layout
 * se reconoce por su encabezado exacto y se rechaza antes de mapear ninguna
 * fila. Layout confirmado contra un archivo real de Banco de Chile
 * (`samples/private/Banco de Chile/Mov_Facturado*.xls`, nunca abierto más
 * allá de su forma estructural: nombres de columna, no valores).
 */
describe('Banco de Chile — tarjeta, movimientos internacionales (no soportado)', () => {
  const parser = getParser('banco-chile.tarjeta')!;
  const file = fromXlsxRows('mov-facturado-internacional.xlsx', [
    ['Banco de Chile'],
    ['Titular', 'CLIENTE SINTETICO'],
    [],
    ['Movimientos Internacionales'],
    ['', 'Categoría', '', 'Fecha', 'Descripción', '', 'País', 'Monto Moneda Origen', 'Monto (USD)'],
    ['', 'VIAJES', '', '05/02/2026', 'HOTEL SINTETICO MIAMI', '', 'ESTADOS UNIDOS', '48,00', '52,30'],
  ]);
  const statement = parser.parse(inputForFile(file));

  it('no produce ninguna transacción', () => {
    expect(statement.transactions).toHaveLength(0);
  });

  it('reporta foreign-currency-unsupported como error', () => {
    const issue = statement.issues.find((i) => i.code === 'foreign-currency-unsupported');
    expect(issue?.level).toBe('error');
  });

  it('no reporta además no-transactions', () => {
    expect(statement.issues.some((i) => i.code === 'no-transactions')).toBe(false);
  });

  it('la cuenta del statement sigue en CLP, nunca declarada USD', () => {
    expect(statement.account.currency).toBe('CLP');
  });

  it('la validación falla', () => {
    expect(parser.validate(statement).ok).toBe(false);
  });
});

describe('Banco Falabella — cuenta corriente', () => {
  const prepared = () =>
    prepareImport({
      file: loadFixture('banco-falabella-cuenta.csv'),
      accountId: 'acc-1',
      parserId: 'banco-falabella.cuenta',
      rules: defaultRules(),
      duplicateIndex: buildDuplicateIndex([]),
    });

  it('descarta la fila de saldo anterior', () => {
    expect(prepared().statement.rowStats).toMatchObject({ mapped: 5, skipped: 1, failed: 0 });
  });

  it('firma cargos y abonos en la dirección correcta', () => {
    const rows = prepared().rows;
    expect(rows.find((r) => r.transaction.description.includes('SUELDO'))?.transaction.amount.minor)
      .toBe(1150000);
    expect(
      rows.find((r) => r.transaction.description.includes('SUPERMERCADO'))?.transaction.amount.minor,
    ).toBe(-52300);
  });

  it('un pago de tarjeta desde la cuenta no es un gasto', () => {
    const pago = prepared().rows.find((r) => r.transaction.description.includes('PAGO TARJETA'));
    expect(pago?.transaction.kind).toBe(TransactionKind.credit_card_payment);
  });

  it('cuadra el recorrido de saldos declarado', () => {
    expect(prepared().validation.summary.balanceReconciles).toBe(true);
    expect(prepared().validation.ok).toBe(true);
  });

  it('recupera el número de cuenta del encabezado', () => {
    expect(prepared().statement.account.number).toBe('000-987654-32');
  });
});
