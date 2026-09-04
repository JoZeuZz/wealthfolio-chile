import { describe, expect, it } from 'vitest';
import { calibrate, formatReport } from '../src/tooling/calibration';
import { guardPrivateSample } from '../src/tooling/sample-guard';
import { loadWorkbook } from '../src/core/parsing/workbook';
import { fromText } from './fixtures';

/**
 * El informe de calibración.
 *
 * Existe para una situación concreta que todavía no ha ocurrido: llega la
 * primera cartola real, discrepa de un perfil escrito contra documentación, y
 * hay que averiguar en qué. Lo que hace falta es qué columna quedó sin mapear,
 * qué filas fallaron, si la columna de saldo camina y si el separador decimal
 * se leyó como el banco lo escribió.
 *
 * Y lo que no puede salir es la cartola. Un informe así se pega en un issue, se
 * lee por encima del hombro y se guarda en un portapapeles, así que la mitad de
 * estos tests no comprueban que diga la verdad sino que **no diga** los datos.
 */

const CARTOLA = [
  'Banco Generico — Cartola',
  'Cuenta Corriente N: 00-123-45678-90',
  'Titular: JUAN PEREZ GONZALEZ',
  'RUT: 12.345.678-9',
  '',
  'Fecha;Descripcion;Cargo;Abono;Saldo;Sucursal',
  '03/02/2026;COMPRA SUPERMERCADO LIDER PROVIDENCIA;45.000;;955.000;PROVIDENCIA',
  '04/02/2026;ABONO SUELDO EMPRESA;;1.200.000;2.155.000;CASA MATRIZ',
  '05/02/2026;GIRO CAJERO AUTOMATICO;40.000;;2.115.000;NUNOA',
].join('\n');

function report(text: string, parserId = 'generico.cuenta') {
  const file = fromText('CartolaCuentaRut_12345678-9_202602.csv', text);
  const workbook = loadWorkbook(file);
  return calibrate({
    bytes: file.bytes,
    fileName: file.name,
    fileHash: 'a'.repeat(64),
    sheets: workbook.sheets,
    parserId,
    accountId: 'calibracion',
  });
}

describe('lo que el informe sí dice', () => {
  it('con qué perfil se leyó y con cuánta confianza', () => {
    const facts = report(CARTOLA).detection;
    expect(facts.parser).toBe('generico.cuenta');
    expect(facts.score).toBeGreaterThan(0);
  });

  it('las columnas mapeadas y, sobre todo, las que no', () => {
    const header = report(CARTOLA).header;

    expect(header.mapped.map((column) => column.role)).toEqual(
      expect.arrayContaining(['date', 'description', 'debit', 'credit', 'balance']),
    );
    // `Sucursal` es exactamente el hallazgo: una columna que el banco imprime y
    // el perfil ignora.
    expect(header.unmapped.map((column) => column.heading)).toContain('Sucursal');
  });

  it('cuántas filas se leyeron y cuántas no', () => {
    const rows = report(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;COMPRA;45.000;;955.000',
        '04/02/2026;IMPOSIBLE;5.000;5.000;950.000',
      ].join('\n'),
    ).rows;

    expect(rows.data).toBe(2);
    expect(rows.mapped).toBe(1);
    expect(rows.failed).toBe(1);
    expect(rows.failedLines.length).toBeGreaterThan(0);
  });

  it('en qué escala decimal quedaron los montos', () => {
    // Todo a escala 0 es lo normal en una cartola en pesos. Una nube de
    // escala 2 diría que el separador de miles se leyó como decimal, que es el
    // error más caro que este pipeline puede cometer y no se ve en un conteo
    // de filas.
    const amounts = report(CARTOLA).amounts;
    expect(amounts.byScale).toEqual([{ scale: 0, rows: 3 }]);
    expect(amounts.outflows).toBe(2);
    expect(amounts.inflows).toBe(1);
  });

  it('en qué orden vienen las fechas', () => {
    expect(report(CARTOLA).dates.order).toBe('ascending');
    expect(
      report(
        [
          'Fecha;Descripcion;Cargo;Abono;Saldo',
          '05/02/2026;A;1.000;;99.000',
          '03/02/2026;B;1.000;;98.000',
        ].join('\n'),
      ).dates.order,
    ).toBe('descending');
  });

  it('cómo descuadra el saldo, no cuánto', () => {
    // El signo invertido: el saldo sube donde el monto dice que baja.
    const balances = report(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;A;1.000;;100.000',
        '04/02/2026;B;1.000;;101.000',
      ].join('\n'),
    ).balances;

    expect(balances.steps).toBe(1);
    expect(balances.mismatches).toBe(1);
    expect(balances.mismatchKinds).toEqual([{ kind: 'sign', count: 1 }]);
  });

  it('un descuadre por factor de cien se nombra como tal', () => {
    // El saldo baja 10 donde el cargo dice 1.000: el separador de miles de la
    // columna de saldo se leyó como decimal. Es la clase de error, no su
    // tamaño, lo que corrige un perfil.
    const balances = report(
      [
        'Fecha;Descripcion;Cargo;Abono;Saldo',
        '03/02/2026;A;1.000;;100.000',
        '04/02/2026;B;1.000;;99.990',
      ].join('\n'),
    ).balances;

    expect(balances.mismatches).toBe(1);
    expect(balances.mismatchKinds).toEqual([{ kind: 'scale-100', count: 1 }]);
  });

  it('cuántas filas quedaron sin clasificar', () => {
    const classification = report(CARTOLA).classification;
    expect(classification.byKind.length).toBeGreaterThan(0);
    expect(typeof classification.unknown).toBe('number');
    expect(typeof classification.suggested).toBe('number');
  });

  it('los avisos, agrupados por código', () => {
    const issues = report(CARTOLA).issues;
    expect(issues.every((issue) => typeof issue.code === 'string' && issue.count > 0)).toBe(true);
  });
});

describe('lo que el informe no puede decir nunca', () => {
  const text = formatReport(report(CARTOLA));

  it('ninguna glosa', () => {
    expect(text).not.toMatch(/SUPERMERCADO|LIDER|SUELDO|CAJERO|PROVIDENCIA|NUNOA/i);
  });

  it('ningún nombre de titular', () => {
    expect(text).not.toMatch(/JUAN|PEREZ|GONZALEZ/i);
  });

  it('ningún RUT ni número de cuenta', () => {
    expect(text).not.toContain('12.345.678');
    expect(text).not.toContain('12345678');
    expect(text).not.toContain('45678-90');
  });

  it('ningún monto', () => {
    expect(text).not.toContain('45.000');
    expect(text).not.toContain('1.200.000');
    expect(text).not.toContain('2.155.000');
  });

  it('ningún nombre de archivo, sólo su extensión y su huella', () => {
    expect(text).not.toContain('CartolaCuentaRut');
    expect(text).toContain('.csv');
    expect(text).toContain('aaaaaaaaaaaa');
  });

  it('y una cabecera que llevara un número de cuenta también se redacta', () => {
    const withLeak = report(
      [
        'Fecha;Descripcion;Cargo;Abono;Cuenta 001234567890',
        '03/02/2026;COMPRA;45.000;;955.000',
      ].join('\n'),
    );
    const printed = formatReport(withLeak);
    expect(printed).not.toContain('001234567890');
  });
});

/**
 * El archivo privado no puede quedar donde Git lo vea.
 *
 * Es el momento de mayor riesgo de todo el proyecto: la cartola está en la
 * mano, la herramienta es cómoda, y dejarla junto al código es lo natural. Así
 * que la herramienta se niega.
 */
describe('guarda del archivo privado', () => {
  const repoRoot = '/home/usuario/wealthfolio-chile';

  it('un archivo fuera del repositorio se acepta sin preguntar a Git', () => {
    let asked = false;
    const verdict = guardPrivateSample('/home/usuario/Descargas/cartola.csv', {
      repoRoot,
      isTracked: () => {
        asked = true;
        return true;
      },
    });

    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(false);
  });

  it('un archivo dentro del repositorio que Git ignora se acepta', () => {
    const verdict = guardPrivateSample(`${repoRoot}/samples/private/cartola.csv`, {
      repoRoot,
      isTracked: () => false,
    });

    expect(verdict.allowed).toBe(true);
  });

  it('un archivo dentro del repositorio que Git no ignora se rechaza', () => {
    const verdict = guardPrivateSample(`${repoRoot}/addon/cartola.csv`, {
      repoRoot,
      isTracked: () => true,
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toMatch(/git add/i);
      expect(verdict.reason).toMatch(/samples\/private/);
    }
  });

  it('el rechazo nombra la ruta relativa, no la absoluta del usuario', () => {
    const verdict = guardPrivateSample(`${repoRoot}/addon/cartola.csv`, {
      repoRoot,
      isTracked: () => true,
    });

    if (!verdict.allowed) {
      expect(verdict.reason).toContain('addon/cartola.csv');
      expect(verdict.reason).not.toContain('/home/usuario');
    }
  });
});
