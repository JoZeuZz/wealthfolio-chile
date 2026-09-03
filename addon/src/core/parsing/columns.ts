import { foldCase } from '../text';
import { isBlankRow, type Sheet } from './tabular';

/**
 * Column-role resolution.
 *
 * Bank exports disagree on everything: header wording, header position, whether
 * amounts live in one signed column or two (cargo/abono). This module reduces
 * all of that to a `ColumnMap` — role -> column index — which is the only thing
 * the row mapper needs.
 */

/** The semantic roles a statement column can play. */
export const ColumnRole = {
  date: 'date',
  postedDate: 'postedDate',
  description: 'description',
  /** One signed column carrying both directions. */
  amount: 'amount',
  /**
   * The amount charged *this period* for an installment purchase.
   *
   * Separate from `amount` because on a card statement `MONTO TOTAL` and
   * `VALOR CUOTA` are different numbers and both used to map to the same role,
   * so whichever column came first won. Charging the whole purchase every month
   * overstates the month by a factor of the plan length, and deriving the
   * purchase back out of it overstates that by the same factor again.
   */
  installmentAmount: 'installmentAmount',
  /** The full purchase an installment charge belongs to. */
  purchaseAmount: 'purchaseAmount',
  /** Outflow-only column (cargo / débito / giro). */
  debit: 'debit',
  /** Inflow-only column (abono / crédito / depósito). */
  credit: 'credit',
  balance: 'balance',
  reference: 'reference',
  operationType: 'operationType',
  currency: 'currency',
  /** Column carrying "3 de 12" style installment counters. */
  installment: 'installment',
  /** Column carrying the card number the charge belongs to. */
  card: 'card',
  /** Bank-provided category, used only as a hint. */
  category: 'category',
  /** Explicit direction marker column (CARGO/ABONO as a value). */
  directionFlag: 'directionFlag',
} as const;

export type ColumnRole = (typeof ColumnRole)[keyof typeof ColumnRole];

export type ColumnMap = Partial<Record<ColumnRole, number>>;

/**
 * Header synonyms, folded to accent-free uppercase.
 *
 * Order matters within a role: the first entry that matches wins, so the most
 * specific wording is listed first. `DESCRIPCION` must not be allowed to claim
 * a column literally headed `DESCRIPCION MOVIMIENTO` before the exact match is
 * considered, which is why matching is exact-first, then prefix, then contains.
 */
const SYNONYMS: Record<ColumnRole, string[]> = {
  date: [
    'FECHA',
    'FECHA TRANSACCION',
    'FECHA DE TRANSACCION',
    'FECHA MOVIMIENTO',
    'FECHA OPERACION',
    'FECHA COMPRA',
    'FECHA TRX',
    'DATE',
  ],
  postedDate: [
    'FECHA CONTABLE',
    'FECHA DE CONTABILIZACION',
    'FECHA PROCESO',
    'FECHA ABONO',
    'FECHA CARGO',
    'POSTED DATE',
  ],
  description: [
    'DESCRIPCION',
    'DESCRIPCION MOVIMIENTO',
    'DETALLE',
    'DETALLE MOVIMIENTO',
    'GLOSA',
    'CONCEPTO',
    'MOVIMIENTO',
    'COMERCIO',
    'DESCRIPTION',
  ],
  amount: [
    'MONTO',
    'MONTO TRANSACCION',
    'MONTO MOVIMIENTO',
    'MONTO OPERACION',
    'IMPORTE',
    'VALOR',
    'MONTO $',
    'AMOUNT',
  ],
  installmentAmount: [
    'VALOR CUOTA',
    'MONTO CUOTA',
    'VALOR DE LA CUOTA',
    'MONTO DE LA CUOTA',
    'CUOTA MENSUAL',
  ],
  purchaseAmount: [
    'MONTO TOTAL',
    'MONTO COMPRA',
    'MONTO ORIGINAL',
    'VALOR COMPRA',
    'MONTO OPERACION ORIGINAL',
  ],
  debit: ['CARGO', 'CARGOS', 'DEBITO', 'DEBE', 'GIRO', 'GIROS', 'MONTO CARGO', 'DEBIT'],
  credit: [
    'ABONO',
    'ABONOS',
    'CREDITO',
    'HABER',
    'DEPOSITO',
    'DEPOSITOS',
    'MONTO ABONO',
    'CREDIT',
  ],
  balance: ['SALDO', 'SALDO CONTABLE', 'SALDO DISPONIBLE', 'SALDO FINAL', 'BALANCE'],
  reference: [
    'N DOCUMENTO',
    'NRO DOCUMENTO',
    'NUMERO DOCUMENTO',
    'DOCUMENTO',
    'N OPERACION',
    'NRO OPERACION',
    'FOLIO',
    'REFERENCIA',
    'ID TRANSACCION',
    'CODIGO',
    'REFERENCE',
  ],
  operationType: ['TIPO', 'TIPO MOVIMIENTO', 'TIPO TRANSACCION', 'TIPO OPERACION', 'CANAL'],
  currency: ['MONEDA', 'DIVISA', 'CURRENCY'],
  installment: ['CUOTA', 'CUOTAS', 'N CUOTAS', 'NRO CUOTA', 'CUOTA DE'],
  card: ['TARJETA', 'N TARJETA', 'NUMERO TARJETA', 'CUENTA', 'CARD'],
  category: ['CATEGORIA', 'RUBRO', 'CATEGORY'],
  directionFlag: ['TIPO CARGO ABONO', 'CARGO ABONO', 'D C', 'DEBE HABER'],
};

/**
 * Roles a header row must contain before the row is accepted as a header.
 *
 * A statement is useless without a date, a description and some notion of
 * amount, so a candidate row missing any of these is data or decoration.
 */
function isPlausibleHeader(map: ColumnMap): boolean {
  const hasAmount =
    map.amount !== undefined ||
    map.installmentAmount !== undefined ||
    map.purchaseAmount !== undefined ||
    map.debit !== undefined ||
    map.credit !== undefined;
  return map.date !== undefined && map.description !== undefined && hasAmount;
}

export interface HeaderDetection {
  /** Index of the header row within `sheet.rows`, or -1 when none was found. */
  headerRow: number;
  map: ColumnMap;
  /** Header cells as printed, for the "columnas detectadas" panel. */
  headers: string[];
  /** Index of the first data row. */
  firstDataRow: number;
}

export interface DetectHeaderOptions {
  /** How many rows to scan before giving up. Statements bury headers under logos. */
  maxScanRows?: number;
}

/**
 * Locate the header row and map its columns to roles.
 *
 * Scans downward and takes the first row that maps to a plausible header, which
 * beats "assume row 0": Chilean exports commonly prepend the account holder,
 * the account number and the period as free-form rows.
 */
export function detectHeader(sheet: Sheet, options: DetectHeaderOptions = {}): HeaderDetection {
  const maxScanRows = options.maxScanRows ?? 30;
  const limit = Math.min(sheet.rows.length, maxScanRows);

  for (let i = 0; i < limit; i += 1) {
    const row = sheet.rows[i] as string[];
    if (isBlankRow(row)) continue;
    const map = mapColumns(row);
    if (isPlausibleHeader(map)) {
      return { headerRow: i, map, headers: row.slice(), firstDataRow: i + 1 };
    }
  }

  return { headerRow: -1, map: {}, headers: [], firstDataRow: 0 };
}

/** Map one row of header cells to column roles. */
export function mapColumns(headerRow: readonly string[]): ColumnMap {
  const normalized = headerRow.map((cell) => normalizeHeader(cell));
  const map: ColumnMap = {};
  const taken = new Set<number>();

  // Exact matches first so a precise header never loses to a loose one.
  for (const pass of ['exact', 'prefix', 'contains'] as const) {
    for (const role of Object.keys(SYNONYMS) as ColumnRole[]) {
      if (map[role] !== undefined) continue;
      const candidates = SYNONYMS[role];
      const index = findColumn(normalized, candidates, pass, taken);
      if (index >= 0) {
        map[role] = index;
        taken.add(index);
      }
    }
  }

  return map;
}

function findColumn(
  normalized: readonly string[],
  candidates: readonly string[],
  pass: 'exact' | 'prefix' | 'contains',
  taken: ReadonlySet<number>,
): number {
  for (const candidate of candidates) {
    for (let i = 0; i < normalized.length; i += 1) {
      if (taken.has(i)) continue;
      const cell = normalized[i] as string;
      if (cell === '') continue;
      if (pass === 'exact' && cell === candidate) return i;
      if (pass === 'prefix' && cell.startsWith(candidate)) return i;
      if (pass === 'contains' && cell.includes(candidate)) return i;
    }
  }
  return -1;
}

/** Fold a header cell: accents, case, punctuation and `N°`/`Nº` all normalised. */
export function normalizeHeader(cell: string): string {
  return foldCase(String(cell ?? ''))
    .replace(/[º°ª]/g, ' ')
    .replace(/[^A-Z0-9$]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read a cell by role, returning '' when the role is unmapped or out of range. */
export function cell(row: readonly string[], map: ColumnMap, role: ColumnRole): string {
  const index = map[role];
  if (index === undefined) return '';
  return (row[index] ?? '').trim();
}
