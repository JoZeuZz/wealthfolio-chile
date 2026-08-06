import type { AddonContext } from '@wealthfolio/addon-sdk';
import { ShardedList, StorageKeys, type KeyValueStore } from './storage';

/**
 * The import history.
 *
 * Records what was imported, from which file, by which parser version — but
 * never the file itself. A SHA-256 plus counts answers every question the user
 * actually asks ("did I already load February?", "why does this look wrong?")
 * without keeping a copy of a bank statement inside the app.
 *
 * Storing the original file is a deliberate non-feature; see docs/PRIVACY.md.
 */

export interface ImportRun {
  /** Run id, unique per import. */
  id: string;
  /** ISO timestamp of when the import was confirmed. */
  timestamp: string;

  fileName: string;
  /** SHA-256 of the file bytes — how a re-upload of the same file is spotted. */
  fileHash: string;

  institution: string;
  parser: string;
  parserVersion: string;
  /** Whether the parser profile had been validated against a real statement. */
  profileStatus: 'verified' | 'pending-real-sample';

  accountId: string;
  accountName: string;
  currency: string;

  periodFrom?: string;
  periodTo?: string;

  detectedRows: number;
  importedRows: number;
  exactDuplicates: number;
  probableDuplicates: number;
  ignoredRows: number;
  errorRows: number;

  status: 'completed' | 'partial' | 'failed';
  /** User-facing error summary when the run did not complete cleanly. */
  message?: string;
}

export class ImportHistory {
  private readonly list: ShardedList<ImportRun>;

  constructor(store: KeyValueStore) {
    this.list = new ShardedList<ImportRun>(store, StorageKeys.importHistory, 50);
  }

  static from(ctx: AddonContext): ImportHistory {
    return new ImportHistory(ctx.api.storage);
  }

  async record(run: ImportRun): Promise<void> {
    await this.list.append([run]);
  }

  /** Most recent runs first. */
  async recent(limit = 50): Promise<ImportRun[]> {
    return this.list.readRecent(limit);
  }

  async all(): Promise<ImportRun[]> {
    return this.list.readAll();
  }

  /**
   * Has this exact file been imported into this account before?
   *
   * Only a hint for the wizard — the authoritative duplicate check is
   * per-transaction, since a bank can re-export the same period with a
   * different byte layout.
   */
  async findByFileHash(fileHash: string, accountId: string): Promise<ImportRun | undefined> {
    const runs = await this.list.readAll();
    return runs.find((run) => run.fileHash === fileHash && run.accountId === accountId);
  }

  async clear(): Promise<void> {
    await this.list.clear();
  }
}

/** Time-ordered, collision-resistant run id. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '');
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `run-${stamp}-${random}`;
}
