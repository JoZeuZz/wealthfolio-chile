import { describe, expect, it } from 'vitest';
import { describeColumnShape } from '../src/core/parsing/column-shape';

describe('forma de una columna, nunca su valor', () => {
  it('columna en blanco', () => {
    expect(describeColumnShape(['', '', ''])).toBe('vacio');
  });

  it('enteros cortos: candidato a índice de cuota', () => {
    expect(describeColumnShape(['2', '11', ''])).toBe('entero-corto');
  });

  it('enteros medianos', () => {
    expect(describeColumnShape(['1234', '987'])).toBe('entero-mediano');
  });

  it('enteros largos: candidato a identificador, no a cuota', () => {
    expect(describeColumnShape(['123456789', '987654321'])).toBe('entero-largo');
  });

  it('decimal: candidato a monto', () => {
    expect(describeColumnShape(['1.234,56', '99,00'])).toBe('decimal');
  });

  it('fecha: parsea como fecha DMY', () => {
    expect(describeColumnShape(['03/09/2026', '15/08/2026'])).toBe('fecha');
  });

  it('código de moneda ISO-4217', () => {
    expect(describeColumnShape(['USD', 'CLP'])).toBe('codigo-moneda');
  });

  it('signo de moneda', () => {
    expect(describeColumnShape(['US$', '$'])).toBe('codigo-moneda');
  });

  it('con letras: texto libre', () => {
    expect(describeColumnShape(['NACIONAL', 'INTERNACIONAL'])).toBe('con-letras');
  });

  it('blancos intercalados no cuentan para el veredicto', () => {
    expect(describeColumnShape(['', '2', '', '6'])).toBe('entero-corto');
  });

  it('mixto: las celdas no vacías no concuerdan en forma', () => {
    expect(describeColumnShape(['2', 'NACIONAL'])).toBe('mixto');
  });

  it('nunca revela el valor mismo, sólo el balde', () => {
    const shape = describeColumnShape(['12.345.678-9']);
    expect(shape).not.toContain('12.345.678');
    expect(typeof shape).toBe('string');
  });
});
