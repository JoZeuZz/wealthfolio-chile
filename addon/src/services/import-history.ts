import type { AddonContext } from '@wealthfolio/addon-sdk';
import {
  ShardedList,
  StorageKeys,
  type KeyValueStore,
  type ShardedListHealth,
} from './storage';

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

  /** File name with identifiers stripped — see `core/privacy.sanitizeFileName`. */
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

  /**
   * Rows below the header the parser dropped on purpose: blanks, subtotals,
   * legal footers. Absent on runs recorded before 0.2.
   */
  skippedRows?: number;
  /** Rows the parser produced. */
  detectedRows: number;
  /** Rows the user approved. Absent on runs recorded before v0.1.1. */
  selectedRows?: number;
  /** Rows Wealthfolio confirmed it created. */
  importedRows: number;
  /** Approved rows the host did not create. Absent on runs recorded before v0.1.1. */
  failedRows?: number;
  /** Skipped because an identical movement was already stored. */
  exactDuplicates: number;
  /** Skipped because a similar movement was already stored. */
  probableDuplicates: number;
  /** Skipped by an `ignore` rule. */
  ignoredRows: number;
  /** Unticked by the user in the preview. Absent on runs recorded before v0.1.1. */
  deselectedRows?: number;
  /** Rows the validator flagged as unreadable. Not a skip reason on its own. */
  errorRows: number;

  status: 'completed' | 'partial' | 'failed';
  /**
   * Counts-only summary of the failure.
   *
   * Never the host's own text: it can quote the request back, and the request
   * is a bank statement row. See `import-runner`.
   */
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

  async clear(): Promise<void> {
    await this.list.clear();
  }

  /**
   * What the store holds, including what the index got wrong.
   *
   * Reads refuse rather than come back short, so when one fails this is what
   * says why — and it is the only method that still answers on a list too
   * damaged to read.
   */
  async health(): Promise<ShardedListHealth> {
    return this.list.inspect();
  }

  /** Rebuild the index from the shards. Never touches a shard. */
  async repair(): Promise<ShardedListHealth> {
    return this.list.reindex();
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
