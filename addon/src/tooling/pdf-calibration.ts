import { normalizeDescription } from '../core/text';

/**
 * Privacy-safe structural facts from a CMR PDF statement.
 *
 * This is not a PDF import parser — there is none in this tranche (see
 * `docs/BANK_FORMATS.md`). It exists only to turn a real PDF into the same
 * kind of sanitized evidence `calibration.ts` already produces for XLSX:
 * counts, booleans and named-category hits, never a line of the statement's
 * own text.
 *
 * Every fact below is computed from lines reconstructed out of the PDF's own
 * text layer (see {@link extractPages}), and every function that touches
 * those lines returns only a count or a boolean — the lines themselves never
 * leave this module.
 */

export interface PdfCalibrationReport {
  file: { bytes: number; pages: number };
  /** False means no extractable text at all — a scanned image, most likely. */
  textLayer: boolean;
  /** Candidate product/institution markers, presence only — see `MARKER_CANDIDATES`. */
  markers: Array<{ name: string; found: boolean }>;
  statementFacts: {
    billingDatePresent: boolean;
    billingPeriodPresent: boolean;
    dueDatePresent: boolean;
  };
  /** Candidate section headers, with how many row-shaped lines follow each until the next one. */
  sections: Array<{ name: string; found: boolean; rowLikeLines: number }>;
  /** Row-shaped lines that appeared before any recognized section, or after the last one. */
  unknownRowLikeLines: number;
  /** Candidate original-currency vocabulary, line-hit counts only. */
  currencyEvidence: Array<{ name: string; rows: number }>;
}

/** Candidate product/institution evidence — tested, never assumed. */
const MARKER_CANDIDATES: readonly string[] = [
  'CMR',
  'ESTADO DE CUENTA',
  'CUPO COMPRAS',
  'CUPO AVANCE',
  'MONTO TOTAL FACTURADO',
  'NUMERO CUOTAS',
  'VALOR CUOTA',
  'MOVIMIENTOS FACTURADOS',
];

const SECTION_CANDIDATES: readonly string[] = [
  'COMPRAS NACIONALES',
  'COMPRAS INTERNACIONALES',
  'OTROS',
  'CARGOS COMISIONES IMPUESTOS Y ABONOS',
];

const CURRENCY_CANDIDATES: readonly string[] = ['USD', 'US$', 'DOLAR', 'MONEDA ORIGEN', 'TIPO DE CAMBIO'];

const BILLING_DATE_CANDIDATES: readonly string[] = [
  'FECHA DE EMISION',
  'FECHA FACTURACION',
  'FECHA DE FACTURACION',
  'FECHA ESTADO DE CUENTA',
];
const BILLING_PERIOD_CANDIDATES: readonly string[] = [
  'PERIODO FACTURADO',
  'PERIODO DE FACTURACION',
  'PERIODO ANTERIOR',
];
const DUE_DATE_CANDIDATES: readonly string[] = ['PAGAR HASTA', 'FECHA DE VENCIMIENTO', 'PAGO HASTA'];

const DATE_PATTERN = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/;
// Thousands-grouped only (`49.990`, `1.234.567`) — a bare `\d{4,}` fallback
// also matches a date's own year, which made `Emitido el 05/02/2026` look
// row-shaped on the date alone.
const AMOUNT_PATTERN = /\b\d{1,3}(?:\.\d{3})+\b/;

/** A line that looks like a movement: it has both a date and an amount shape. */
function isRowLike(line: string): boolean {
  return DATE_PATTERN.test(line) && AMOUNT_PATTERN.test(line);
}

function mentionsAny(line: string, candidates: readonly string[]): boolean {
  const text = normalizeDescription(line);
  return candidates.some((candidate) => text.includes(normalizeDescription(candidate)));
}

export interface PdfTextExtractor {
  /** Reconstructed lines per page, top to bottom, left to right within a line. */
  extractPages(bytes: Uint8Array): Promise<string[][]>;
}

export async function calibratePdf(
  bytes: Uint8Array,
  extractor: PdfTextExtractor,
): Promise<PdfCalibrationReport> {
  const pages = await extractor.extractPages(bytes);
  const allLines = pages.flat();
  const textLayer = allLines.some((line) => line.trim() !== '');

  const markers = MARKER_CANDIDATES.map((name) => ({
    name,
    found: allLines.some((line) => mentionsAny(line, [name])),
  }));

  const statementFacts = {
    billingDatePresent: allLines.some((line) => mentionsAny(line, BILLING_DATE_CANDIDATES)),
    billingPeriodPresent: allLines.some((line) => mentionsAny(line, BILLING_PERIOD_CANDIDATES)),
    dueDatePresent: allLines.some((line) => mentionsAny(line, DUE_DATE_CANDIDATES)),
  };

  const currencyEvidence = CURRENCY_CANDIDATES.map((name) => ({
    name,
    rows: allLines.filter((line) => mentionsAny(line, [name])).length,
  }));

  const { sections, unknownRowLikeLines } = sectionRowCounts(allLines);

  return {
    file: { bytes: bytes.length, pages: pages.length },
    textLayer,
    markers,
    statementFacts,
    sections,
    unknownRowLikeLines,
    currencyEvidence,
  };
}

/**
 * Walks the document once, tracking which candidate section header was last
 * seen, and counts row-shaped lines against it. A row-shaped line seen before
 * any header, or a header this project does not have a candidate for, counts
 * toward `unknownRowLikeLines` instead — never toward a section it cannot be
 * shown to belong to.
 */
function sectionRowCounts(lines: readonly string[]): {
  sections: PdfCalibrationReport['sections'];
  unknownRowLikeLines: number;
} {
  const counts = new Map<string, number>(SECTION_CANDIDATES.map((name) => [name, 0]));
  const found = new Set<string>();
  let current: string | undefined;
  let unknown = 0;

  for (const line of lines) {
    const header = SECTION_CANDIDATES.find((name) => mentionsAny(line, [name]));
    if (header) {
      current = header;
      found.add(header);
      continue;
    }
    if (!isRowLike(line)) continue;
    if (current) counts.set(current, (counts.get(current) ?? 0) + 1);
    else unknown += 1;
  }

  return {
    sections: SECTION_CANDIDATES.map((name) => ({
      name,
      found: found.has(name),
      rowLikeLines: counts.get(name) ?? 0,
    })),
    unknownRowLikeLines: unknown,
  };
}

export function formatPdfReport(report: PdfCalibrationReport): string {
  const lines: string[] = [];
  const add = (label: string, value: string | number) => lines.push(`${label.padEnd(28)}${value}`);

  lines.push('── Archivo ───────────────────────────────────────────────');
  add('Tamaño', `${report.file.bytes} bytes`);
  add('Páginas', report.file.pages);
  add('Capa de texto', report.textLayer ? 'sí' : 'no');

  lines.push('', '── Marcadores de producto ────────────────────────────────');
  for (const marker of report.markers) {
    lines.push(`  ${marker.found ? 'encontrado    ' : 'no encontrado '} ${marker.name}`);
  }

  lines.push('', '── Estado de cuenta ──────────────────────────────────────');
  add('Fecha de facturación', report.statementFacts.billingDatePresent ? 'presente' : 'no encontrada');
  add('Período facturado', report.statementFacts.billingPeriodPresent ? 'presente' : 'no encontrado');
  add('Fecha de vencimiento', report.statementFacts.dueDatePresent ? 'presente' : 'no encontrada');

  lines.push('', '── Secciones y filas tipo movimiento ─────────────────────');
  for (const section of report.sections) {
    lines.push(
      `  ${section.found ? 'encontrada    ' : 'no encontrada '} ${section.name} — ${section.rowLikeLines} fila(s)`,
    );
  }
  add('Filas sin sección reconocida', report.unknownRowLikeLines);

  lines.push('', '── Evidencia de moneda original ──────────────────────────');
  for (const currency of report.currencyEvidence) {
    lines.push(`  ${String(currency.rows).padStart(5)}  ${currency.name}`);
  }

  return lines.join('\n');
}
