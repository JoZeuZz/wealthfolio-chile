import type { PdfTextExtractor } from './pdf-calibration';

/**
 * The only file in this project that imports `pdfjs-dist`.
 *
 * Kept apart from `pdf-calibration.ts` so the fact-extraction logic can be
 * tested against a fake `PdfTextExtractor` without a real PDF engine, the
 * same separation `calibration.ts` already has from `loadWorkbook`.
 */
export const pdfjsTextExtractor: PdfTextExtractor = {
  async extractPages(bytes: Uint8Array): Promise<string[][]> {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({ data: bytes, isEvalSupported: false }).promise;
    try {
      const pages: string[][] = [];
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        try {
          const content = await page.getTextContent();
          pages.push(reconstructLines(content.items));
        } finally {
          page.cleanup();
        }
      }
      return pages;
    } finally {
      await doc.destroy();
    }
  },
};

interface PositionedItem {
  str: string;
  x: number;
  y: number;
}

/** How close two items' baselines may be and still count as the same line. */
const LINE_TOLERANCE = 2;

/**
 * Groups PDF.js text items into lines by y-proximity, then orders each line
 * left to right by x. `getTextContent` returns items in the content stream's
 * own paint order, which is not reading order — a two-column layout or a
 * table with the amount painted before the description would otherwise come
 * out scrambled.
 */
function reconstructLines(items: readonly unknown[]): string[] {
  const positioned: PositionedItem[] = [];
  for (const item of items) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('str' in item) ||
      !('transform' in item) ||
      typeof (item as { str: unknown }).str !== 'string'
    ) {
      continue;
    }
    const transform = (item as { transform: unknown }).transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    positioned.push({
      str: (item as { str: string }).str,
      x: Number(transform[4]),
      y: Number(transform[5]),
    });
  }

  positioned.sort((a, b) => b.y - a.y || a.x - b.x);

  const rows: PositionedItem[][] = [];
  for (const item of positioned) {
    const current = rows[rows.length - 1];
    const anchor = current?.[0];
    if (anchor && Math.abs(anchor.y - item.y) <= LINE_TOLERANCE) {
      current.push(item);
    } else {
      rows.push([item]);
    }
  }

  return rows
    .map((row) =>
      row
        .sort((a, b) => a.x - b.x)
        .map((item) => item.str)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line !== '');
}
