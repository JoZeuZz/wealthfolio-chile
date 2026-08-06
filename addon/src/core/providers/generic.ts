import { StatementProduct } from '../model/statement';
import type { StatementProfile } from '../parsing/profile';
import { createProfileParser } from './profile-parser';
import type { StatementParser } from './parser';

/**
 * Fallback parsers for files no bank adapter claims.
 *
 * These exist so the product is useful on day one for any bank, and so a user
 * whose statement layout changed is never completely blocked: pick the generic
 * parser, check the preview, import.
 */

export const GENERIC_CHECKING_PROFILE: StatementProfile = {
  institution: 'generico',
  institutionLabel: 'Genérico (cuenta corriente / vista)',
  parserId: 'generico.cuenta',
  parserVersion: '1.0.0',
  product: StatementProduct.checking,
  defaultCurrency: 'CLP',
  numberFormat: 'es-CL',
  dateOrder: 'DMY',
  amountSign: 'signed',
  validationStatus: 'verified',
};

export const GENERIC_CARD_PROFILE: StatementProfile = {
  institution: 'generico',
  institutionLabel: 'Genérico (tarjeta de crédito)',
  parserId: 'generico.tarjeta',
  parserVersion: '1.0.0',
  product: StatementProduct.credit_card,
  defaultCurrency: 'CLP',
  numberFormat: 'es-CL',
  // Card statements print purchases as positive charges; the sign lives in the
  // product, not in the number.
  amountSign: 'debit-positive',
  dateOrder: 'DMY',
  validationStatus: 'verified',
};

export const genericCheckingParser: StatementParser = createProfileParser(
  GENERIC_CHECKING_PROFILE,
  {
    // No markers: the generic parser recognises structure only, so it scores
    // just above the floor and never outranks a real bank adapter.
    weakMarkers: [/\bCARGO\b/i, /\bABONO\b/i, /\bSALDO\b/i],
  },
);

export const genericCardParser: StatementParser = createProfileParser(GENERIC_CARD_PROFILE, {
  weakMarkers: [/\bCUOTA/i, /\bTARJETA\b/i, /\bFACTURACI[OÓ]N\b/i],
});
