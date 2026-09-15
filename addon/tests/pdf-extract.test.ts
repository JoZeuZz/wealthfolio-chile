import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { calibratePdf } from '../src/tooling/pdf-calibration';
import { pdfjsTextExtractor } from '../src/tooling/pdf-extract';

/**
 * The one integration test against a real PDF engine.
 *
 * Built entirely with `pdf-lib` from invented text — never a real statement,
 * never even a realistic one — to prove `pdfjsTextExtractor` actually
 * reconstructs lines a human would recognize as lines, not just that the fake
 * extractor in `pdf-calibration.test.ts` behaves. `calibratePdf` doesn't care
 * which extractor it gets, so running the same facts through the real one
 * here is what proves the two halves fit together.
 */

async function syntheticStatementPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const draw = (text: string, y: number) => page.drawText(text, { x: 20, y, size: 10, font });

  draw('Tarjeta CMR — Estado de Cuenta Sintetico', 270);
  draw('Fecha de Emision: 05/02/2026', 250);
  draw('Pagar Hasta: 20/02/2026', 235);
  draw('COMPRAS NACIONALES', 210);
  draw('04/02/2026 COMERCIO INVENTADO UNO 49.990', 195);
  draw('05/02/2026 COMERCIO INVENTADO DOS 12.500', 180);
  draw('COMPRAS INTERNACIONALES', 160);
  draw('06/02/2026 COMERCIO INVENTADO TRES USD 8.000', 145);

  return doc.save();
}

describe('pdfjsTextExtractor + calibratePdf, end to end on a synthetic PDF', () => {
  it('reconstructs lines a human would recognize, in reading order', async () => {
    const bytes = await syntheticStatementPdf();
    const pages = await pdfjsTextExtractor.extractPages(bytes);

    expect(pages).toHaveLength(1);
    // Top to bottom, exactly as drawn.
    expect(pages[0]?.[0]).toContain('CMR');
    expect(pages[0]?.some((line) => line.includes('COMPRAS NACIONALES'))).toBe(true);
    expect(pages[0]?.some((line) => line.includes('COMPRAS INTERNACIONALES'))).toBe(true);
  });

  it('produces the facts a calibration run would report, from a real PDF', async () => {
    const bytes = await syntheticStatementPdf();
    const report = await calibratePdf(bytes, pdfjsTextExtractor);

    expect(report.file.pages).toBe(1);
    expect(report.textLayer).toBe(true);
    expect(report.markers.find((m) => m.name === 'CMR')?.found).toBe(true);
    expect(report.markers.find((m) => m.name === 'ESTADO DE CUENTA')?.found).toBe(true);
    expect(report.statementFacts.billingDatePresent).toBe(true);
    expect(report.statementFacts.dueDatePresent).toBe(true);
    expect(report.statementFacts.billingPeriodPresent).toBe(false);

    const nacionales = report.sections.find((s) => s.name === 'COMPRAS NACIONALES');
    const internacionales = report.sections.find((s) => s.name === 'COMPRAS INTERNACIONALES');
    expect(nacionales?.rowLikeLines).toBe(2);
    expect(internacionales?.rowLikeLines).toBe(1);
    expect(report.unknownRowLikeLines).toBe(0);
    expect(report.currencyEvidence.find((c) => c.name === 'USD')?.rows).toBe(1);
  });

  it('reports the real byte count, not zero', async () => {
    // pdfjs-dist takes ownership of a typed array passed as `data` and can
    // detach it once parsing starts — reading `bytes.length` after awaiting
    // extraction read the now-detached array's length back as 0. This pins
    // the fix: capture the length before extraction ever runs.
    const bytes = await syntheticStatementPdf();
    const expectedBytes = bytes.length;
    const report = await calibratePdf(bytes, pdfjsTextExtractor);
    expect(report.file.bytes).toBe(expectedBytes);
    expect(report.file.bytes).toBeGreaterThan(0);
  });

  it('reports no text layer for a PDF with an empty page', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const bytes = await doc.save();

    const report = await calibratePdf(bytes, pdfjsTextExtractor);
    expect(report.textLayer).toBe(false);
    expect(report.file.pages).toBe(1);
  });
});
