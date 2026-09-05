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

function report(
  text: string,
  parserId = 'generico.cuenta',
  fileName = 'CartolaCuentaRut_12345678-9_202602.csv',
) {
  const file = fromText(fileName, text);
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

  it('las columnas mapeadas y las posiciones que el perfil no reconoce', () => {
    const header = report(CARTOLA).header;

    expect(header.mapped.map((column) => column.role)).toEqual(
      expect.arrayContaining(['date', 'description', 'debit', 'credit', 'balance']),
    );
    expect(header.unmapped.map((column) => column.column)).toContain(5);
    expect(header.mapped.every((column) => !('heading' in column))).toBe(true);
    expect(header.unmapped.every((column) => !('heading' in column))).toBe(true);
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

  it('ningún nombre de archivo ni identificador estable, sólo su extensión', () => {
    expect(text).not.toContain('CartolaCuentaRut');
    expect(text).toContain('.csv');
    expect(text).not.toContain('aaaaaaaaaaaa');
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

  it('no imprime texto libre de una cabecera aunque no parezca un identificador', () => {
    const withLeak = report(
      [
        'Fecha;Descripcion;Cargo;Abono;Nombre Titular Jose Rodriguez',
        '03/02/2026;COMPRA;45.000;;955.000',
      ].join('\n'),
    );

    expect(formatReport(withLeak)).not.toMatch(/Jose|Rodriguez/i);
  });

  it('sólo revela extensiones de formatos conocidos', () => {
    const withPrivateExtension = report(CARTOLA, 'generico.cuenta', 'cartola.Jose-Rodriguez');

    expect(formatReport(withPrivateExtension)).not.toMatch(/Jose|Rodriguez/i);
    expect(withPrivateExtension.file.extension).toBe('(no reconocida)');
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
      isIgnored: () => {
        asked = true;
        return false;
      },
    });

    expect(verdict.allowed).toBe(true);
    expect(asked).toBe(false);
  });

  it('dentro del repositorio, samples/private/ ignorado se acepta', () => {
    const verdict = guardPrivateSample(`${repoRoot}/samples/private/cartola.csv`, {
      repoRoot,
      isIgnored: () => true,
    });

    expect(verdict.allowed).toBe(true);
  });

  it('samples/private/ sin ignorar se rechaza, nombrando git add', () => {
    const verdict = guardPrivateSample(`${repoRoot}/samples/private/cartola.csv`, {
      repoRoot,
      isIgnored: () => false,
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/git add/i);
  });

  it('otra carpeta ignorada ya no basta: estar ignorada no es ser el lugar', () => {
    // `.ai/` está ignorado y es donde se acumulan informes que se pegan en
    // otras herramientas. La política anterior lo aceptaba.
    const verdict = guardPrivateSample(`${repoRoot}/.ai/cartola.csv`, {
      repoRoot,
      isIgnored: () => true,
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/samples\/private/);
  });

  it('un archivo dentro del repositorio y fuera de samples/private/ se rechaza', () => {
    const verdict = guardPrivateSample(`${repoRoot}/addon/cartola.csv`, {
      repoRoot,
      isIgnored: () => false,
    });

    expect(verdict.allowed).toBe(false);
  });

  it('el rechazo no refleja ninguna parte de la ruta privada', () => {
    const verdict = guardPrivateSample(`${repoRoot}/addon/cartola.csv`, {
      repoRoot,
      isIgnored: () => false,
    });

    if (!verdict.allowed) {
      expect(verdict.reason).not.toContain('addon/cartola.csv');
      expect(verdict.reason).not.toContain('/home/usuario');
    }
  });

  it('una carpeta que empieza igual que la raíz no está dentro de ella', () => {
    const verdict = guardPrivateSample('/home/usuario/wealthfolio-chile-backup/cartola.csv', {
      repoRoot,
      isIgnored: () => false,
    });

    expect(verdict.allowed).toBe(true);
  });
});
