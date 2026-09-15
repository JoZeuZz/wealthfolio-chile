import { describe, expect, it } from 'vitest';
import { computeFingerprint } from '../src/core/dedupe/fingerprint';
import { computeFileHash } from '../src/core/dedupe/fingerprint';
import { getParser } from '../src/core/providers/registry';
import { fromText } from './fixtures';
import { loadWorkbook } from '../src/core/parsing/workbook';
import type { ParserInput } from '../src/core/providers/parser';
import type { SourceFile } from '../src/core/parsing/tabular';

/**
 * P1 (review independiente) — `detectRemainingInstallments` contaminaba
 * cualquier columna canónica `Cuotas`, no sólo la columna real
 * `CUOTAS PENDIENTES` de CMR.
 *
 * `CUOTAS PENDIENTES` significa "cuotas restantes tras este cargo" — un
 * hecho real de CMR Banco Falabella. Una columna genérica `Cuotas` en otro
 * banco no significa lo mismo: puede ser el total de cuotas de un plan
 * (`Cuotas = 6`) y no un conteo restante. Confundir las dos convierte una
 * compra de 6 cuotas de cualquier banco en "quedan 6 cuotas", fabrica
 * `installmentRemaining` donde no hay evidencia y cambia el fingerprint de
 * filas que nunca debieron cambiar.
 *
 * La lectura de conteo restante ahora es específica del profile:
 * `StatementProfile.remainingInstallmentHeaders` declara qué encabezado
 * exacto porta esa semántica. Sólo CMR (`banco-falabella.cmr`,
 * `CUOTAS PENDIENTES`) la declara.
 */

function inputForFile(file: SourceFile): ParserInput {
  return { file, sheets: loadWorkbook(file).sheets, fileHash: computeFileHash(file.bytes) };
}

describe('CMR — CUOTAS PENDIENTES sigue alimentando installmentRemaining', () => {
  const parser = getParser('banco-falabella.cmr')!;

  it.each([
    ['5', 5],
    ['4', 4],
    ['1', 1],
    ['0', 0],
  ])('CUOTAS PENDIENTES=%s -> installmentRemaining=%s', (raw, expected) => {
    const file = fromText(
      'cmr.csv',
      [
        'Fecha;Descripcion;Monto;CUOTAS PENDIENTES',
        `04/02/2026;FALABELLA RETAIL;49.990;${raw}`,
      ].join('\n'),
    );
    const statement = parser.parse(inputForFile(file));
    expect(statement.transactions[0]?.installmentRemaining).toBe(expected);
  });

  it('columna vacía -> installmentRemaining undefined', () => {
    const file = fromText(
      'cmr.csv',
      ['Fecha;Descripcion;Monto;CUOTAS PENDIENTES', '04/02/2026;FALABELLA RETAIL;49.990;'].join(
        '\n',
      ),
    );
    const statement = parser.parse(inputForFile(file));
    expect(statement.transactions[0]?.installmentRemaining).toBeUndefined();
  });
});

describe('Banco de Chile tarjeta — columna Cuotas NO es conteo restante', () => {
  const parser = getParser('banco-chile.tarjeta')!;

  it('Cuotas=6 no produce installmentRemaining', () => {
    const file = fromText(
      'mov-facturado-nacional.csv',
      ['Fecha;Descripcion;Monto;Cuotas', '05/02/2026;COMPRA SINTETICA;12.450;6'].join('\n'),
    );
    const statement = parser.parse(inputForFile(file));
    const row = statement.transactions[0]!;

    expect(row.installmentRemaining).toBeUndefined();
    // El fingerprint debe ser idéntico al de la misma fila sin el campo:
    // ninguna evidencia CMR lo justifica en este profile.
    const withoutField = { ...row };
    delete (withoutField as { installmentRemaining?: number }).installmentRemaining;
    expect(computeFingerprint(row, { accountId: 'acc' })).toBe(
      computeFingerprint(withoutField, { accountId: 'acc' }),
    );
  });
});

describe('genérico tarjeta — columna Cuotas NO es conteo restante', () => {
  const parser = getParser('generico.tarjeta')!;

  it('Cuotas=6 no produce installmentRemaining', () => {
    const file = fromText(
      'tarjeta-generica.csv',
      ['Fecha;Descripcion;Monto;Cuotas', '05/02/2026;COMPRA SINTETICA;12.450;6'].join('\n'),
    );
    const statement = parser.parse(inputForFile(file));
    expect(statement.transactions[0]?.installmentRemaining).toBeUndefined();
  });
});

describe('genérico cuenta — columna Cuotas NO es conteo restante', () => {
  const parser = getParser('generico.cuenta')!;

  it('Cuotas=6 no produce installmentRemaining', () => {
    const file = fromText(
      'cuenta-generica.csv',
      ['Fecha;Descripcion;Cargo;Abono;Cuotas', '05/02/2026;PAGO SERVICIO;12.450;;6'].join('\n'),
    );
    const statement = parser.parse(inputForFile(file));
    expect(statement.transactions[0]?.installmentRemaining).toBeUndefined();
  });
});
