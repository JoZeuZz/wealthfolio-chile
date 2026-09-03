import { StatementProduct } from '../model/statement';
import { ColumnRole } from '../parsing/columns';
import type { StatementProfile } from '../parsing/profile';
import { createProfileParser } from './profile-parser';
import type { StatementParser } from './parser';

/**
 * Banco de Chile / Edwards.
 *
 * Column wording below comes from the bank's published export documentation and
 * from the layout its web downloads have used historically. It has **not** been
 * checked against a real cartola yet, so both profiles are marked
 * `pending-real-sample`: the wizard warns, the import history records the
 * parser version, and calibrating means editing the synonym lists here.
 *
 * See docs/BANK_FORMATS.md for exactly what is still needed.
 */

export const BANCO_CHILE_CHECKING: StatementProfile = {
  institution: 'banco-chile',
  institutionLabel: 'Banco de Chile — cuenta corriente',
  parserId: 'banco-chile.cuenta-corriente',
  parserVersion: '0.1.0',
  product: StatementProduct.checking,
  defaultCurrency: 'CLP',
  numberFormat: 'es-CL',
  dateOrder: 'DMY',
  // The web export splits movements into cargo/abono columns; `signed` only
  // applies if a single "Monto" column turns up instead, which the row mapper
  // handles on its own.
  amountSign: 'signed',
  columnSynonyms: {
    [ColumnRole.date]: ['Fecha', 'Fecha Transaccion'],
    [ColumnRole.description]: ['Descripcion', 'Detalle', 'Descripción'],
    [ColumnRole.debit]: ['Cargo', 'Cargos (CLP)', 'Cheques y Cargos'],
    [ColumnRole.credit]: ['Abono', 'Abonos (CLP)', 'Depositos y Abonos'],
    [ColumnRole.balance]: ['Saldo', 'Saldo (CLP)'],
    [ColumnRole.reference]: ['N Documento', 'Nro Documento', 'Canal o Sucursal'],
  },
  ignoreRowPatterns: [/^SALDO\s+(INICIAL|FINAL)/i, /^TOTAL/i],
  // Sin una cartola real no hay evidencia de que la columna de saldo camine
  // exacta, así que un desajuste aislado se informa y no bloquea.
  balanceCheck: 'advisory',
  validationStatus: 'pending-real-sample',
  validationNotes:
    'Falta una cartola real (CSV o XLSX) de cuenta corriente para confirmar los nombres exactos de columnas, el separador y si los cargos vienen con signo.',
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
