import type {
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
}

export function memoryStore(options: { maxValueBytes?: number } = {}): MemoryStore {
  const store: MemoryStore = {
    data: new Map<string, string>(),
    ...(options.maxValueBytes !== undefined ? { maxValueBytes: options.maxValueBytes } : {}),
    async get(key) {
      if (store.failWith) throw store.failWith;
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
  saveManyPlan: (('ok' | 'throw') | number)[];
}

export function fakeHost(options: { activities?: ActivityDetails[] } = {}): FakeHost {
  const store = memoryStore();

  const host: FakeHost = {
    activities: options.activities ?? [],
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
    activities: {
      async search(
        page: number,
        pageSize: number,
        filters: Record<string, unknown>,
      ): Promise<ActivitySearchResponse> {
        host.searchCalls.push({ page, pageSize, filters });
        if (host.searchError) throw host.searchError;

        const matching = host.activities.filter((activity) => matchesFilters(activity, filters));
        return {
          data: matching.slice(page * pageSize, (page + 1) * pageSize),
          meta: { totalRowCount: matching.length },
        };
      },
      async saveMany(request: ActivityBulkMutationRequest): Promise<ActivityBulkMutationResult> {
        host.saveManyCalls.push({ request });
        const creates = request.creates ?? [];
        const plan = host.saveManyPlan[host.saveManyCalls.length - 1] ?? 'ok';
        if (plan === 'throw') throw new Error('host rejected the batch');

        const createdCount = plan === 'ok' ? creates.length : plan;
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
function matchesFilters(activity: ActivityDetails, filters: Record<string, unknown>): boolean {
  const accountIds = filters['accountIds'];
  if (typeof accountIds === 'string' && activity.accountId !== accountIds) return false;
  if (Array.isArray(accountIds) && !accountIds.includes(activity.accountId)) return false;

  const day = isoDay(activity.date);
  const from = filters['dateFrom'];
  const to = filters['dateTo'];
  if (typeof from === 'string' && day < from) return false;
  if (typeof to === 'string' && day > to) return false;

  return true;
}

function isoDay(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
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
    needsReview: false,
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
