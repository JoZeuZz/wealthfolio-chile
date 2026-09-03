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
  parserVersion: '0.1.0',
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
  ignoreRowPatterns: [/^SALDO\s+(INICIAL|FINAL|ANTERIOR)/i, /^TOTAL/i],
  // Sin una cartola real no hay evidencia de que la columna de saldo camine
  // exacta, así que un desajuste aislado se informa y no bloquea.
  balanceCheck: 'advisory',
  validationStatus: 'pending-real-sample',
  validationNotes:
    'Falta una cartola real de CuentaRUT. Hay que confirmar el separador (BancoEstado ha usado ";" y tabulaciones), la codificación (Windows-1252 en exportaciones antiguas) y si "Cargo" viene positivo o negativo.',
};

export const bancoEstadoParser: StatementParser = createProfileParser(BANCO_ESTADO_ACCOUNT, {
  strongMarkers: [/BANCO\s*ESTADO/i, /BANCOESTADO/i, /CUENTA\s*RUT/i, /CUENTARUT/i],
  weakMarkers: [/CHEQUERA\s+ELECTR[OÓ]NICA/i, /\bCAJA\s+VECINA\b/i, /\bGIROS?\b/i],
  fileNamePatterns: [/cartola/i, /cuentarut/i, /movimientos/i],
});
