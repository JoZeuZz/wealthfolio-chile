import { collapseSpaces, foldCase } from '../text';

/**
 * Merchant extraction.
 *
 * `COMPRA INT WEBPAY TRANSBANK 1234 SUPERMERCADO LIDER LAS CONDES` is not a
 * merchant called "Compra Int Webpay". It is a purchase, routed through Webpay,
 * at Lider. The pipeline peels those layers apart in a fixed order — transaction
 * verb, then payment processor, then location and reference noise — so what is
 * left is the name a person would recognise.
 *
 * Deterministic first, always. An LLM may later propose better names, but it
 * proposes them *on top of* this, never instead of it.
 */

export interface MerchantResult {
  /** Cleaned merchant name in title case, or undefined if nothing survived. */
  merchant?: string;
  /** Processor that was stripped off, when one was recognised. */
  processor?: string;
  /** The canonical key used for grouping and rule matching. */
  key: string;
}

/** Payment processors and acquirers that prefix Chilean card descriptions. */
const PROCESSORS: Array<[RegExp, string]> = [
  [/\bWEBPAY\s*PLUS\b/g, 'Webpay'],
  [/\bWEBPAY\b/g, 'Webpay'],
  [/\bTRANSBANK\b/g, 'Transbank'],
  [/\bREDCOMPRA\b/g, 'Redcompra'],
  [/\bRED\s*COMPRA\b/g, 'Redcompra'],
  [/\bKHIPU\b/g, 'Khipu'],
  [/\bMERCADO\s*PAGO\b/g, 'Mercado Pago'],
  [/\bMERPAGO\b/g, 'Mercado Pago'],
  [/\bMPAGO\b/g, 'Mercado Pago'],
  [/\bGETNET\b/g, 'Getnet'],
  [/\bSUMUP\b/g, 'SumUp'],
  [/\bPAYPAL\b/g, 'PayPal'],
  [/\bPAY\s*PAL\b/g, 'PayPal'],
  [/\bFLOW\b/g, 'Flow'],
  [/\bETPAY\b/g, 'ETpay'],
  [/\bKLAP\b/g, 'Klap'],
];

/**
 * Transaction verbs banks prepend. Removed only from the *start* of the
 * description: `COMPRA` inside `TIENDA LA COMPRA` is part of the name.
 */
const LEADING_VERBS = [
  'COMPRA INTERNACIONAL',
  'COMPRA NACIONAL',
  'COMPRA INT',
  'COMPRA NAC',
  'COMPRA EN',
  'COMPRA',
  'PAGO EN LINEA',
  'PAGO AUTOMATICO',
  'PAGO PAT',
  'PAGO DE CUENTAS',
  'PAGO',
  'CARGO POR',
  'CARGO',
  'ABONO POR',
  'ABONO',
  'SUSCRIPCION',
  'DEBITO AUTOMATICO',
  'GIRO',
  'TRANSFERENCIA A',
  'TRANSFERENCIA DE',
  'TRANSFERENCIA',
  'AVANCE EN EFECTIVO',
  'AVANCE',
];

/** Trailing noise: comunas, cities and country codes appended by acquirers. */
const TRAILING_PLACES = [
  'SANTIAGO',
  'PROVIDENCIA',
  'LAS CONDES',
  'VITACURA',
  'NUNOA',
  'LA FLORIDA',
  'MAIPU',
  'PUENTE ALTO',
  'VINA DEL MAR',
  'VALPARAISO',
  'CONCEPCION',
  'ANTOFAGASTA',
  'TEMUCO',
  'RANCAGUA',
  'IQUIQUE',
  'PUERTO MONTT',
  'LA SERENA',
  'CHILE',
  'CL',
  'CHL',
];

/** Known brands whose descriptions vary wildly but mean one merchant. */
const BRAND_ALIASES: Array<[RegExp, string]> = [
  [/\bLIDER\b|\bWALMART\b|\bEKONO\b|\bSUPER\s?BODEGA\b/, 'Lider'],
  [/\bJUMBO\b/, 'Jumbo'],
  [/\bSANTA\s*ISABEL\b/, 'Santa Isabel'],
  [/\bTOTTUS\b/, 'Tottus'],
  [/\bUNIMARC\b/, 'Unimarc'],
  [/\bFALABELLA\b/, 'Falabella'],
  [/\bPARIS\b/, 'Paris'],
  [/\bRIPLEY\b/, 'Ripley'],
  [/\bSODIMAC\b|\bHOMECENTER\b/, 'Sodimac'],
  [/\bEASY\b/, 'Easy'],
  [/\bFARMACIAS?\s*AHUMADA\b|\bFASA\b/, 'Farmacias Ahumada'],
  [/\bCRUZ\s*VERDE\b/, 'Cruz Verde'],
  [/\bSALCOBRAND\b/, 'Salcobrand'],
  [/\bCOPEC\b/, 'Copec'],
  [/\bSHELL\b/, 'Shell'],
  [/\bPETROBRAS\b/, 'Petrobras'],
  [/\bUBER\s*EATS\b/, 'Uber Eats'],
  [/\bUBER\b/, 'Uber'],
  [/\bCABIFY\b/, 'Cabify'],
  [/\bDIDI\b/, 'DiDi'],
  [/\bRAPPI\b/, 'Rappi'],
  [/\bPEDIDOS\s*YA\b|\bPEDIDOSYA\b/, 'PedidosYa'],
  [/\bNETFLIX\b/, 'Netflix'],
  [/\bSPOTIFY\b/, 'Spotify'],
  [/\bDISNEY\s*(\+|PLUS)\b/, 'Disney+'],
  [/\bHBO\s*(MAX)?\b/, 'HBO Max'],
  [/\bAMAZON\s*PRIME\b/, 'Amazon Prime'],
  [/\bAMAZON\b/, 'Amazon'],
  [/\bAPPLE\.?COM\b|\bAPPLE\s*(STORE|SERVICES)\b|\bITUNES\b/, 'Apple'],
  [/\bGOOGLE\s*(PLAY|CLOUD|STORAGE|ONE)?\b/, 'Google'],
  [/\bMICROSOFT\b|\bMSFT\b/, 'Microsoft'],
  [/\bOPENAI\b|\bCHATGPT\b/, 'OpenAI'],
  [/\bMERCADO\s*LIBRE\b|\bMERCADOLIBRE\b/, 'Mercado Libre'],
  [/\bALIEXPRESS\b/, 'AliExpress'],
  [/\bMETRO\s*DE\s*SANTIAGO\b|\bBIP\b/, 'Metro de Santiago'],
  [/\bENEL\b|\bCHILECTRA\b/, 'Enel'],
  [/\bAGUAS\s*ANDINAS\b/, 'Aguas Andinas'],
  [/\bMETROGAS\b/, 'Metrogas'],
  [/\bLIPIGAS\b|\bABASTIBLE\b|\bGASCO\b/, 'Gas'],
  [/\bENTEL\b/, 'Entel'],
  [/\bMOVISTAR\b|\bTELEFONICA\b/, 'Movistar'],
  [/\bCLARO\b/, 'Claro'],
  [/\bWOM\b/, 'WOM'],
  [/\bVTR\b/, 'VTR'],
  [/\bISAPRE\b|\bFONASA\b|\bBANMEDICA\b|\bCONSALUD\b|\bCRUZ\s*BLANCA\b/, 'Salud'],
];

/** Reference blobs acquirers append: `*1234`, `#00987`, long digit runs. */
const REFERENCE_NOISE = [
  /\*+\s*\d+/g,
  /#\s*\d+/g,
  /\bN[º°]?\s*\d{3,}\b/g,
  /\b\d{6,}\b/g,
  /\bID\s*\d+\b/g,
  /\bOP\s*\d+\b/g,
];

export function normalizeMerchant(description: string): MerchantResult {
  let text = foldCase(String(description ?? ''));
  let processor: string | undefined;

  for (const [pattern, name] of PROCESSORS) {
    if (pattern.test(text)) {
      processor ??= name;
      text = text.replace(pattern, ' ');
    }
    pattern.lastIndex = 0;
  }

  text = collapseSpaces(text.replace(/[^A-Z0-9+.\s-]+/g, ' '));

  for (const verb of LEADING_VERBS) {
    if (text.startsWith(`${verb} `)) {
      text = text.slice(verb.length + 1);
      break;
    }
    if (text === verb) {
      text = '';
      break;
    }
  }

  for (const pattern of REFERENCE_NOISE) {
    text = text.replace(pattern, ' ');
    pattern.lastIndex = 0;
  }

  text = collapseSpaces(text);

  // Strip a trailing place name, once — `LIDER LAS CONDES` becomes `LIDER`,
  // but `LAS CONDES` on its own stays, since it is all we have.
  for (const place of TRAILING_PLACES) {
    if (text.endsWith(` ${place}`) && text.length > place.length + 1) {
      text = collapseSpaces(text.slice(0, -(place.length + 1)));
      break;
    }
  }

  for (const [pattern, brand] of BRAND_ALIASES) {
    if (pattern.test(text)) {
      return {
        merchant: brand,
        ...(processor !== undefined ? { processor } : {}),
        key: foldCase(brand),
      };
    }
  }

  // Trailing lone digits are card tails or sequence numbers, never a name.
  text = collapseSpaces(text.replace(/\b\d{1,5}\b\s*$/, ''));

  if (text === '' || text.length < 2) {
    return { ...(processor !== undefined ? { processor } : {}), key: '' };
  }

  return {
    merchant: titleCase(text),
    ...(processor !== undefined ? { processor } : {}),
    key: text,
  };
}

/** Words that stay lowercase inside a Spanish merchant name. */
const MINOR_WORDS = new Set(['DE', 'DEL', 'LA', 'LAS', 'EL', 'LOS', 'Y', 'EN', 'A']);

function titleCase(text: string): string {
  return text
    .split(' ')
    .map((word, index) => {
      if (word.length <= 1) return word;
      // Acronyms stay upper: VTR, WOM, CMR.
      if (word.length <= 3 && !MINOR_WORDS.has(word)) return word;
      if (index > 0 && MINOR_WORDS.has(word)) return word.toLowerCase();
      return word[0] + word.slice(1).toLowerCase();
    })
    .join(' ');
}
