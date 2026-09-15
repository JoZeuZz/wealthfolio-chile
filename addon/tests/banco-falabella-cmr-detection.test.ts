import { describe, expect, it } from 'vitest';
import { computeFileHash } from '../src/core/dedupe/fingerprint';
import { loadWorkbook } from '../src/core/parsing/workbook';
import { detectAll } from '../src/core/providers/registry';
import { fromXlsxRows } from './fixtures';
import type { ParserInput } from '../src/core/providers/parser';
import type { SourceFile } from '../src/core/parsing/tabular';

/**
 * Calibración contra 4 exportaciones reales de "Movimientos Facturados" CMR
 * (2026-09): ninguna trae texto de preámbulo — ni "CMR" ni "FALABELLA" en
 * ninguna celda, sólo la cabecera de movimientos y las filas. `strongMarkers`
 * nunca dispara, así que `banco-falabella.cmr` perdía 45 % a 55 % contra
 * `generico.tarjeta` en las 4 muestras reales.
 *
 * La cabecera exacta sí es distintiva — confirmada, no imprimida, vía
 * `pnpm calibrate -- <archivo> --parser banco-falabella.cmr` contra las 4
 * muestras reales (firma candidata `cmr-movimientos-facturados-v1`,
 * `addon/src/tooling/calibration.ts`). El mismo mecanismo que ya usa
 * `banco-chile.tarjeta` para su layout internacional
 * (`recognizedLayoutSignatures`) sirve aquí: la firma completa de columnas es
 * evidencia de producto tan específica como el texto de marca, para un layout
 * cuyo archivo real nunca imprime el nombre del banco.
 */

const REAL_HEADER = ['FECHA', 'DESCRIPCION', 'TITULAR/ADICIONAL', 'MONTO', 'CUOTAS PENDIENTES', 'VALOR CUOTA'];

function inputForFile(file: SourceFile): ParserInput {
  return { file, sheets: loadWorkbook(file).sheets, fileHash: computeFileHash(file.bytes) };
}

function topParser(file: SourceFile) {
  return detectAll(inputForFile(file))[0];
}

describe('detección de banco-falabella.cmr sin branding de preámbulo', () => {
  it('la firma completa de 6 columnas, sin ningún texto de marca, gana la detección', () => {
    const file = fromXlsxRows('movimientos.xlsx', [
      REAL_HEADER,
      ['05/02/2026', 'FALABELLA RETAIL PLAZA VESPUCIO', 'TITULAR', '49990', '0', '49990'],
      ['06/02/2026', 'PAGO TARJETA', 'TITULAR', '120000', '0', '120000'],
    ]);

    expect(topParser(file)?.parser).toBe('banco-falabella.cmr');
  });

  it('sólo 5 de las 6 columnas no basta — no es evidencia de producto', () => {
    // Cualquier tarjeta genérica con cuotas puede imprimir 5 de estas 6
    // palabras sueltas; sólo el conjunto completo es la firma real.
    const partial = REAL_HEADER.slice(0, 5);
    const file = fromXlsxRows('parcial.xlsx', [
      partial,
      ['05/02/2026', 'COMERCIO GENERICO', 'TITULAR', '10000', '0'],
    ]);

    const detections = detectAll(inputForFile(file));
    const cmr = detections.find((d) => d.parser === 'banco-falabella.cmr');
    const generic = detections.find((d) => d.parser === 'generico.tarjeta');
    expect((cmr?.score ?? 0)).toBeLessThanOrEqual(generic?.score ?? 0);
  });

  it('control negativo — cuenta corriente/vista Falabella no dispara la firma de CMR', () => {
    const file = fromXlsxRows('cartola-cuenta.xlsx', [
      ['Fecha', 'Descripcion', 'Cargo', 'Abono', 'Saldo'],
      ['05/02/2026', 'TRANSFERENCIA RECIBIDA', '', '50000', '150000'],
    ]);

    expect(topParser(file)?.parser).not.toBe('banco-falabella.cmr');
  });

  it('control negativo — una glosa que dice "Falabella" no es evidencia de producto', () => {
    // El branding vive, cuando existe, en preámbulo/cabecera — nunca en el
    // texto de un movimiento. Un pago a un comercio Falabella no es CMR.
    const file = fromXlsxRows('otra-tarjeta.xlsx', [
      ['Fecha', 'Descripcion', 'Monto', 'Cuotas'],
      ['05/02/2026', 'FALABELLA RETAIL', '49990', ''],
    ]);

    expect(topParser(file)?.parser).not.toBe('banco-falabella.cmr');
  });
});
