import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCalibration, type CalibrationIo } from '../src/tooling/cli';

/**
 * Read one real cartola and print what a profile would need to learn from it.
 *
 *   pnpm --silent calibrate -- ~/Descargas/cartola.csv
 *   pnpm --silent calibrate -- ~/Descargas/cartola.xlsx --parser banco-chile.cuenta-corriente
 *
 * Everything this command decides lives in `src/tooling/cli`, which takes its
 * file system as an argument. This file is the wiring, and the wiring is the
 * only part that cannot be unit-tested: what it hands over is read-only by
 * construction, so there is nothing here that can copy a statement anywhere.
 */

const io: CalibrationIo = {
  // `scripts/` sits in `addon/`, so the repository root is two levels up. It is
  // resolved through symlinks because the guard compares resolved paths.
  repoRoot: realpathSync(resolve(import.meta.dirname, '..', '..')),
  realpath: (path) => {
    try {
      return realpathSync(resolve(path));
    } catch {
      return undefined;
    }
  },
  stat: (path) => {
    try {
      const facts = statSync(path);
      return { isDirectory: facts.isDirectory(), size: facts.size };
    } catch {
      return undefined;
    }
  },
  readFile: (path) => new Uint8Array(readFileSync(path)),
  isIgnored: (path) => gitIgnores(path),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

process.exitCode = runCalibration(process.argv.slice(2), io);

/**
 * Whether Git ignores this path.
 *
 * `git check-ignore` answers with the repository's real rules rather than with
 * a guess about them. Exit zero means ignored; anything else means Git would
 * pick the file up.
 */
function gitIgnores(file: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', file], {
      cwd: io.repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
