import { describe, expect, it } from 'vitest';
import { runCalibration, type CalibrationIo } from '../src/tooling/cli';

/**
 * La herramienta de calibración, atacada a propósito.
 *
 * Esta es la única superficie del proyecto que toca un archivo real de un banco
 * real. Todo lo demás trabaja con fixtures sintéticos. Así que las preguntas
 * que se hacen aquí no son "¿funciona?" sino "¿qué imprime cuando falla?" y
 * "¿qué se niega a leer?".
 *
 * La lógica vive en `src/tooling/cli` con su E/S inyectada precisamente para
 * que estas preguntas se puedan hacer en milisegundos y sin un archivo real a
 * la vista.
 */

const REPO = '/home/usuario/wealthfolio-chile';

const CARTOLA = [
  'Fecha;Descripcion;Cargo;Abono;Saldo',
  '03/02/2026;COMPRA WEBPAY LIDER;12.000;;488.000',
  '04/02/2026;PAC AGUAS ANDINAS;32.000;;456.000',
  '05/02/2026;SUELDO;;500.000;956.000',
].join('\n');

interface Capture {
  out: string[];
  err: string[];
  reads: string[];
}

function io(overrides: Partial<CalibrationIo> = {}): CalibrationIo & { capture: Capture } {
  const capture: Capture = { out: [], err: [], reads: [] };
  const base: CalibrationIo = {
    repoRoot: REPO,
    realpath: (path) => path,
    stat: () => ({ isDirectory: false, size: CARTOLA.length }),
    readFile: (path) => {
      capture.reads.push(path);
      return new TextEncoder().encode(CARTOLA);
    },
    isIgnored: () => true,
    stdout: (text) => capture.out.push(text),
    stderr: (text) => capture.err.push(text),
  };
  return { ...base, ...overrides, capture };
}

function textOf(capture: Capture): string {
  return [...capture.out, ...capture.err].join('\n');
}

describe('el camino feliz', () => {
  it('lee el archivo en su sitio y escribe el informe en stdout', () => {
    const context = io();
    const code = runCalibration(['/home/usuario/Descargas/cartola.csv'], context);

    expect(code).toBe(0);
    expect(context.capture.out.join('\n')).toContain('Detección');
    expect(context.capture.reads).toEqual(['/home/usuario/Descargas/cartola.csv']);
  });

  it('no escribe ningún archivo: la E/S inyectada no tiene con qué', () => {
    const context = io();
    runCalibration(['/home/usuario/Descargas/cartola.csv'], context);

    // La superficie completa de E/S del comando. Si algún día aparece aquí una
    // operación de escritura, este test es el que lo dice.
    expect(Object.keys(context).filter((key) => key !== 'capture').sort()).toEqual([
      'isIgnored',
      'readFile',
      'realpath',
      'repoRoot',
      'stat',
      'stderr',
      'stdout',
    ]);
  });
});

describe('fallar seguro', () => {
  it('sin argumentos explica el uso', () => {
    const context = io();
    expect(runCalibration([], context)).toBe(1);
    expect(textOf(context.capture)).toContain('Uso:');
  });

  it('un archivo que no existe no repite su nombre', () => {
    const context = io({ stat: () => undefined });
    const code = runCalibration(['/home/usuario/CartolaRut12345678.csv'], context);

    expect(code).toBe(1);
    expect(textOf(context.capture)).toContain('no existe');
    expect(textOf(context.capture)).not.toContain('CartolaRut');
    expect(textOf(context.capture)).not.toContain('12345678');
  });

  it('un directorio se rechaza como directorio', () => {
    const context = io({ stat: () => ({ isDirectory: true, size: 4096 }) });
    expect(runCalibration(['/home/usuario/Descargas'], context)).toBe(1);
    expect(textOf(context.capture)).toContain('un directorio');
  });

  it('un archivo vacío se rechaza antes de intentar leerlo', () => {
    const context = io({ stat: () => ({ isDirectory: false, size: 0 }) });
    expect(runCalibration(['/tmp/vacio.csv'], context)).toBe(1);
    expect(textOf(context.capture)).toContain('vacío');
    expect(context.capture.reads).toEqual([]);
  });

  it('un archivo enorme se rechaza sin leerlo, diciendo el límite', () => {
    const context = io({ stat: () => ({ isDirectory: false, size: 41 * 1024 * 1024 }) });
    expect(runCalibration(['/tmp/enorme.xlsx'], context)).toBe(1);
    expect(textOf(context.capture)).toContain('MB');
    expect(context.capture.reads).toEqual([]);
  });

  it('un archivo ilegible da un diagnóstico, no un stack', () => {
    const context = io({
      readFile: () => {
        throw new Error("EACCES: permission denied, open '/home/usuario/CartolaRut12345678.csv'");
      },
    });
    const code = runCalibration(['/home/usuario/CartolaRut12345678.csv'], context);

    expect(code).toBe(1);
    expect(textOf(context.capture)).not.toContain('CartolaRut');
    expect(textOf(context.capture)).not.toContain('/home/usuario');
    expect(textOf(context.capture)).not.toMatch(/\bat\s+\w+\s+\(/);
  });

  it('un contenido que ningún perfil reconoce nombra los perfiles disponibles', () => {
    const context = io({
      readFile: () => new TextEncoder().encode('esto no es una cartola\nni de lejos\n'),
    });
    const code = runCalibration(['/tmp/cualquiera.csv'], context);

    expect(code).toBe(1);
    expect(textOf(context.capture)).toContain('--parser');
    expect(textOf(context.capture)).toContain('generico.cuenta');
  });

  it('un perfil inexistente se dice como tal y lista los válidos', () => {
    const context = io();
    const code = runCalibration(['/tmp/c.csv', '--parser', 'banco-inventado'], context);

    expect(code).toBe(1);
    expect(textOf(context.capture)).toContain('banco-inventado');
    expect(textOf(context.capture)).toContain('generico.cuenta');
  });

  it('--parser sin valor es un error de uso, no un perfil indefinido', () => {
    const context = io();
    expect(runCalibration(['/tmp/c.csv', '--parser'], context)).toBe(1);
    expect(textOf(context.capture)).toContain('--parser');
  });

  it('el separador -- que deja pasar pnpm no es una opción', () => {
    const context = io();
    expect(runCalibration(['--', '/tmp/c.csv'], context)).toBe(0);
  });

  it('una bandera desconocida no se ignora en silencio', () => {
    const context = io();
    expect(runCalibration(['/tmp/c.csv', '--volcar-todo'], context)).toBe(1);
    expect(textOf(context.capture)).toContain('--volcar-todo');
  });

  it('el id del perfil no se confunde con el archivo', () => {
    // `--parser generico.cuenta /tmp/c.csv`: el id no empieza por `--`, así que
    // una búsqueda ingenua del primer argumento suelto lo toma como el archivo
    // y calibra un perfil contra su propio nombre.
    const context = io();
    const code = runCalibration(['--parser', 'generico.cuenta', '/tmp/c.csv'], context);

    expect(code).toBe(0);
    expect(context.capture.reads).toEqual(['/tmp/c.csv']);
  });
});

describe('dónde puede vivir una cartola', () => {
  it('fuera del repositorio, sin preguntar nada', () => {
    const context = io({
      isIgnored: () => {
        throw new Error('no se debería preguntar a Git por un archivo de fuera');
      },
    });
    expect(runCalibration(['/home/usuario/Descargas/cartola.csv'], context)).toBe(0);
  });

  it('dentro del repositorio, sólo en samples/private/', () => {
    const context = io();
    expect(runCalibration([`${REPO}/samples/private/cartola.csv`], context)).toBe(0);
  });

  it('un directorio ignorado que no es samples/private/ ya no basta', () => {
    // `.ai/` está ignorado y es justo donde se acumulan informes que se pegan
    // en otros sitios. "Ignorado" y "es el lugar de las cartolas" no son la
    // misma propiedad.
    const context = io();
    const code = runCalibration([`${REPO}/.ai/cartola.csv`], context);

    expect(code).toBe(1);
    expect(textOf(context.capture)).toContain('samples/private/');
  });

  it('samples/private/ deja de bastar si alguien lo saca del .gitignore', () => {
    const context = io({ isIgnored: () => false });
    expect(runCalibration([`${REPO}/samples/private/cartola.csv`], context)).toBe(1);
  });

  it('un enlace simbólico no es una puerta lateral', () => {
    // El enlace vive fuera; su destino está dentro del repositorio y sin
    // ignorar. Comparar la ruta escrita en vez de la resuelta lo aceptaría.
    const context = io({
      realpath: () => `${REPO}/addon/src/cartola.csv`,
      isIgnored: () => false,
    });
    const code = runCalibration(['/home/usuario/enlace.csv'], context);

    expect(code).toBe(1);
    expect(textOf(context.capture)).toContain('samples/private/');
  });

  it('una ruta relativa con .. se juzga por donde termina', () => {
    const context = io({ realpath: (path) => path.replace('/samples/private/../..', '') });
    const code = runCalibration([`${REPO}/samples/private/../../addon/cartola.csv`], context);

    expect(code).toBe(1);
  });

  it('el rechazo nombra la ruta relativa, nunca la del usuario', () => {
    const context = io();
    runCalibration([`${REPO}/addon/cartola.csv`], context);

    expect(textOf(context.capture)).toContain('addon/cartola.csv');
    expect(textOf(context.capture)).not.toContain('/home/usuario');
  });
});

describe('privacidad del informe', () => {
  const PRIVATE = [
    'Cartola Cuenta Corriente 000123456789',
    'Titular: Juan Perez Soto  RUT 12.345.678-5',
    'Tarjeta 4532 1122 3344 5566   correo juan.perez@example.com   fono +56 9 8765 4321',
    'Fecha;Descripcion;Cargo;Abono;Saldo',
    '03/02/2026;TRANSFERENCIA A MARIA GONZALEZ;120.000;;380.000',
    '04/02/2026;COMPRA FARMACIA CRUZ VERDE PROVIDENCIA;18.990;;361.010',
  ].join('\n');

  const FORBIDDEN: Array<[string, string]> = [
    ['un RUT', '12.345.678'],
    ['un RUT sin puntos', '12345678'],
    ['un nombre de titular', 'Juan Perez'],
    ['una contraparte', 'MARIA GONZALEZ'],
    ['un número de cuenta', '000123456789'],
    ['un número de tarjeta', '4532'],
    ['un correo', 'example.com'],
    ['un teléfono', '8765 4321'],
    ['una glosa', 'CRUZ VERDE'],
    ['un monto', '120.000'],
    ['el nombre del archivo', 'CartolaRut'],
  ];

  for (const [what, needle] of FORBIDDEN) {
    it(`el informe no contiene ${what}`, () => {
      const context = io({
        readFile: () => new TextEncoder().encode(PRIVATE),
        stat: () => ({ isDirectory: false, size: PRIVATE.length }),
      });
      runCalibration(['/home/usuario/CartolaRut_12345678_5.csv'], context);

      expect(textOf(context.capture)).not.toContain(needle);
    });
  }
});
