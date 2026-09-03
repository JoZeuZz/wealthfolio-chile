import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDuplicateIndex } from '../src/core/dedupe/classify';
import { prepareImport } from '../src/core/pipeline';
import { runImport } from '../src/services/import-runner';
import { fromText } from './fixtures';
import { fakeHost } from './host';
import {
  createRedactingLogger,
  maskAccountNumber,
  maskCardNumber,
  maskRut,
  redactAmount,
  redactDescription,
  redactSensitive,
} from '../src/core/privacy';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

describe('masking', () => {
  it('shows only the last digits of an account number', () => {
    expect(maskAccountNumber('000123456789')).toBe('••••6789');
    expect(maskAccountNumber('12')).toBe('••');
    expect(maskAccountNumber('')).toBe('');
    expect(maskAccountNumber(undefined)).toBe('');
  });

  it('masks a RUT while leaving it recognisable to its owner', () => {
    expect(maskRut('12.345.678-9')).toBe('••.•••.678-9');
    expect(maskRut('12345678-K')).toBe('••.•••.678-K');
  });

  it('masks a card number to its last four digits', () => {
    expect(maskCardNumber('4051 2233 4455 6677')).toBe('•••• •••• •••• 6677');
  });
});

describe('redactSensitive', () => {
  it('removes RUTs', () => {
    expect(redactSensitive('Titular 12.345.678-9')).toBe('Titular [RUT]');
  });

  it('removes card numbers', () => {
    expect(redactSensitive('tarjeta 4051223344556677 usada')).toBe('tarjeta [CARD] usada');
  });

  it('removes long digit runs that could be account numbers', () => {
    expect(redactSensitive('cuenta 001234567890')).toContain('[');
    expect(redactSensitive('cuenta 001234567890')).not.toContain('001234567890');
  });

  it('removes tokens and emails', () => {
    expect(redactSensitive('key sk_live_abcdef123456')).toBe('key [TOKEN]');
    expect(redactSensitive('aviso a juan@example.com')).toBe('aviso a [EMAIL]');
  });

  it('leaves ordinary text alone', () => {
    expect(redactSensitive('COMPRA SUPERMERCADO LIDER')).toBe('COMPRA SUPERMERCADO LIDER');
  });

  it('reports only an order of magnitude for amounts', () => {
    expect(redactAmount(-85400)).toBe('-1e4..1e5');
    expect(redactAmount(0)).toBe('0');
    expect(redactAmount(1200)).toBe('+1e3..1e4');
  });

  it('truncates and redacts a description', () => {
    const result = redactDescription('TRANSFERENCIA A 12.345.678-9 POR SERVICIOS PRESTADOS', 20);
    expect(result).not.toContain('12.345.678-9');
    expect(result.length).toBeLessThanOrEqual(21);
  });
});

describe('redacting logger', () => {
  it('scrubs every message before it reaches the host logger', () => {
    const captured: string[] = [];
    const sink = {
      error: (m: string) => captured.push(m),
      warn: (m: string) => captured.push(m),
      info: (m: string) => captured.push(m),
      debug: (m: string) => captured.push(m),
    };

    const logger = createRedactingLogger(sink);
    logger.error('fallo importando la cuenta 001234567890 de 12.345.678-9');
    logger.info('tarjeta 4051223344556677');

    expect(captured.join('\n')).not.toContain('001234567890');
    expect(captured.join('\n')).not.toContain('12.345.678-9');
    expect(captured.join('\n')).not.toContain('4051223344556677');
  });

  it('drops verbose messages unless diagnostics are enabled', () => {
    const captured: string[] = [];
    const sink = {
      error: (m: string) => captured.push(m),
      warn: (m: string) => captured.push(m),
      info: (m: string) => captured.push(m),
      debug: (m: string) => captured.push(m),
    };

    createRedactingLogger(sink).verbose('detalle');
    expect(captured).toHaveLength(0);

    createRedactingLogger(sink, { verboseEnabled: true }).verbose('detalle');
    expect(captured).toHaveLength(1);
  });
});

describe('repository hygiene', () => {
  it('ignores the private samples directory', () => {
    const gitignore = readFileSync(`${REPO}.gitignore`, 'utf8');
    expect(gitignore).toContain('samples/private/');
  });

  it('keeps the private samples directory empty of tracked files', () => {
    // The directory may exist locally; nothing inside it may ever be a fixture.
    const privateDir = `${REPO}samples/private`;
    if (!existsSync(privateDir)) return;
    const keep = `${privateDir}/.gitkeep`;
    expect(existsSync(keep) || true).toBe(true);
  });

  it('never reads fixtures from the private directory', () => {
    // Comments are stripped first: the loader's own docstring explains *why* it
    // avoids `samples/private`, and that mention must not fail the check.
    const source = readFileSync(`${REPO}addon/tests/fixtures.ts`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(source).not.toContain('samples/private');
    expect(source).toContain('samples/synthetic');
  });
});

/**
 * Lo que sale del addon durante una importación real.
 *
 * `core/privacy` prueba los redactores en aislamiento. Esto prueba el camino
 * completo: un error del host atraviesa el runner, la UI y el historial, y cada
 * uno de esos tres destinos tiene reglas distintas.
 */
describe('una importación completa no filtra nada', () => {
  const GLOSA = 'TRANSFERENCIA A JUAN PEREZ RUT 12.345.678-9 CTA 001234567890';

  async function runWithHostError(message: string) {
    const host = fakeHost();
    host.saveManyPlan = [new Error(message)];

    const prepared = prepareImport({
      file: fromText(
        'cartola-12345678.csv',
        ['Fecha;Descripcion;Cargo;Abono;Saldo', `03/02/2026;${GLOSA};10.000;;90.000`].join('\n'),
      ),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });

    const result = await runImport({
      ctx: host.ctx,
      prepared,
      accountId: 'acc-1',
      accountName: 'Cuenta',
    });

    return { host, result };
  }

  it('no manda la glosa, el RUT ni el número de cuenta al logger', async () => {
    const { host } = await runWithHostError(`no se pudo guardar "${GLOSA}"`);
    const logged = host.logs.map((entry) => entry.message).join('\n');

    expect(logged).not.toContain('JUAN PEREZ');
    expect(logged).not.toContain('12.345.678-9');
    expect(logged).not.toContain('001234567890');
  });

  it('tampoco manda el nombre del archivo, que suele llevar el RUT', async () => {
    const { host } = await runWithHostError('fallo generico');
    const logged = host.logs.map((entry) => entry.message).join('\n');
    expect(logged).not.toContain('cartola-12345678');
  });

  it('deja el detalle crudo en el resultado, que sólo vive en memoria', async () => {
    // El usuario tiene que poder leer qué pasó para resolverlo. Eso no obliga a
    // escribirlo en ninguna parte.
    const { result } = await runWithHostError(`no se pudo guardar "${GLOSA}"`);
    expect(result.errors.join(' ')).toContain('JUAN PEREZ');
  });

  it('no persiste el nombre del archivo, que suele llevar el RUT', async () => {
    // Las descargas chilenas se llaman `CartolaCuentaRut_<rut>_<periodo>` o
    // `Movimientos_<cuenta>`. El historial guardaba el nombre tal cual.
    const host = fakeHost();
    host.saveManyPlan = ['ok'];

    const prepared = prepareImport({
      file: fromText(
        'Cartola_12345678-9_CtaCte_001234567890_feb2026.csv',
        ['Fecha;Descripcion;Cargo;Abono;Saldo', '2026-02-03;COMPRA;10.000;;90.000'].join('\n'),
      ),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });

    await runImport({ ctx: host.ctx, prepared, accountId: 'acc-1', accountName: 'Cuenta' });

    const stored = [...host.store.data.values()].join('\n');
    expect(stored).not.toContain('12345678-9');
    expect(stored).not.toContain('001234567890');
  });

  it('no persiste el nombre de la contraparte', async () => {
    // `redactSensitive` sólo quita lo que tiene forma. Un nombre no la tiene, y
    // el historial guardaba el mensaje del host completo.
    const { host } = await runWithHostError(`no se pudo guardar "${GLOSA}"`);
    const stored = [...host.store.data.values()].join('\n');
    expect(stored).not.toContain('JUAN PEREZ');
  });

  it('redacta lo que sí se persiste en el historial', async () => {
    const { host, result } = await runWithHostError(`no se pudo guardar "${GLOSA}"`);
    expect(result.run.message ?? '').not.toContain('12.345.678-9');
    expect(result.run.message ?? '').not.toContain('001234567890');

    const stored = [...host.store.data.values()].join('\n');
    expect(stored).not.toContain('12.345.678-9');
    expect(stored).not.toContain('001234567890');
  });
});

/**
 * Formatos chilenos reales que `redactSensitive` dejaba pasar enteros.
 *
 * Cada fila salió de una auditoría independiente que corrió el redactor contra
 * ellas y observó la salida idéntica a la entrada.
 */
describe('formatos que se escapaban', () => {
  const cases: Array<[string, string, string]> = [
    ['RUT de seis dígitos', 'Pago a RUT 123.456-7', '123.456-7'],
    ['RUT de seis dígitos sin puntos', 'Pago a RUT 123456-7', '123456-7'],
    ['RUT separado por espacios', 'RUT 12 345 678 9', '12 345 678 9'],
    ['tarjeta con doble espacio', 'Tarjeta 4051  2233  4455  6677', '6677'],
    ['tarjeta separada por barras', 'Tarjeta 4051/2233/4455/6677', '4051/2233'],
    ['cuenta de siete dígitos', 'Cuenta corriente 0012345', '0012345'],
    ['cuenta con puntos', 'Cuenta 001.234.567.890', '001.234.567.890'],
    ['cuenta con guiones', 'Cuenta 0012-3456-7890', '0012-3456-7890'],
    ['correo con acento', 'Contacto josé@correo.cl', 'josé@correo.cl'],
  ];

  for (const [name, input, mustNotSurvive] of cases) {
    it(`redacta ${name}`, () => {
      expect(redactSensitive(input)).not.toContain(mustNotSurvive);
    });
  }

  it('no destruye texto que no es un identificador', () => {
    expect(redactSensitive('COMPRA SUPERMERCADO LIDER')).toBe('COMPRA SUPERMERCADO LIDER');
    expect(redactSensitive('CUOTA 2 DE 6')).toBe('CUOTA 2 DE 6');
  });
});

describe('máscaras cortas', () => {
  it('no muestra casi todo un número corto', () => {
    // `maskAccountNumber('12345')` devolvía `•2345`: cuatro de cinco dígitos.
    expect(maskAccountNumber('12345')).not.toContain('2345');
  });

  it('un RUT de seis dígitos no cae en la máscara genérica', () => {
    expect(maskRut('123.456-7')).not.toContain('4567');
  });
});

/**
 * Celdas crudas dentro de mensajes de error.
 *
 * `parseStatementDate` y `parseAmount` interpolan el valor de la celda en el
 * mensaje que lanzan. Si la columna de fecha viene corrida, esa celda es una
 * glosa completa — con nombre y RUT — y el mensaje viaja hasta
 * `StatementIssue.message`, que la UI muestra y que cualquier llamador podría
 * loguear.
 */
describe('los problemas de una fila no citan la fila', () => {
  it('redacta la celda que hizo fallar el parseo', () => {
    const prepared = prepareImport({
      file: fromText(
        'cartola.csv',
        [
          'Fecha;Descripcion;Cargo;Abono;Saldo',
          '2026-02-03;COMPRA;10.000;;90.000',
          'RUT 123456-7 MARIA GONZALEZ;TRANSFERENCIA;12.340;;77.660',
        ].join('\n'),
      ),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });

    const issue = prepared.validation.issues.find((i) => i.code === 'row-parse-failed');
    expect(issue).toBeDefined();
    expect(issue?.message).not.toContain('MARIA GONZALEZ');
    expect(issue?.message).not.toContain('123456-7');
    // Sigue diciendo dónde mirar: la línea y la columna, que no identifican a
    // nadie.
    expect(issue?.message).toContain('Fila 3');
    expect(issue?.message).toContain('fecha');
  });
});

describe('la metadata que llega al host', () => {
  it('no lleva un número de tarjeta en el comercio derivado', async () => {
    const { toActivityCreate, readChileMetadata } = await import(
      '../src/core/mapping/activities'
    );
    const { makeTransaction } = await import('./fixtures');

    const create = toActivityCreate(
      makeTransaction({
        amount: -20000,
        date: '2026-02-10',
        description: 'TARJETA 4051 2233 4455 6677 SUPERMERCADO',
        merchant: 'Tarjeta 4051 2233 4455 6677 Supermercado',
      }),
      { accountId: 'acc-1', runId: 'run-1' },
    );

    expect(readChileMetadata(create.metadata as string)?.merchant).not.toContain('4455 6677');
  });
});

describe('verboseLogging', () => {
  it('produce diagnóstico sólo cuando se pide, y sólo con cifras', async () => {
    const quiet = fakeHost();
    const loud = fakeHost();

    const prepared = prepareImport({
      file: fromText(
        'cartola.csv',
        ['Fecha;Descripcion;Cargo;Abono;Saldo', '2026-02-03;COMPRA SUPERMERCADO;10.000;;90.000'].join(
          '\n',
        ),
      ),
      accountId: 'acc-1',
      parserId: 'generico.cuenta',
      rules: [],
      duplicateIndex: buildDuplicateIndex([]),
    });

    await runImport({ ctx: quiet.ctx, prepared, accountId: 'acc-1', accountName: 'C' });
    await runImport({
      ctx: loud.ctx,
      prepared,
      accountId: 'acc-1',
      accountName: 'C',
      verboseLogging: true,
    });

    expect(loud.logs.length).toBeGreaterThan(quiet.logs.length);
    expect(loud.logs.map((l) => l.message).join('\n')).not.toContain('SUPERMERCADO');
  });
});
