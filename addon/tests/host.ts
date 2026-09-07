import type {
  Account,
  ActivityBulkMutationRequest,
  ActivityBulkMutationResult,
  ActivityDetails,
  ActivitySearchResponse,
  AddonContext,
} from '@wealthfolio/addon-sdk';
import { METADATA_NAMESPACE, type ChileMetadata } from '../src/core/mapping/activities';

/**
 * A minimal stand-in for the host.
 *
 * Only the handful of APIs the services actually call are implemented; the rest
 * of `HostAPI` is deliberately absent, because a mock that mirrors 20 unused
 * namespaces stops being a test double and starts being a second host to
 * maintain. The cast at the end is the explicit price of that choice.
 */

export interface MemoryStore {
  data: Map<string, string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Reject writes above this many bytes, like the real 250 KB cap. */
  maxValueBytes?: number;
  /** Fail the next call to any method with this error. */
  failWith?: Error;
  /** Reads served since the counter was last reset. Lets a test pin probe cost. */
  reads: number;
}

export function memoryStore(options: { maxValueBytes?: number } = {}): MemoryStore {
  const store: MemoryStore = {
    data: new Map<string, string>(),
    reads: 0,
    ...(options.maxValueBytes !== undefined ? { maxValueBytes: options.maxValueBytes } : {}),
    async get(key) {
      if (store.failWith) throw store.failWith;
      store.reads += 1;
      return store.data.get(key) ?? null;
    },
    async set(key, value) {
      if (store.failWith) throw store.failWith;
      if (store.maxValueBytes !== undefined) {
        const bytes = new TextEncoder().encode(value).length;
        if (bytes > store.maxValueBytes) {
          throw new Error(`value for ${key} exceeds host limit (${bytes} bytes)`);
        }
      }
      store.data.set(key, value);
    },
    async delete(key) {
      if (store.failWith) throw store.failWith;
      store.data.delete(key);
    },
  };
  return store;
}

export interface SaveManyCall {
  request: ActivityBulkMutationRequest;
}

export interface SearchCall {
  page: number;
  pageSize: number;
  filters: Record<string, unknown>;
}

export interface FakeHost {
  ctx: AddonContext;
  store: MemoryStore;
  /** Every activity the fake believes exists, newest first. */
  activities: ActivityDetails[];
  searchCalls: SearchCall[];
  saveManyCalls: SaveManyCall[];
  invalidatedKeys: (string | string[])[];
  toasts: { level: 'success' | 'error' | 'warning' | 'info'; message: string }[];
  accounts: Account[];
  navigatedTo: string[];
  /** Make `accounts.getAll` throw. */
  accountsError?: Error;
  logs: { level: 'error' | 'info' | 'warn' | 'debug' | 'trace'; message: string }[];
  /** Make `activities.search` throw. */
  searchError?: Error;
  /**
   * Per-batch behaviour for `saveMany`, consumed in order.
   *
   * `'ok'` creates everything, `'throw'` rejects the batch, and a number
   * creates only that many rows and reports the rest as errors — the shape a
   * host takes when it accepts some rows and refuses others.
   */
  saveManyPlan: (('ok' | 'throw') | number | Error)[];
}

export interface FakeHostOptions {
  activities?: ActivityDetails[];
  /** Accounts `accounts.getAll` returns. Only the wizard reads them. */
  accounts?: Account[];
  /**
   * Days by which the host slides the `dateFrom`/`dateTo` window.
   *
   * Wealthfolio v3.6.2 reads those bounds in the instance timezone while
   * storing our bare `YYYY-MM-DD` activity dates at UTC midnight, so under
   * `America/Santiago` a window asked for as 05→06 answers with 06→07.
   * Observed on a real container on 2026-08-07; `1` reproduces it.
   */
  dateFilterShiftDays?: number;
  /**
   * Keys already in the store when the page mounts.
   *
   * A page reads its settings in an effect, so writing them after `render`
   * tests the reload path rather than the load path — which is how a page that
   * ignores stored values passes.
   */
  storage?: Record<string, string>;
}

export function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const store = memoryStore();
  for (const [key, value] of Object.entries(options.storage ?? {})) store.data.set(key, value);
  const shift = options.dateFilterShiftDays ?? 0;

  const host: FakeHost = {
    activities: options.activities ?? [],
    accounts: options.accounts ?? [],
    navigatedTo: [],
    searchCalls: [],
    saveManyCalls: [],
    invalidatedKeys: [],
    toasts: [],
    logs: [],
    saveManyPlan: [],
    store,
    ctx: undefined as unknown as AddonContext,
  };

  const api = {
    storage: store,
    accounts: {
      async getAll(): Promise<Account[]> {
        if (host.accountsError) throw host.accountsError;
        return host.accounts;
      },
    },
    navigation: {
      navigate(path: string) {
        host.navigatedTo.push(path);
      },
    },
    settings: {
      // The dashboard reads `baseCurrency` only as the fallback for a month
      // with nothing in it. A fresh Wealthfolio reports USD, which is what took
      // the whole panel down once — see `currencyOf`.
      async get() {
        return { baseCurrency: 'USD' };
      },
    },
    activities: {
      async search(
        page: number,
        pageSize: number,
        filters: Record<string, unknown>,
      ): Promise<ActivitySearchResponse> {
        host.searchCalls.push({ page, pageSize, filters });
        if (host.searchError) throw host.searchError;

        const matching = host.activities.filter((activity) =>
          matchesFilters(activity, filters, shift),
        );
        return {
          data: matching.slice(page * pageSize, (page + 1) * pageSize),
          meta: { totalRowCount: matching.length },
        };
      },
      async saveMany(request: ActivityBulkMutationRequest): Promise<ActivityBulkMutationResult> {
        host.saveManyCalls.push({ request });
        const creates = request.creates ?? [];
        const plan = host.saveManyPlan[host.saveManyCalls.length - 1] ?? 'ok';
        // An `Error` instance lets a test choose the message the host throws,
        // which is what the privacy tests need: the question is what happens to
        // a host message that quotes the user's data back.
        if (plan instanceof Error) throw plan;
        if (plan === 'throw') throw new Error('host rejected the batch');

        const createdCount = plan === 'ok' ? creates.length : (plan as number);
        return {
          created: creates.slice(0, createdCount).map((create, index) => ({
            id: `created-${host.saveManyCalls.length}-${index}`,
            ...create,
          })) as unknown as ActivityBulkMutationResult['created'],
          updated: [],
          deleted: [],
          createdMappings: [],
          errors: creates.slice(createdCount).map((_, index) => ({
            action: 'create',
            message: `row ${createdCount + index} rejected`,
          })),
        };
      },
    },
    query: {
      invalidateQueries(key: string | string[]) {
        host.invalidatedKeys.push(key);
      },
      refetchQueries() {},
      getClient() {
        return undefined;
      },
    },
    logger: {
      error: (message: string) => host.logs.push({ level: 'error', message }),
      info: (message: string) => host.logs.push({ level: 'info', message }),
      warn: (message: string) => host.logs.push({ level: 'warn', message }),
      debug: (message: string) => host.logs.push({ level: 'debug', message }),
      trace: (message: string) => host.logs.push({ level: 'trace', message }),
    },
    toast: {
      success: (message: string) => host.toasts.push({ level: 'success', message }),
      error: (message: string) => host.toasts.push({ level: 'error', message }),
      warning: (message: string) => host.toasts.push({ level: 'warning', message }),
      info: (message: string) => host.toasts.push({ level: 'info', message }),
    },
  };

  host.ctx = { api } as unknown as AddonContext;
  return host;
}

/** The date and account filtering the real backend applies, and nothing else. */
function matchesFilters(
  activity: ActivityDetails,
  filters: Record<string, unknown>,
  shiftDays: number,
): boolean {
  const accountIds = filters['accountIds'];
  if (typeof accountIds === 'string' && activity.accountId !== accountIds) return false;
  if (Array.isArray(accountIds) && !accountIds.includes(activity.accountId)) return false;

  const day = isoDay(activity.date);
  const from = filters['dateFrom'];
  const to = filters['dateTo'];
  if (typeof from === 'string' && day < shiftDay(from, shiftDays)) return false;
  if (typeof to === 'string' && day > shiftDay(to, shiftDays)) return false;

  return true;
}

/** Slide a `YYYY-MM-DD` bound, the way a timezone-aware backend effectively does. */
function shiftDay(iso: string, days: number): string {
  if (days === 0) return iso;
  const shifted = new Date(`${iso}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function isoDay(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/**
 * A Wealthfolio account, with only the fields the addon reads filled in.
 *
 * The rest is cast away for the same reason the context is: mirroring twenty
 * unused fields turns a test double into a second host to maintain.
 */
export function accountStub(input: Partial<Account> & { id: string }): Account {
  return {
    name: 'Cuenta de prueba',
    accountType: 'CASH',
    currency: 'CLP',
    isActive: true,
    isArchived: false,
    balance: 0,
    isDefault: false,
    trackingMode: 'TRANSACTIONS',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...input,
  } as Account;
}

export interface ActivityStubInput {
  id?: string;
  accountId?: string;
  activityType: string;
  subtype?: string;
  /** Unsigned magnitude, exactly as Wealthfolio stores it. */
  amount: string;
  currency?: string;
  date: string;
  comment?: string;
  metadata?: Partial<ChileMetadata>;
  /** What the host reports back, which is what decides the review queue. */
  needsReview?: boolean;
  status?: 'POSTED' | 'PENDING' | 'DRAFT' | 'VOID';
}

let stubCounter = 0;

/** Build an `ActivityDetails` the way the host would hand one back. */
export function activityStub(input: ActivityStubInput): ActivityDetails {
  stubCounter += 1;
  const metadata = input.metadata
    ? { [METADATA_NAMESPACE]: { v: 1, ...input.metadata } }
    : undefined;

  return {
    id: input.id ?? `act-${stubCounter}`,
    accountId: input.accountId ?? 'acc-1',
    activityType: input.activityType,
    ...(input.subtype ? { subtype: input.subtype } : {}),
    date: input.date,
    quantity: null,
    unitPrice: null,
    amount: input.amount,
    fee: null,
    currency: input.currency ?? 'CLP',
    needsReview: input.needsReview ?? false,
    status: input.status ?? 'POSTED',
    comment: input.comment ?? '',
    createdAt: new Date(`${input.date}T00:00:00Z`),
    updatedAt: new Date(`${input.date}T00:00:00Z`),
    assetId: '$CASH-CLP',
    assetSymbol: '$CASH-CLP',
    accountName: 'Cuenta de prueba',
    accountCurrency: input.currency ?? 'CLP',
    ...(metadata ? { metadata } : {}),
  } as unknown as ActivityDetails;
}
