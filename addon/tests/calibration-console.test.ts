import { describe, expect, it, vi } from 'vitest';

const workbookProbe = vi.hoisted(() => ({ message: '' }));

vi.mock('../src/core/parsing/workbook', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/parsing/workbook')>();
  return {
    ...actual,
    loadWorkbook: (...args: Parameters<typeof actual.loadWorkbook>) => {
      if (workbookProbe.message) globalThis['console'].error(workbookProbe.message);
      return actual.loadWorkbook(...args);
    },
  };
});

import { runCalibration, type CalibrationIo } from '../src/tooling/cli';

describe('salida lateral de librerías', () => {
  it('silencia console durante la decodificación y lo restaura después', async () => {
    const bytes = new TextEncoder().encode(
      ['Fecha;Descripcion;Cargo', '03/02/2026;COMPRA;1.000'].join('\n'),
    );
    const io: CalibrationIo = {
      repoRoot: '/repo',
      realpath: (path) => path,
      stat: () => ({ isDirectory: false, size: bytes.length }),
      readFile: () => bytes,
      isIgnored: () => true,
      stdout: () => undefined,
      stderr: () => undefined,
    };
    const error = vi.spyOn(globalThis['console'], 'error').mockImplementation(() => undefined);
    workbookProbe.message = 'JOSE RODRIGUEZ CUENTA 12345678';

    await runCalibration(['/tmp/cartola.csv'], io);
    globalThis['console'].error('visible después');

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('visible después');
    workbookProbe.message = '';
    error.mockRestore();
  });
});
