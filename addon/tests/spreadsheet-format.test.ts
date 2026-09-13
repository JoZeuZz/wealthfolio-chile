import { describe, expect, it } from 'vitest';
import {
  classifyNativeCellType,
  classifyNumberFormatCode,
} from '../src/core/parsing/spreadsheet-format';

/**
 * Clasifica metadatos NATIVOS de una celda XLS/XLSX (tipo de celda, formato
 * numérico de Excel) en un vocabulario cerrado — nunca a partir del valor ni
 * del texto formateado. Ver `core/money.ts#splitDecimal`: la ambigüedad
 * "coma + cola de 3 dígitos" es del TEXTO; esto es evidencia del contenedor.
 */

describe('classifyNativeCellType', () => {
  it('celda numérica nativa', () => {
    expect(classifyNativeCellType('n')).toBe('number');
  });

  it('celda de texto', () => {
    expect(classifyNativeCellType('s')).toBe('string');
  });

  it('celda vacía (sin objeto de celda)', () => {
    expect(classifyNativeCellType(undefined)).toBe('blank');
  });

  it('otro tipo (booleano, error, fecha)', () => {
    expect(classifyNativeCellType('b')).toBe('other');
    expect(classifyNativeCellType('e')).toBe('other');
    expect(classifyNativeCellType('d')).toBe('other');
  });
});

describe('classifyNumberFormatCode', () => {
  it('entero agrupado por miles', () => {
    expect(classifyNumberFormatCode('#,##0')).toBe('grouped-integer');
  });

  it('entero sin agrupar', () => {
    expect(classifyNumberFormatCode('0')).toBe('integer');
  });

  it('dos decimales', () => {
    expect(classifyNumberFormatCode('0.00')).toBe('decimal-2');
  });

  it('dos decimales agrupados sigue siendo decimal-2, no entero', () => {
    expect(classifyNumberFormatCode('#,##0.00')).toBe('decimal-2');
  });

  it('tres decimales', () => {
    expect(classifyNumberFormatCode('0.000')).toBe('decimal-3');
  });

  it('un decimal', () => {
    expect(classifyNumberFormatCode('0.0')).toBe('decimal-1');
  });

  it('General', () => {
    expect(classifyNumberFormatCode('General')).toBe('general');
    expect(classifyNumberFormatCode(undefined)).toBe('general');
    expect(classifyNumberFormatCode('')).toBe('general');
  });

  it('moneda entera', () => {
    expect(classifyNumberFormatCode('"$"#,##0')).toBe('currency-integer');
  });

  it('moneda con dos decimales', () => {
    expect(classifyNumberFormatCode('"$"#,##0.00')).toBe('currency-decimal-2');
  });

  it('formato de fecha no es una forma numérica reconocida', () => {
    expect(classifyNumberFormatCode('dd/mm/yyyy')).toBe('unknown');
  });
});
