import { relative, sep } from 'node:path';

/**
 * Whether a real bank statement may be read from where it is sitting.
 *
 * The rule this enforces is the one `docs/PRIVACY.md` is built on: a cartola
 * never becomes a file Git can stage. The moment that is most likely to happen
 * is while somebody is calibrating a profile against one — the file is in hand,
 * the tool is convenient, and dropping it next to the code is the obvious
 * thing to do. So the tool refuses instead.
 *
 * Three outcomes, and the middle one is the point:
 *
 * - outside the repository — allowed, and nothing to check;
 * - inside the repository and ignored (`samples/private/`, `*.cartola.*`) —
 *   allowed, because that is what those rules exist for;
 * - inside the repository and *not* ignored — refused, naming the two ways out.
 *
 * "Ignored" is answered by Git itself rather than by re-implementing
 * `.gitignore`, which is why the check is injected: the caller runs
 * `git check-ignore`, and the tests run a stub.
 */

export interface SampleGuardOptions {
  /** Absolute path to the repository root. */
  repoRoot: string;
  /** True when Git would stage this file, i.e. it is not ignored. */
  isTracked: (file: string, repoRoot: string) => boolean;
}

export type SampleVerdict = { allowed: true } | { allowed: false; reason: string };

export function guardPrivateSample(
  file: string,
  options: SampleGuardOptions,
): SampleVerdict {
  const inside = relative(options.repoRoot, file);
  const outsideRepo = inside.startsWith('..') || inside.startsWith(sep) || inside === '';
  if (outsideRepo) return { allowed: true };

  if (!options.isTracked(file, options.repoRoot)) return { allowed: true };

  return {
    allowed: false,
    reason:
      `"${inside}" está dentro del repositorio y Git no lo ignora, así que un ` +
      '`git add -A` lo dejaría preparado para commit.\n' +
      'Muévelo fuera del repositorio, o a samples/private/, que está ignorado a propósito.\n' +
      'Ver docs/PRIVACY.md.',
  };
}
