import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { runCalibration, type CalibrationIo } from '../src/tooling/cli';

/**
 * El camino PDF del CLI de calibración — mismas garantías que el camino
 * XLSX/CSV (`calibration-cli.test.ts`), ejercitadas contra un PDF sintético
 * real generado con `pdf-lib`, nunca contra una muestra real.
 */

const REPO = '/home/usuario/wealthfolio-chile';

interface Capture {
  out: string[];
  err: string[];
}

function io(bytes: Uint8Array, overrides: Partial<CalibrationIo> = {}): CalibrationIo & { capture: Capture } {
  const capture: Capture = { out: [], err: [] };
  const base: CalibrationIo = {
    repoRoot: REPO,
    realpath: (path) => path,
    stat: () => ({ isDirectory: false, size: bytes.length }),
    readFile: () => bytes,
    isIgnored: () => true,
    stdout: (text) => capture.out.push(text),
    stderr: (text) => capture.err.push(text),
  };
  return { ...base, ...overrides, capture };
}

function textOf(capture: Capture): string {
  return [...capture.out, ...capture.err].join('\n');
}

async function syntheticPdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Estado de Cuenta CMR Sintetico', { x: 20, y: 260, size: 12, font });
  page.drawText('COMPRAS NACIONALES', { x: 20, y: 220, size: 10, font });
  page.drawText('04/02/2026 COMERCIO INVENTADO 49.990', { x: 20, y: 205, size: 10, font });
  return doc.save();
}

describe('calibración de un PDF', () => {
  it('reconoce la extensión y calibra vía el camino PDF', async () => {
    const bytes = await syntheticPdfBytes();
    const context = io(bytes);

    const code = await runCalibration(['/tmp/estado-cmr.pdf'], context);

    expect(code).toBe(0);
    expect(textOf(context.capture)).toContain('Capa de texto');
    expect(textOf(context.capture)).toContain('encontrado');
  });

  it('reconoce mayúsculas en la extensión', async () => {
    const bytes = await syntheticPdfBytes();
    const context = io(bytes);

    const code = await runCalibration(['/tmp/ESTADO.PDF'], context);
    expect(code).toBe(0);
  });

  it('nunca imprime una línea del estado de cuenta', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([420, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('COMPRAS NACIONALES', { x: 20, y: 220, size: 10, font });
    page.drawText('04/02/2026 SUPERMERCADO SECRETO ABC 987.654', { x: 20, y: 200, size: 10, font });
    const bytes = await doc.save();
    const context = io(bytes);

    await runCalibration(['/tmp/estado.pdf'], context);

    expect(textOf(context.capture)).not.toContain('SUPERMERCADO SECRETO');
    expect(textOf(context.capture)).not.toContain('987.654');
  });

  /**
   * P1 (review independiente) — el mismo camino productivo del CLI, con los
   * sentinels exactos de la review, capturando TODOS los canales que un
   * proceso real puede escribir: `console.log/warn/error` además de
   * stdout/stderr. El leak reportado era en `console`, no en `io.stdout`, así
   * que un test que sólo mirara `textOf(context.capture)` no lo habría
   * detectado — ver `pdf-console-privacy.test.ts` para el mecanismo aislado.
   */
  it('P1: ningún sentinel llega a ningún canal (console incluido), extremo a extremo', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([420, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const sentinels = [
      'JOSE PRIVATE PERSON',
      '11111111-1',
      'SECRET MERCHANT XYZ',
      '9999201234567890',
      'PRIVATE ADDRESS',
    ];
    let y = 260;
    for (const sentinel of sentinels) {
      page.drawText(sentinel, { x: 20, y, size: 10, font });
      y -= 20;
    }
    const bytes = await doc.save();
    const context = io(bytes);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const code = await runCalibration(['/tmp/estado-sentinel.pdf'], context);
      expect(code).toBe(0);

      const consoleText = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
        .map((call) => call.map(String).join(' '))
        .join('\n');
      const everything = `${textOf(context.capture)}\n${consoleText}`;

      for (const sentinel of sentinels) {
        expect(everything).not.toContain(sentinel);
      }
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('un PDF corrupto da un diagnóstico, no un stack', async () => {
    const context = io(new TextEncoder().encode('esto no es un PDF'));
    const code = await runCalibration(['/tmp/no-es-pdf.pdf'], context);

    expect(code).toBe(1);
    expect(textOf(context.capture)).toContain('No se pudo interpretar');
    expect(textOf(context.capture)).not.toMatch(/\bat\s+\w+\s+\(/);
  });

  it('--compare todavía no admite PDF', async () => {
    const bytes = await syntheticPdfBytes();
    const context = io(bytes);

    const code = await runCalibration(['/tmp/a.pdf', '/tmp/b.pdf', '--compare'], context);
    expect(code).toBe(1);
    expect(textOf(context.capture)).toContain('--compare');
  });

  it('sigue respetando la frontera de privacidad del archivo', async () => {
    const bytes = await syntheticPdfBytes();
    const context = io(bytes, { isIgnored: () => false });

    const code = await runCalibration([`${REPO}/samples/private/estado.pdf`], context);
    expect(code).toBe(1);
    expect(textOf(context.capture)).toContain('samples/private/');
  });
});
