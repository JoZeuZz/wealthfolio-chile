/**
 * Whether a real bank statement may be read from where it is sitting.
 *
 * The rule this enforces is the one `docs/PRIVACY.md` is built on: a cartola
 * never becomes a file Git can stage. The moment that is most likely to happen
 * is while somebody is calibrating a profile against one — the file is in hand,
 * the tool is convenient, and dropping it next to the code is the obvious
 * thing to do. So the tool refuses instead.
 *
 * Two outcomes:
 *
 * - outside the repository — allowed, and nothing to check;
 * - inside the repository — allowed only under `samples/private/`, and only
 *   while Git really ignores it.
 *
 * That second rule used to be "anywhere the repository ignores", which is a
 * different and weaker property. `.ai/`, `node_modules/`, `dist/` and
 * `coverage/` are all ignored, and none of them is a place a cartola belongs:
 * `.ai/` in particular is where agent reports accumulate, and those get pasted
 * into other tools. One directory is the place for private samples, it is
 * documented as such, and the guard now says only that one.
 *
 * The ignore question is still answered by Git rather than by re-implementing
 * `.gitignore`, which is why it is injected: the caller runs `git check-ignore`
 * and the tests pass a stub. It is asked even for `samples/private/`, because a
 * `.gitignore` somebody edited is exactly the case where the directory name
 * stops being a guarantee.
 *
 * Paths must be resolved — symlinks included — before they get here. A link
 * outside the tree pointing into it would otherwise pass the first check.
 */

export interface SampleGuardOptions {
  /** Absolute, symlink-resolved path to the repository root. */
  repoRoot: string;
  /** True when Git ignores this path. */
  isIgnored: (file: string) => boolean;
}

export type SampleVerdict = { allowed: true } | { allowed: false; reason: string };

/** The one directory inside the repository a real statement may sit in. */
export const PRIVATE_SAMPLES_DIR = 'samples/private';

export function guardPrivateSample(
  /** Absolute, symlink-resolved path to the file. */
  file: string,
  options: SampleGuardOptions,
): SampleVerdict {
  const root = trimTrailingSlash(options.repoRoot);
  if (file !== root && !file.startsWith(`${root}/`)) return { allowed: true };

  const inside = file.slice(root.length + 1);
  if (!inside.startsWith(`${PRIVATE_SAMPLES_DIR}/`)) {
    return {
      allowed: false,
      reason:
        `"${inside}" está dentro del repositorio y fuera de ${PRIVATE_SAMPLES_DIR}/.\n` +
        'Una cartola real vive fuera del repositorio, o en samples/private/, que existe\n' +
        'para eso y está ignorado. Que otra carpeta esté ignorada no la convierte en un\n' +
        'lugar para datos bancarios.\n' +
        'Ver docs/PRIVACY.md.',
    };
  }

  if (!options.isIgnored(file)) {
    return {
      allowed: false,
      reason:
        `"${inside}" está en ${PRIVATE_SAMPLES_DIR}/ pero Git no lo ignora, así que un\n` +
        '`git add -A` lo dejaría preparado para commit. Revisa .gitignore antes de seguir.\n' +
        'Ver docs/PRIVACY.md.',
    };
  }

  return { allowed: true };
}

function trimTrailingSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}
