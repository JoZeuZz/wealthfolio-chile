import { describe, expect, it } from 'vitest';
import { calibratePdf, type PdfTextExtractor } from '../src/tooling/pdf-calibration';

/**
 * Fact extraction from PDF lines, tested against a fake extractor.
 *
 * `pdf-extract.ts` (the real pdfjs-dist reader) has its own integration test
 * against a synthetic PDF built with `pdf-lib`; this file never touches a PDF
 * engine at all, so the fact logic — sections, markers, row-shape counting —
 * can be pinned quickly and precisely, one page of fabricated lines at a
 * time. Every line here is invented for the test, never real statement text.
 */

function fakeExtractor(pages: string[][]): PdfTextExtractor {
  return { extractPages: async () => pages };
}

describe('calibratePdf', () => {
  it('reports no text layer for a page with nothing extractable', async () => {
    const report = await calibratePdf(new Uint8Array([1, 2, 3]), fakeExtractor([[]]));
    expect(report.textLayer).toBe(false);
    expect(report.file.pages).toBe(1);
  });

  it('reports a text layer when any page has lines', async () => {
    const report = await calibratePdf(new Uint8Array(), fakeExtractor([['Algo cualquiera']]));
    expect(report.textLayer).toBe(true);
  });

  it('finds a product marker only when the exact phrase appears', async () => {
    const report = await calibratePdf(
      new Uint8Array(),
      fakeExtractor([['Tarjeta CMR Internacional', 'Cupo Avance disponible: cuenta']]),
    );
    const cmr = report.markers.find((m) => m.name === 'CMR');
    const cupoAvance = report.markers.find((m) => m.name === 'CUPO AVANCE');
    const montoTotal = report.markers.find((m) => m.name === 'MONTO TOTAL FACTURADO');
    expect(cmr?.found).toBe(true);
    expect(cupoAvance?.found).toBe(true);
    expect(montoTotal?.found).toBe(false);
  });

  it('is case and accent insensitive on markers', async () => {
    const report = await calibratePdf(new Uint8Array(), fakeExtractor([['número cuotas: 6']]));
    expect(report.markers.find((m) => m.name === 'NUMERO CUOTAS')?.found).toBe(true);
  });

  it('detects billing date, period and due date phrases independently', async () => {
    const report = await calibratePdf(
      new Uint8Array(),
      fakeExtractor([['Fecha de Emision: xx', 'Pagar Hasta: xx']]),
    );
    expect(report.statementFacts.billingDatePresent).toBe(true);
    expect(report.statementFacts.dueDatePresent).toBe(true);
    expect(report.statementFacts.billingPeriodPresent).toBe(false);
  });

  it('counts row-shaped lines under the section header that precedes them', async () => {
    const report = await calibratePdf(
      new Uint8Array(),
      fakeExtractor([
        [
          'COMPRAS NACIONALES',
          '05/02/2026 algo cualquiera 49.990',
          '06/02/2026 otra cosa 12.500',
          'COMPRAS INTERNACIONALES',
          '07/02/2026 algo mas 8.000',
        ],
      ]),
    );

    const nacionales = report.sections.find((s) => s.name === 'COMPRAS NACIONALES');
    const internacionales = report.sections.find((s) => s.name === 'COMPRAS INTERNACIONALES');
    expect(nacionales?.found).toBe(true);
    expect(nacionales?.rowLikeLines).toBe(2);
    expect(internacionales?.found).toBe(true);
    expect(internacionales?.rowLikeLines).toBe(1);
  });

  it('counts a row-shaped line before any header as unknown, not a section', async () => {
    const report = await calibratePdf(
      new Uint8Array(),
      fakeExtractor([['05/02/2026 algo 49.990', 'COMPRAS NACIONALES', '06/02/2026 otra 1.000']]),
    );
    expect(report.unknownRowLikeLines).toBe(1);
    expect(report.sections.find((s) => s.name === 'COMPRAS NACIONALES')?.rowLikeLines).toBe(1);
  });

  it('a line with only a date or only an amount is not row-shaped', async () => {
    const report = await calibratePdf(
      new Uint8Array(),
      fakeExtractor([['COMPRAS NACIONALES', 'Emitido el 05/02/2026', 'Total: 49.990']]),
    );
    expect(report.sections.find((s) => s.name === 'COMPRAS NACIONALES')?.rowLikeLines).toBe(0);
    expect(report.unknownRowLikeLines).toBe(0);
  });

  it('counts currency-evidence hits per candidate, never a value', async () => {
    const report = await calibratePdf(
      new Uint8Array(),
      fakeExtractor([['Monto Original USD', 'Tipo de Cambio del dia', 'algo en USD tambien']]),
    );
    expect(report.currencyEvidence.find((c) => c.name === 'USD')?.rows).toBe(2);
    expect(report.currencyEvidence.find((c) => c.name === 'TIPO DE CAMBIO')?.rows).toBe(1);
    expect(report.currencyEvidence.find((c) => c.name === 'DOLAR')?.rows).toBe(0);
  });

  it('never leaks a line of statement text into the report', async () => {
    const secret = 'JUAN PEREZ SOTO COMPRA SUPERMERCADO SECRETO 123.456';
    const report = await calibratePdf(
      new Uint8Array(),
      fakeExtractor([['COMPRAS NACIONALES', `05/02/2026 ${secret}`]]),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('JUAN');
    expect(serialized).not.toContain('PEREZ');
    expect(serialized).not.toContain('SECRETO');
    expect(serialized).not.toContain('123.456');
  });
});
