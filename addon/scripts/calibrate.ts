import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { sha256Hex } from '../src/core/hash';
import { loadWorkbook } from '../src/core/parsing/workbook';
import { calibrate, formatReport } from '../src/tooling/calibration';
import { guardPrivateSample } from '../src/tooling/sample-guard';

/**
 * Read one real cartola and print what a profile would need to learn from it.
 *
 *   pnpm calibrate -- ~/Descargas/cartola.csv
 *   pnpm calibrate -- ~/Descargas/cartola.xlsx --parser banco-chile.cuenta-corriente
 *
 * The file is read, held in memory for the length of one call, and never
 * written anywhere. Nothing is copied into the repository, into `.ai/`, or into
 * a temporary directory; the only output is the report on stdout, and the
 * report is counts, codes and column headings — see `src/tooling/calibration`
 * for exactly what it may and may not contain.
 *
 * Before any of that, {@link guardPrivateSample} refuses a file sitting
 * somewhere Git can see it. A real statement one `git add -A` away from a
 * commit is the failure this whole project is arranged to prevent, and the
 * moment it is most likely is while someone is calibrating against it.
 */

function main(): void {
  const args = process.argv.slice(2);
  const path = args.find((arg) => !arg.startsWith('--'));
  if (!path) {
    process.stderr.write(
      'Uso: pnpm calibrate -- <archivo> [--parser <id>]\n' +
        '\nEl archivo tiene que estar fuera del repositorio, o dentro de samples/private/.\n',
    );
    process.exitCode = 1;
    return;
  }

  const parserFlag = args.indexOf('--parser');
  const parserId = parserFlag >= 0 ? args[parserFlag + 1] : undefined;
  const absolute = resolve(path);

  const verdict = guardPrivateSample(absolute, {
    repoRoot: resolve(import.meta.dirname, '..', '..'),
    isTracked: (file, repoRoot) => gitSeesFile(file, repoRoot),
  });
  if (!verdict.allowed) {
    process.stderr.write(`${verdict.reason}\n`);
    process.exitCode = 1;
    return;
  }

  const bytes = new Uint8Array(readFileSync(absolute));
  const workbook = loadWorkbook({ name: basename(absolute), bytes });

  const report = calibrate({
    bytes,
    // Only the extension survives into the report, but the parsers read the
    // name for detection, so they get the real one and it stops here.
    fileName: basename(absolute),
    fileHash: sha256Hex(bytes),
    sheets: workbook.sheets,
    ...(parserId ? { parserId } : {}),
    accountId: 'calibracion',
  });

  process.stdout.write(`${formatReport(report)}\n`);
  process.stderr.write(
    `\nLeído ${statSync(absolute).size} bytes. No se copió el archivo a ninguna parte.\n`,
  );
}

/**
 * Whether Git would pick this file up.
 *
 * `git check-ignore` answers the question that matters — "is this path
 * ignored?" — and it answers it with the repository's real rules rather than
 * with a guess about them. A non-zero exit means *not* ignored, which for a
 * path inside the working tree means `git add -A` would stage it.
 */
function gitSeesFile(file: string, repoRoot: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', file], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return false;
  } catch {
    return true;
  }
}

main();
