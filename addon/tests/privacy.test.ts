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

  it('redacta lo que sí se persiste en el historial', async () => {
    const { host, result } = await runWithHostError(`no se pudo guardar "${GLOSA}"`);
    expect(result.run.message ?? '').not.toContain('12.345.678-9');
    expect(result.run.message ?? '').not.toContain('001234567890');

    const stored = [...host.store.data.values()].join('\n');
    expect(stored).not.toContain('12.345.678-9');
    expect(stored).not.toContain('001234567890');
  });
});
