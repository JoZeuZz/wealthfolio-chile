import { StatementProduct } from '../model/statement';
import { ColumnRole } from '../parsing/columns';
import type { StatementProfile } from '../parsing/profile';
import { createProfileParser } from './profile-parser';
import type { StatementParser } from './parser';

/**
 * Banco de Chile / Edwards.
 *
 * `BANCO_CHILE_CARD` (tarjeta) is still written against published export
 * documentation, not a real cartola — `pending-real-sample` for that reason.
 *
 * `BANCO_CHILE_CHECKING` (cuenta corriente) is calibrated 2026-09 against 8
 * real XLS cuenta corriente cartolas. Confirmed structure:
 *
 * - header: `Fecha | Descripcion | Canal o Sucursal | Cargos (PESOS) |
 *   Abonos (PESOS) | Saldo (PESOS)`;
 * - the movement date cell is `dd/mm`, no year;
 * - the preamble states a single `Fecha de Emisión: dd/mm/yyyy`, never a
 *   `Período: desde ... hasta ...`;
 * - the first and last accounting rows are always `SALDO INICIAL` /
 *   `SALDO FINAL`, and `SALDO FINAL`'s `dd/mm` always shares its day/month
 *   with the emission date (true in all 8 samples, one of them a
 *   December-to-January cartola) — see `periodFromBalanceRows` below and
 *   `derivePeriodFromBalanceRows` (core/providers/profile-parser.ts).
 *
 * Still unconfirmed by these 8 samples: monetary scale, cargo/abono sign,
 * balance-walk reconciliation and transaction-kind classification — see
 * docs/BANK_FORMATS.md for the exact remaining scope. `validationStatus`
 * stays `pending-real-sample` until those are checked too.
 */

export const BANCO_CHILE_CHECKING: StatementProfile = {
  institution: 'banco-chile',
  institutionLabel: 'Banco de Chile — cuenta corriente',
  parserId: 'banco-chile.cuenta-corriente',
  parserVersion: '0.2.0',
  product: StatementProduct.checking,
  defaultCurrency: 'CLP',
  numberFormat: 'es-CL',
  dateOrder: 'DMY',
  // Confirmado 2026-09 contra 8 cartolas reales: la fecha de movimiento es
  // "dd/mm" sin año.
  dateOmitsYear: true,
  // El preámbulo nunca declara un período `desde/hasta`; el año sale de
  // `SALDO INICIAL`/`SALDO FINAL` y de la `Fecha de Emisión` — ver
  // `derivePeriodFromBalanceRows`. Sin las tres cosas, o si `SALDO FINAL` no
  // comparte día/mes con la emisión, la fila falla en vez de adivinar el año.
  periodFromBalanceRows: {
    openingLabel: /^SALDO\s+INICIAL/i,
    closingLabel: /^SALDO\s+FINAL/i,
    emissionDateLabel: /FECHA\s+DE?\s*EMISI[OÓ]N/i,
  },
  // The web export splits movements into cargo/abono columns; `signed` only
  // applies if a single "Monto" column turns up instead, which the row mapper
  // handles on its own.
  amountSign: 'signed',
  columnSynonyms: {
    [ColumnRole.date]: ['Fecha', 'Fecha Transaccion'],
    [ColumnRole.description]: ['Descripcion', 'Detalle', 'Descripción'],
    // Confirmado: cuenta corriente no trae una columna de número de documento;
    // "Canal o Sucursal" es el canal de la operación, no un identificador de
    // movimiento — mapearla como `reference` metía el canal (p. ej.
    // "INTERNET") dentro del fingerprint fuerte, y dos exportes del mismo
    // movimiento con el canal formateado distinto dejaban de verse como el
    // mismo movimiento.
    [ColumnRole.operationType]: ['Canal o Sucursal', 'Canal', 'Sucursal'],
    [ColumnRole.debit]: ['Cargo', 'Cargos (CLP)', 'Cargos (PESOS)', 'Cheques y Cargos'],
    [ColumnRole.credit]: ['Abono', 'Abonos (CLP)', 'Abonos (PESOS)', 'Depositos y Abonos'],
    [ColumnRole.balance]: ['Saldo', 'Saldo (CLP)', 'Saldo (PESOS)'],
    [ColumnRole.reference]: ['N Documento', 'Nro Documento'],
  },
  ignoreRowPatterns: [/^SALDO\s+(INICIAL|FINAL)/i, /^TOTAL/i],
  // Sin una cartola real no hay evidencia de que la columna de saldo camine
  // exacta, así que un desajuste aislado se informa y no bloquea.
  balanceCheck: 'advisory',
  validationStatus: 'pending-real-sample',
  validationNotes:
    'Calibrado contra 8 cartolas reales (XLS): detección, encabezado, fecha sin año (resuelta vía SALDO INICIAL/FINAL + Fecha de Emisión), escala monetaria (scale 2 = ",00" literal, no un error) y signo de cargo/abono (recorrido de saldo reconcilia sin descuadres en 96 pasos). Falta: clasificación por kind contra glosas reales (no verificable sin verlas), y un aviso balance-total-mismatch sin explicar (ver docs/BANK_FORMATS.md).',
};

export const BANCO_CHILE_CARD: StatementProfile = {
  institution: 'banco-chile',
  institutionLabel: 'Banco de Chile — tarjeta de crédito',
  parserId: 'banco-chile.tarjeta',
  parserVersion: '0.1.0',
  product: StatementProduct.credit_card,
  defaultCurrency: 'CLP',
  numberFormat: 'es-CL',
  dateOrder: 'DMY',
  amountSign: 'debit-positive',
  columnSynonyms: {
    [ColumnRole.date]: ['Fecha', 'Fecha Compra', 'Fecha Operacion'],
    [ColumnRole.description]: ['Descripcion', 'Comercio', 'Detalle'],
    [ColumnRole.amount]: ['Monto', 'Monto Operacion', 'Monto ($)'],
    [ColumnRole.installment]: ['Cuotas', 'Cuota'],
    [ColumnRole.card]: ['Tarjeta', 'N Tarjeta'],
  },
  // Sin una cartola real no hay evidencia de que la columna de saldo camine
  // exacta, así que un desajuste aislado se informa y no bloquea.
  balanceCheck: 'advisory',
  validationStatus: 'pending-real-sample',
  validationNotes:
    'Falta un estado de cuenta real de tarjeta para confirmar cómo se expresan las cuotas y si los abonos (pagos) vienen en la misma columna con signo.',
};

export const bancoChileCheckingParser: StatementParser = createProfileParser(
  BANCO_CHILE_CHECKING,
  {
    strongMarkers: [/BANCO\s+DE\s+CHILE/i, /\bBANCHILE\b/i, /BANCO\s+EDWARDS/i],
    weakMarkers: [/CHEQUES?\s+Y\s+CARGOS/i, /DEP[OÓ]SITOS?\s+Y\s+ABONOS/i, /CANAL\s+O\s+SUCURSAL/i],
    fileNamePatterns: [/cartola/i, /movimientos/i],
  },
);

export const bancoChileCardParser: StatementParser = createProfileParser(BANCO_CHILE_CARD, {
  strongMarkers: [/BANCO\s+DE\s+CHILE/i, /\bBANCHILE\b/i],
  weakMarkers: [/TARJETA\s+DE\s+CR[EÉ]DITO/i, /FACTURACI[OÓ]N/i, /CUPO\s+(?:TOTAL|UTILIZADO)/i],
  fileNamePatterns: [/tarjeta/i, /estado.?cuenta/i],
});
