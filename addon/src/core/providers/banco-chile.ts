import { StatementProduct } from '../model/statement';
import { ColumnRole } from '../parsing/columns';
import type { StatementProfile } from '../parsing/profile';
import { createProfileParser } from './profile-parser';
import type { StatementParser } from './parser';

/**
 * Banco de Chile / Edwards.
 *
 * `BANCO_CHILE_CARD` (tarjeta) is calibrated 2026-09 against 4 real XLS card
 * cartolas (`Mov_Facturado`), through `pnpm calibrate` only — see its own
 * doc comment below for what that confirmed and what it deliberately still
 * refuses. `pending-real-sample` for the parts calibration could not reach.
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
    'Calibrado contra 8 cartolas reales (XLS): detección, encabezado, fecha sin año (resuelta vía SALDO INICIAL/FINAL + Fecha de Emisión), escala monetaria (scale 2 = ",00" literal, no un error), signo de cargo/abono y saldo declarado (recorrido reconcilia sin descuadres, cero balance-total-mismatch, usando la propia celda Saldo (PESOS) de SALDO INICIAL/FINAL en vez del preámbulo). Falta: clasificación por kind contra glosas reales, no verificable sin verlas.',
};

export const BANCO_CHILE_CARD: StatementProfile = {
  institution: 'banco-chile',
  institutionLabel: 'Banco de Chile — tarjeta de crédito',
  parserId: 'banco-chile.tarjeta',
  parserVersion: '0.2.0',
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
  // La tabla "Movimientos Internacionales" es un layout real distinto, no un
  // error de lectura: su única columna de monto utilizable, "Monto (USD)", no
  // está en la moneda de la cuenta. Ni `matchStatementToAccount` ni
  // `computeTotals` saben hoy representar "cuenta CLP, movimiento USD" sin
  // mentir en alguna parte — mapearla obligaría a etiquetar ese monto como CLP
  // (el bug original) o a declarar el statement entero en USD, que
  // `matchStatementToAccount` compararía contra la tarjeta CLP real como un
  // `account-mismatch` engañoso, y que `computeTotals` no puede sumar junto a
  // nada en CLP sin `MoneyError`. Reconocido por el encabezado exacto —
  // "Monto (USD)" — y rechazado antes de mapear ninguna fila, en vez de
  // importado a medias. `Monto Moneda Origen` no se usa: el archivo no declara
  // en qué moneda está.
  unsupportedLayoutHeaders: [
    {
      header: 'Monto (USD)',
      code: 'foreign-currency-unsupported',
      message:
        'Este archivo contiene movimientos internacionales facturados en USD. Wealthfolio Chile todavía no puede importar movimientos USD dentro de una tarjeta cuya cuenta se modela en CLP sin perder la separación entre moneda de cuenta y moneda de movimiento.',
    },
  ],
  // Sin una cartola real no hay evidencia de que la columna de saldo camine
  // exacta, así que un desajuste aislado se informa y no bloquea.
  balanceCheck: 'advisory',
  validationStatus: 'pending-real-sample',
  validationNotes:
    'Calibrado 2026-09 contra 4 cartolas reales (Mov_Facturado, XLS) vía `pnpm calibrate`, dos layouts estructurales confirmados. "Movimientos Nacionales" (Categoría/Fecha/Descripción/Cuotas/Monto ($)) se mapea en CLP según la evidencia observada. "Movimientos Internacionales" (Categoría/Fecha/Descripción/País/Monto Moneda Origen/Monto (USD)) se reconoce pero queda bloqueado explícitamente (`foreign-currency-unsupported`): la tubería actual no representa cuenta CLP + movimiento USD de forma honesta. `Monto Moneda Origen` no se utiliza; `Monto (USD)` es la columna monetaria relevante de ese layout, pero no se importa todavía. Ningún archivo real trajo ambas tablas a la vez; un archivo que las combinara en una sola hoja no está cubierto (pickDataSheet lee una sola tabla). El preámbulo real sí trae labels de resumen (Monto Facturado, Pago Mínimo, Fecha de Facturación, Pagar Hasta) — `calibrate` todavía no los reconoce/extrae de este layout, no es que la cartola no los traiga. Falta también: cómo se expresan las cuotas y el signo de abono/pago, contra glosas reales.',
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
