import { sha256Hex } from '../core/hash';
import { loadWorkbook } from '../core/parsing/workbook';
import { redactSensitive } from '../core/privacy';
import { PARSERS, getParser } from '../core/providers/registry';
import { calibrate, formatReport } from './calibration';
import { guardPrivateSample } from './sample-guard';

/**
 * The calibration command, with its I/O held at arm's length.
 *
 * This is the only surface in the project that touches a real file from a real
 * bank; everything else works on synthetic fixtures. That makes the interesting
 * questions "what does it print when it fails" and "what does it refuse to
 * read", and neither can be asked of a script that reaches for `node:fs` on its
 * own. So the file system arrives as {@link CalibrationIo} and the tests answer
 * both in milliseconds, with no real statement anywhere near them.
 *
 * The I/O surface is also the guarantee that nothing is copied: there is no
 * write operation in it to call. A test asserts the shape of that interface for
 * exactly that reason.
 *
 * Every failure path here is written on the assumption that its output will be
 * pasted into a chat window. Node's own messages cannot be: `ENOENT: no such
 * file or directory, open '/home/ana/CartolaRut_12345678_5.csv'` carries a
 * national id, a name and a home directory, and it is the *first* thing a user
 * sees when they mistype the path.
 */

/** The 10 MB ceiling `ui/components/FileDrop` already applies to an import. */
const MAX_BYTES = 10 * 1024 * 1024;

export interface StatFacts {
  isDirectory: boolean;
  size: number;
}

export interface CalibrationIo {
  /** Absolute, symlink-resolved path to the repository root. */
  repoRoot: string;
  /** Resolve symlinks and relative segments. `undefined` when the path does not exist. */
  realpath: (path: string) => string | undefined;
  /** `undefined` when there is nothing there. */
  stat: (path: string) => StatFacts | undefined;
  readFile: (path: string) => Uint8Array;
  /** True when Git ignores the path. Only asked about paths inside the repository. */
  isIgnored: (path: string) => boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = [
  'Uso: pnpm calibrate -- <archivo> [--parser <id>]',
  '',
  'El archivo tiene que estar fuera del repositorio, o en samples/private/.',
  'Se lee en su sitio: no se copia, no se guarda y no se deja ningún rastro.',
].join('\n');

/** Runs one calibration. Returns the process exit code. */
export function runCalibration(argv: readonly string[], io: CalibrationIo): number {
  const parsed = parseArguments(argv);
  if ('error' in parsed) return fail(io, `${parsed.error}\n\n${USAGE}`);

  const resolved = io.realpath(parsed.file);
  if (resolved === undefined) return fail(io, 'El archivo indicado no existe.');

  // The guard runs on the resolved path, not the written one: a symlink from
  // outside the tree pointing into it would otherwise walk straight past the
  // "is it inside the repository" question.
  const verdict = guardPrivateSample(resolved, {
    repoRoot: io.repoRoot,
    isIgnored: io.isIgnored,
  });
  if (!verdict.allowed) return fail(io, verdict.reason);

  const facts = io.stat(resolved);
  if (facts === undefined) return fail(io, 'El archivo indicado no existe.');
  if (facts.isDirectory) {
    return fail(io, 'Eso es un directorio. Indica el archivo de la cartola.');
  }
  if (facts.size === 0) return fail(io, 'El archivo está vacío: no hay nada que calibrar.');
  if (facts.size > MAX_BYTES) {
    // Refused before reading, not after: the point of a size limit is to not
    // load the thing.
    return fail(
      io,
      `El archivo pesa ${Math.round(facts.size / (1024 * 1024))} MB y el máximo son ` +
        `${MAX_BYTES / (1024 * 1024)} MB. Una cartola bancaria no llega a eso: comprueba ` +
        'que sea el archivo correcto.',
    );
  }

  if (parsed.parserId !== undefined && getParser(parsed.parserId) === undefined) {
    return fail(io, `No existe el perfil "${parsed.parserId}".\n\n${parserList()}`);
  }

  let bytes: Uint8Array;
  try {
    bytes = io.readFile(resolved);
  } catch (error) {
    return fail(io, `No se pudo leer el archivo (${errorKind(error)}).`);
  }

  const name = baseName(parsed.file);
  let report: string;
  try {
    const workbook = loadWorkbook({ name, bytes });
    report = formatReport(
      calibrate({
        bytes,
        // The parsers read the name for detection, so they get the real one and
        // it stops there: only the extension reaches the report.
        fileName: name,
        fileHash: sha256Hex(bytes),
        sheets: workbook.sheets,
        ...(parsed.parserId !== undefined ? { parserId: parsed.parserId } : {}),
        accountId: 'calibracion',
      }),
    );
  } catch (error) {
    return fail(io, `${safeMessage(error)}\n\n${parserList()}`);
  }

  io.stdout(`${report}\n`);
  io.stderr(`\nLeído en su sitio. No se copió el archivo a ninguna parte.\n`);
  return 0;
}

interface ParsedArguments {
  file: string;
  parserId?: string;
}

/**
 * Argument parsing that cannot mistake a profile id for a file.
 *
 * "the first argument that does not start with `--`" reads
 * `--parser generico.cuenta ~/cartola.csv` as a request to calibrate a file
 * called `generico.cuenta`, and then reports on the profile's own name.
 */
function parseArguments(argv: readonly string[]): ParsedArguments | { error: string } {
  let file: string | undefined;
  let parserId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i] as string;
    // `pnpm calibrate -- file` can hand the separator through to the script
    // depending on the runner. It is a separator, not an option.
    if (argument === '--') continue;
    if (argument === '--parser') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: '--parser necesita el id de un perfil.' };
      }
      parserId = value;
      i += 1;
      continue;
    }
    if (argument.startsWith('--')) {
      return { error: `No conozco la opción ${argument}.` };
    }
    if (file !== undefined) {
      return { error: 'Indica un solo archivo.' };
    }
    file = argument;
  }

  if (file === undefined) return { error: 'Falta el archivo.' };
  return { file, ...(parserId !== undefined ? { parserId } : {}) };
}

function parserList(): string {
  return ['Perfiles disponibles:', ...PARSERS.map((parser) => `  ${parser.id}`)].join('\n');
}

/**
 * What went wrong, without saying where.
 *
 * A file-system error names the path, and the path is the single most sensitive
 * string in this whole command — Chilean banks put the account holder's RUT in
 * the download name. So the message is thrown away and only the class of
 * failure survives.
 */
function errorKind(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'error de lectura';
}

/**
 * A parser's own message, sanitised.
 *
 * These are written by this project and say things like "no se reconoció la
 * cabecera", but they can quote a cell, and a stack trace quotes file paths. So
 * the trace is dropped, anything path-shaped is removed, and what is left goes
 * through the same redactor every log line uses.
 */
function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutPaths = raw
    .split(/\s+/)
    .map((word) => (word.includes('/') || word.includes('\\') ? '[ruta]' : word))
    .join(' ');
  return redactSensitive(withoutPaths.split('\n')[0] as string);
}

/** The last path segment, without importing `node:path` into a pure module. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return (parts[parts.length - 1] as string) || path;
}

function fail(io: CalibrationIo, message: string): number {
  io.stderr(`${message}\n`);
  return 1;
}
