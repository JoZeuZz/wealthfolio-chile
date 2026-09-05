import { describe, expect, it } from 'vitest';
import { defaultRules } from '../src/core/rules/builtin';
import { applyRules } from '../src/core/rules/engine';
import { makeTransaction } from './fixtures';

/**
 * Marcadores cortos y la palabra que los contiene.
 *
 * `PATAGONIA` contiene `TAG`, `PARAGUAS` contiene `AGUAS` y `DENOMINACION`
 * contiene `NOMINA`. Un marcador de tres letras buscado como subcadena
 * clasifica una tienda de ropa como peaje de autopista, y el usuario ve la
 * categoría equivocada sin una sola pista de por qué.
 *
 * Es el mismo error que se corrigió para PAT/PAC en la detección de mandatos
 * (`core/chile/mandates.ts`): un marcador que el banco imprime como token
 * propio no puede buscarse dentro de otra palabra. Aquí se comprueba en las
 * reglas predefinidas, que es donde queda escrita la categoría persistida.
 */

function categorize(description: string): string | undefined {
  const { transaction } = applyRules(
    makeTransaction({ description, amount: -63_000, date: '2026-08-28' }),
    defaultRules(),
    { accountId: 'acc-1' },
  );
  return transaction.category;
}

describe('marcadores cortos que no pueden vivir dentro de otra palabra', () => {
  it('«PATAGONIA» no es un peaje de autopista', () => {
    expect(categorize('COMPRA PATAGONIA OUTDOOR PROVIDENCIA')).not.toBe(
      'transporte.estacionamiento',
    );
  });

  it('«TAG» como token propio sí lo es', () => {
    expect(categorize('PEAJE TAG AUTOPISTA CENTRAL')).toBe('transporte.estacionamiento');
  });

  it('«TAG» pegado a un signo de puntuación sigue siendo el marcador', () => {
    expect(categorize('CARGO TAG-CN COSTANERA')).toBe('transporte.estacionamiento');
  });

  it('«PARAGUAS» no es la cuenta del agua', () => {
    expect(categorize('COMPRA PARAGUAS SANTIAGO CENTRO')).not.toBe('servicios.agua');
  });

  it('«AGUAS ANDINAS» sí lo es', () => {
    expect(categorize('PAC AGUAS ANDINAS SA')).toBe('servicios.agua');
  });

  it('una cuenta de agua al final de la glosa también', () => {
    expect(categorize('CARGO PAC AGUAS')).toBe('servicios.agua');
  });

  it('«DENOMINACION» no es una liquidación de sueldo', () => {
    expect(categorize('TRANSFERENCIA DENOMINACION SOCIAL LTDA')).not.toBe('ingresos.sueldo');
  });

  it('«NOMINA» como token propio sí lo es', () => {
    expect(categorize('ABONO NOMINA EMPRESA LTDA')).toBe('ingresos.sueldo');
  });

  it('«BIPOLAR» no es transporte público', () => {
    expect(categorize('CENTRO MEDICO BIPOLAR SPA')).not.toBe('transporte.publico');
  });

  it('«BIP!» sí lo es', () => {
    expect(categorize('CARGA TARJETA BIP! METRO')).toBe('transporte.publico');
  });

  it('«INTERESANTE» no es un interés cobrado', () => {
    expect(categorize('COMPRA LIBRERIA INTERESANTE')).not.toBe('deudas.intereses');
  });

  it('«INTERES» e «INTERESES» siguen siendo el cargo financiero', () => {
    expect(categorize('INTERES POR SOBREGIRO')).toBe('deudas.intereses');
    expect(categorize('INTERESES POR MORA')).toBe('deudas.intereses');
  });
});
