import { StatementProduct } from '../model/statement';
import { ColumnRole } from '../parsing/columns';
import type { StatementProfile } from '../parsing/profile';
import { createProfileParser } from './profile-parser';
import type { StatementParser } from './parser';

/**
 * BancoEstado — CuentaRUT, cuenta corriente and Chequera Electrónica.
 *
 * CuentaRUT is the account most Chileans actually have, and its export is the
 * one this project cares most about getting right. The mapping below is built
 * from the published layout and is marked `pending-real-sample` until a real
 * download confirms it. See docs/BANK_FORMATS.md.
 */

export const BANCO_ESTADO_ACCOUNT: StatementProfile = {
  institution: 'banco-estado',
  institutionLabel: 'BancoEstado — CuentaRUT / cuenta corriente',
  parserId: 'banco-estado.cuenta',
  parserVersion: '0.2.0',
  product: StatementProduct.checking,
  defaultCurrency: 'CLP',
  numberFormat: 'es-CL',
  dateOrder: 'DMY',
  amountSign: 'signed',
  columnSynonyms: {
    [ColumnRole.date]: ['Fecha', 'Fecha Transaccion', 'Fecha Movimiento'],
    [ColumnRole.description]: ['Descripcion', 'Descripción', 'Detalle', 'Glosa'],
    [ColumnRole.debit]: ['Cargo', 'Cargos', 'Giro', 'Giros'],
    [ColumnRole.credit]: ['Abono', 'Abonos', 'Deposito', 'Depositos'],
    [ColumnRole.balance]: ['Saldo'],
    [ColumnRole.reference]: ['N Documento', 'Numero Documento', 'Documento'],
    [ColumnRole.operationType]: ['Canal', 'Tipo Movimiento'],
  },
  periodLinePattern:
    /\bFecha\s+Inicio\b[^\d]{0,20}(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}-\d{2}-\d{2})[^\d]{0,40}\bFecha\s+(?:T[eé]rmino|Final)\b[^\d]{0,20}(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}-\d{2}-\d{2})/i,
  ignoreRowPatterns: [/^SALDO\s+(INICIAL|FINAL|ANTERIOR)/i, /^TOTAL/i],
  // La primera cartola real de CuentaRUT (calibrada 2026-09) vino en XLSX con
  // la fecha del movimiento como `dd/mmm` — sin año — y con `Cargo`/`Abono`
  // impresos con coma como separador de miles mientras `Saldo`, en la misma
  // fila, usa punto. Ambos hechos confirmados contra el archivo real: ver
  // docs/UPSTREAM.md y el hallazgo registrado para esta calibración.
  dateOmitsYear: true,
  spreadsheetColumnNumberFormats: {
    [ColumnRole.debit]: 'en-US',
    [ColumnRole.credit]: 'en-US',
  },
  spreadsheetColumnNumberFormatEvidence: {
    [ColumnRole.debit]: /^[+-]?\d{1,3}(?:,\d{3})+$/,
    [ColumnRole.credit]: /^[+-]?\d{1,3}(?:,\d{3})+$/,
  },
  ambiguousAmountCheck: 'authoritative',
  // Sigue siendo evidencia insuficiente para exigir que cada recorrido de saldo
  // cuadre: el perfil aún espera más formatos reales antes de promoverse.
  balanceCheck: 'advisory',
  validationStatus: 'pending-real-sample',
  validationNotes:
    'Corregido contra una cartola XLSX real (CuentaRUT, calibración 2026-09): fecha sin año y separador de miles en coma para Cargo/Abono. Pendiente: revisar la clasificación (kind) sobre una segunda cartola real y confirmar Chequera Electrónica, que esta calibración no cubrió.',
};

export const bancoEstadoParser: StatementParser = createProfileParser(BANCO_ESTADO_ACCOUNT, {
  strongMarkers: [/BANCO\s*ESTADO/i, /BANCOESTADO/i, /CUENTA\s*RUT/i, /CUENTARUT/i],
  weakMarkers: [/CHEQUERA\s+ELECTR[OÓ]NICA/i, /\bCAJA\s+VECINA\b/i, /\bGIROS?\b/i],
  fileNamePatterns: [/cartola/i, /cuentarut/i, /movimientos/i],
});
