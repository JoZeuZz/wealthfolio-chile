import { StatementProduct } from '../model/statement';
import { ColumnRole } from '../parsing/columns';
import type { StatementProfile } from '../parsing/profile';
import { createProfileParser } from './profile-parser';
import type { StatementParser } from './parser';

/**
 * Banco Falabella and the CMR card.
 *
 * The CMR statement is where installments matter most: retail in Chile sells
 * almost everything "en cuotas", so a CMR import that misses the cuota markers
 * produces a wildly wrong picture of what is actually committed. The profile
 * therefore maps a dedicated installment column when one exists, and the
 * description detector covers the case where it does not.
 *
 * Marked `pending-real-sample`; see docs/BANK_FORMATS.md.
 */

export const FALABELLA_CARD: StatementProfile = {
  institution: 'banco-falabella',
  institutionLabel: 'Banco Falabella / CMR — tarjeta',
  parserId: 'banco-falabella.cmr',
  parserVersion: '0.1.0',
  product: StatementProduct.credit_card,
  defaultCurrency: 'CLP',
  numberFormat: 'es-CL',
  dateOrder: 'DMY',
  amountSign: 'debit-positive',
  columnSynonyms: {
    [ColumnRole.date]: ['Fecha', 'Fecha Compra', 'Fecha Transaccion'],
    [ColumnRole.description]: ['Descripcion', 'Comercio', 'Detalle Movimiento'],
    // `Monto Total` and `Valor Cuota` used to be listed here as synonyms of the
    // same role, so on a statement carrying both, whichever column came first
    // became the charge. They are different numbers — the whole purchase and
    // this month's instalment — and now have roles of their own.
    [ColumnRole.amount]: ['Monto', 'Monto Operacion'],
    [ColumnRole.installmentAmount]: ['Valor Cuota', 'Monto Cuota'],
    [ColumnRole.purchaseAmount]: ['Monto Total', 'Monto Compra'],
    [ColumnRole.installment]: ['Cuotas', 'Cuota', 'N Cuotas'],
    [ColumnRole.card]: ['Tarjeta', 'N Tarjeta'],
    [ColumnRole.category]: ['Rubro', 'Categoria'],
  },
  ignoreRowPatterns: [/^TOTAL/i, /^CUPO/i, /^PAGO\s+M[IÍ]NIMO/i],
  // Sin una cartola real no hay evidencia de que la columna de saldo camine
  // exacta, así que un desajuste aislado se informa y no bloquea.
  balanceCheck: 'advisory',
  // La exportación real de "Movimientos Facturados" no imprime ningún texto
  // de marca — ni "CMR" ni "FALABELLA" aparecen en ninguna celda de
  // preámbulo, confirmado contra 4 estados de cuenta reales (2026-09) — así
  // que `strongMarkers` nunca dispara y el archivo perdía la detección
  // contra `generico.tarjeta` (45 % vs 55 %). La cabecera completa de 6
  // columnas es, para este layout, la única evidencia de producto que existe
  // — el mismo principio que ya usa `banco-chile.tarjeta` para su tabla
  // internacional. Confirmada exacta contra las 4 muestras reales vía
  // `pnpm calibrate -- <archivo> --parser banco-falabella.cmr` (firma
  // candidata `cmr-movimientos-facturados-v1`), nunca leída directamente.
  recognizedLayoutSignatures: [
    {
      headers: [
        'FECHA',
        'DESCRIPCION',
        'TITULAR/ADICIONAL',
        'MONTO',
        'CUOTAS PENDIENTES',
        'VALOR CUOTA',
      ],
    },
  ],
  validationStatus: 'pending-real-sample',
  validationNotes:
    'Falta un estado de cuenta real de CMR. Sigue sin confirmarse si una columna "Monto" sin etiquetar es el valor de la cuota o el total de la compra; mientras tanto la fila se marca con `ambiguous-installment-amount` y el plan no deriva el total de la compra. Falta también confirmar cómo se marcan los pagos, las anulaciones y los avances en efectivo.',
};

export const FALABELLA_ACCOUNT: StatementProfile = {
  institution: 'banco-falabella',
  institutionLabel: 'Banco Falabella — cuenta corriente',
  parserId: 'banco-falabella.cuenta',
  parserVersion: '0.1.0',
  product: StatementProduct.checking,
  defaultCurrency: 'CLP',
  numberFormat: 'es-CL',
  dateOrder: 'DMY',
  amountSign: 'signed',
  columnSynonyms: {
    [ColumnRole.debit]: ['Cargo', 'Cargos'],
    [ColumnRole.credit]: ['Abono', 'Abonos'],
  },
  // Sin una cartola real no hay evidencia de que la columna de saldo camine
  // exacta, así que un desajuste aislado se informa y no bloquea.
  balanceCheck: 'advisory',
  validationStatus: 'pending-real-sample',
  validationNotes: 'Falta una cartola real de cuenta corriente Falabella.',
};

export const falabellaCardParser: StatementParser = createProfileParser(FALABELLA_CARD, {
  strongMarkers: [/\bCMR\b/i, /FALABELLA/i],
  weakMarkers: [/CUOTAS?\s+SIN\s+INTER[EÉ]S/i, /\bSEGURO\s+CMR\b/i, /AVANCE\s+EN\s+EFECTIVO/i],
  fileNamePatterns: [/cmr/i, /falabella/i, /estado.?cuenta/i],
});

export const falabellaAccountParser: StatementParser = createProfileParser(FALABELLA_ACCOUNT, {
  strongMarkers: [/BANCO\s+FALABELLA/i],
  weakMarkers: [/CUENTA\s+CORRIENTE/i, /\bCARGO\b/i, /\bABONO\b/i],
  fileNamePatterns: [/falabella/i, /cartola/i],
});
