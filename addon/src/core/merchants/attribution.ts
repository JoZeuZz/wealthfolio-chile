import {
  findProcessor,
  isBankPlaceholder,
  type MerchantVisibility,
  type ProcessorEvidence,
  type ProcessorProfile,
} from '../chile/processors';
import { Confidence } from '../model/kinds';
import { normalizeDescription } from '../text';
import { normalizeMerchant } from './normalize';

/**
 * Who was paid, and how sure we are.
 *
 * `normalizeMerchant` peels a description down to a name. That was the right
 * first step and the wrong last one, because it had no way to say *nothing*:
 * whatever survived the peeling became the merchant. On Chilean statements that
 * produced merchants called "4 Tcom" (Mercado Pago's routing suffix), "Online"
 * (the bank's placeholder for a merchant it cannot name) and "Payu Tienda X"
 * (the gateway's name glued to the shop's), and it threw away "Garena" — the
 * one sub-merchant a processor actually documents.
 *
 * This layer adds the question that decides all four: *does this processor let
 * the merchant through?* The answer is declared per processor in
 * `core/chile/processors`, with its evidence, and it is allowed to conclude
 * that the merchant is unknown. `unknown` is a better answer than a plausible
 * name — a wrong merchant is a wrong category, a wrong recurring charge and a
 * wrong ranking, all of which look right.
 *
 * The original descriptor is never modified, never truncated and never dropped.
 * It is the only evidence a person has to recognise a charge they do not
 * remember, and the community research is unanimous that it is the thing users
 * fall back on.
 */

export type MerchantSource =
  /** A brand this project recognises by name. The strongest evidence. */
  | 'brand-alias'
  /** A sub-merchant read with a grammar the processor documents. */
  | 'processor-grammar'
  /** The processor bills on its own behalf, so it is the merchant. */
  | 'processor-is-merchant'
  /** Whatever was left of the descriptor once the noise was peeled off. */
  | 'residual-text';

/** Why no merchant could be named. */
export type UnresolvedReason =
  /** The processor is known not to carry the merchant through. */
  | 'processor-hides-merchant'
  /** The bank itself printed a placeholder meaning "not registered here". */
  | 'bank-placeholder'
  /** Nothing was left once processor, verb and noise were removed. */
  | 'nothing-left';

export interface MerchantCandidate {
  name: string;
  /**
   * `confirmed` only for a brand this project recognises. Everything read out
   * of free text is `suggested`: it is a candidate, and the user has the last
   * word — the same rule the rest of the pipeline follows.
   */
  confidence: Confidence;
  source: MerchantSource;
}

export interface ProcessorMatch {
  id: string;
  name: string;
  visibility: MerchantVisibility;
  evidence: ProcessorEvidence;
}

export interface PaymentAttribution {
  /** The description exactly as the bank printed it. */
  descriptor: string;
  processor?: ProcessorMatch;
  merchant?: MerchantCandidate;
  /** Present exactly when `merchant` is absent and the descriptor was not empty. */
  unresolved?: UnresolvedReason;
}

export function attributePayment(description: string): PaymentAttribution {
  const descriptor = String(description ?? '');
  const normalized = normalizeDescription(descriptor);
  if (normalized === '') return { descriptor };

  const processor = findProcessor(normalized);
  const match = processor ? toMatch(processor) : undefined;
  const base = { descriptor, ...(match ? { processor: match } : {}) };

  if (isBankPlaceholder(normalized)) {
    return { ...base, unresolved: 'bank-placeholder' };
  }

  // A grammar the processor publishes beats everything else about that
  // processor, because it is the processor describing its own output.
  const submerchant = processor ? readSubmerchant(processor, normalized) : undefined;
  if (submerchant) {
    return {
      ...base,
      merchant: {
        name: submerchant,
        confidence: Confidence.suggested,
        source: 'processor-grammar',
      },
    };
  }

  const residue = processor ? stripProcessor(normalized, processor) : normalized;
  const peeled = normalizeMerchant(residue);

  // A brand this project recognises outranks the processor's policy: if the
  // glosa says Falabella, the merchant is Falabella however the charge was
  // routed.
  if (peeled.merchant && peeled.brand) {
    return {
      ...base,
      merchant: {
        name: peeled.merchant,
        confidence: Confidence.confirmed,
        source: 'brand-alias',
      },
    };
  }

  // The reason is the processor, whether or not anything survived the peeling:
  // what is left of `MERCADO PAGO 4 TCOM` is a routing suffix either way, and
  // the honest account of why the merchant is unknown is that this processor
  // does not carry it.
  if (processor?.visibility === 'hidden') {
    return { ...base, unresolved: 'processor-hides-merchant' };
  }

  // A processor billing on its own behalf is the merchant, and what follows its
  // name is its own product line — `PLAY STORE GOOG` is not a shop. Only the
  // published grammar and a known brand, both checked above, can name someone
  // else.
  if (processor?.visibility === 'self') {
    return {
      ...base,
      merchant: {
        name: processor.name,
        confidence: Confidence.suggested,
        source: 'processor-is-merchant',
      },
    };
  }

  if (peeled.merchant) {
    return {
      ...base,
      merchant: {
        name: peeled.merchant,
        confidence: Confidence.suggested,
        source: 'residual-text',
      },
    };
  }

  return { ...base, unresolved: 'nothing-left' };
}

function toMatch(processor: ProcessorProfile): ProcessorMatch {
  return {
    id: processor.id,
    name: processor.name,
    visibility: processor.visibility,
    evidence: processor.evidence,
  };
}

function readSubmerchant(
  processor: ProcessorProfile,
  normalized: string,
): string | undefined {
  if (!processor.submerchant) return undefined;
  const found = processor.submerchant.exec(normalized);
  const captured = found?.[1]?.trim();
  if (!captured) return undefined;
  const peeled = normalizeMerchant(captured);
  return peeled.merchant;
}

function stripProcessor(normalized: string, processor: ProcessorProfile): string {
  let text = normalized;
  for (const pattern of processor.patterns) {
    text = text.replace(pattern, ' ');
  }
  return text;
}
