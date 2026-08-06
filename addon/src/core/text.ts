/**
 * Description normalisation.
 *
 * Every downstream stage — fingerprinting, merchant extraction, rule matching,
 * installment detection — compares descriptions. They all compare the *same*
 * normalised form produced here, so a rule that matches in the preview also
 * matches at import time and a fingerprint stays stable across re-imports.
 */

/** Fold accents and case: `Peluquería Ñuñoa` -> `PELUQUERIA NUNOA`. */
export function foldCase(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

/** Collapse every run of whitespace into a single space and trim. */
export function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Canonical form of a statement description.
 *
 * Accent- and case-folded, punctuation reduced to spaces, whitespace collapsed.
 * Digits are preserved: they carry installment counters (`1/6`) and the last
 * digits of card numbers, both of which later stages need.
 */
export function normalizeDescription(raw: string): string {
  return collapseSpaces(foldCase(String(raw ?? '')).replace(/[^A-Z0-9/.\-*]+/g, ' '));
}

/**
 * Aggressive form used only for grouping "the same merchant, different noise".
 *
 * Drops digits, single letters and separators entirely, so
 * `UBER *TRIP 4821 SANTIAGO` and `UBER *TRIP 9930 SANTIAGO` collapse together.
 * Never use this for fingerprints — it discards information on purpose.
 */
export function descriptionKey(raw: string): string {
  return collapseSpaces(
    normalizeDescription(raw)
      .replace(/[0-9]+/g, ' ')
      .replace(/[/.\-*]+/g, ' ')
      .replace(/\b[A-Z]\b/g, ' '),
  );
}

/** Levenshtein distance, capped so long strings cannot blow up the preview. */
export function editDistance(a: string, b: string, cap = 32): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      row.push(value);
      if (value < best) best = value;
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length] as number;
}

/** Similarity in 0..1 derived from {@link editDistance}. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  const distance = editDistance(a, b);
  return Math.max(0, 1 - distance / longest);
}

/** Tokens of a normalised description, useful for rule and merchant matching. */
export function tokens(normalized: string): string[] {
  return normalized.split(/[\s/.\-*]+/).filter((t) => t.length > 0);
}

/** True when `haystack` contains `needle`, both compared in folded form. */
export function containsFolded(haystack: string, needle: string): boolean {
  return foldCase(haystack).includes(foldCase(needle));
}

/** Trim a string to `max` characters, marking the cut so it reads as truncated. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
