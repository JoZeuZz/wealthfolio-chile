import { describe, expect, it, vi } from 'vitest';

/**
 * P1 (review independiente) — pdfjs-dist escribe texto derivado del documento
 * a `console` por su propio lado (confirmado leyendo
 * `node_modules/pdfjs-dist/legacy/build/pdf.mjs`: `info()`/`warn()` llaman a
 * `console.log`, y varias de esas llamadas interpolan datos del documento —
 * nombre de fuente, mensaje de excepción de decodificación). Ese canal nunca
 * pasa por la sanitización propia de `calibratePdf`/`formatPdfReport`, así
 * que la frontera de privacidad de ese módulo no puede verlo ni controlarlo.
 *
 * Mismo patrón que `calibration-console.test.ts` ya usa para SheetJS: en vez
 * de depender de que un PDF sintético concreto dispare por casualidad la
 * misma ruta interna de una versión de pdfjs (frágil entre versiones), se
 * mockea `pdfjs-dist/legacy/build/pdf.mjs` para simular exactamente el
 * comportamiento documentado — logging propio en cada etapa del ciclo de
 * vida del documento — y se prueba el mecanismo de supresión directamente
 * contra `pdfjsTextExtractor`, la función que usa el CLI de calibración.
 */

const SENTINEL = 'JOSE PRIVATE PERSON 11111111-1 SECRET MERCHANT XYZ 9999201234567890 PRIVATE ADDRESS';

const mockState = vi.hoisted(() => ({ throwInGetTextContent: false }));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({
    promise: (async () => {
      // Simulates pdfjs's own `info()`/`warn()` at document load — real call
      // sites include the document's own font names and decode exceptions.
      globalThis['console'].log(`Info: cargando documento (${SENTINEL})`);
      return {
        numPages: 1,
        getPage: async () => {
          globalThis['console'].warn(`Warning: fuente del documento (${SENTINEL})`);
          return {
            getTextContent: async () => {
              if (mockState.throwInGetTextContent) {
                globalThis['console'].error(`Error: no se pudo decodificar (${SENTINEL})`);
                throw new Error('boom');
              }
              globalThis['console'].error(`Error: advertencia menor (${SENTINEL})`);
              return { items: [] };
            },
            cleanup: () => undefined,
          };
        },
        destroy: async () => {
          globalThis['console'].log(`Info: cerrando documento (${SENTINEL})`);
        },
      };
    })(),
  }),
}));

describe('privacidad: pdfjsTextExtractor suprime la consola propia de pdfjs', () => {
  it('A: extracción normal — ningún sentinel llega a console.log/warn/error', async () => {
    const { pdfjsTextExtractor } = await import('../src/tooling/pdf-extract');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await pdfjsTextExtractor.extractPages(new Uint8Array());

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it('B: una extracción que lanza deja console restaurado igual (el error sigue propagando)', async () => {
    const { pdfjsTextExtractor } = await import('../src/tooling/pdf-extract');
    mockState.throwInGetTextContent = true;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(pdfjsTextExtractor.extractPages(new Uint8Array())).rejects.toThrow('boom');

      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();

      log.mockClear();
      globalThis['console'].log('visible después del throw');
      expect(log).toHaveBeenCalledWith('visible después del throw');
    } finally {
      log.mockRestore();
      error.mockRestore();
      mockState.throwInGetTextContent = false;
    }
  });

  it('C: una llamada a console.log fuera del scope, tras una extracción exitosa, funciona normal', async () => {
    const { pdfjsTextExtractor } = await import('../src/tooling/pdf-extract');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await pdfjsTextExtractor.extractPages(new Uint8Array());
    log.mockClear();
    globalThis['console'].log('visible después de una extracción exitosa');

    expect(log).toHaveBeenCalledWith('visible después de una extracción exitosa');
    log.mockRestore();
  });
});

describe('el tooling PDF no se filtra al runtime del addon', () => {
  it('ningún archivo bajo ui/pages/components/services importa pdf-lib, pdfjs-dist ni tooling/pdf', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const roots = ['ui', 'pages', 'components', 'services'].map((dir) =>
      fileURLToPath(new URL(`../src/${dir}/`, import.meta.url)),
    );

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = `${dir}${entry}`;
        if (statSync(full).isDirectory()) out.push(...walk(`${full}/`));
        else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
      }
      return out;
    }

    const offenders: string[] = [];
    for (const root of roots) {
      let files: string[];
      try {
        files = walk(root);
      } catch {
        continue;
      }
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        if (/pdf-lib|pdfjs-dist|tooling\/pdf/.test(text)) offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
