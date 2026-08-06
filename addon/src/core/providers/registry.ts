import { DETECTION_FLOOR, type DetectionResult } from '../model/statement';
import { bancoChileCardParser, bancoChileCheckingParser } from './banco-chile';
import { bancoEstadoParser } from './banco-estado';
import { falabellaAccountParser, falabellaCardParser } from './banco-falabella';
import { genericCardParser, genericCheckingParser } from './generic';
import type { ParserInput, StatementParser } from './parser';

/**
 * The parser registry.
 *
 * Order matters only for tie-breaking: bank adapters come first so that when a
 * file scores identically against a bank and the generic fallback, the bank
 * wins. Everything else is decided by score.
 */
export const PARSERS: readonly StatementParser[] = [
  bancoChileCheckingParser,
  bancoChileCardParser,
  bancoEstadoParser,
  falabellaCardParser,
  falabellaAccountParser,
  genericCheckingParser,
  genericCardParser,
];

export function getParser(id: string): StatementParser | undefined {
  return PARSERS.find((parser) => parser.id === id);
}

/** Institutions offered in the manual picker, in display order. */
export function listInstitutions(): Array<{ id: string; label: string; parsers: StatementParser[] }> {
  const byInstitution = new Map<string, { id: string; label: string; parsers: StatementParser[] }>();
  for (const parser of PARSERS) {
    const entry = byInstitution.get(parser.institution);
    if (entry) entry.parsers.push(parser);
    else
      byInstitution.set(parser.institution, {
        id: parser.institution,
        label: institutionLabel(parser.institution),
        parsers: [parser],
      });
  }
  return [...byInstitution.values()];
}

function institutionLabel(institution: string): string {
  switch (institution) {
    case 'banco-chile':
      return 'Banco de Chile';
    case 'banco-estado':
      return 'BancoEstado';
    case 'banco-falabella':
      return 'Banco Falabella / CMR';
    default:
      return 'Genérico';
  }
}

/**
 * Ask every parser whether the file is theirs, best score first.
 *
 * Results below {@link DETECTION_FLOOR} are dropped: offering a parser that is
 * almost certainly wrong is worse than asking the user to choose.
 */
export function detectAll(input: ParserInput): DetectionResult[] {
  return PARSERS.map((parser) => parser.detect(input))
    .filter((result) => result.score >= DETECTION_FLOOR)
    .sort((a, b) => b.score - a.score);
}

export * from './parser';
export { createProfileParser } from './profile-parser';
