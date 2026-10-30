import { WorkerStore, utcDay } from './worker.store';

/** Thrown when the daily paid-request budget is used up; jobs treat it like a stop, not a failure. */
export class BudgetExhaustedError extends Error {
  constructor(public readonly day: string, public readonly limit: number) {
    super(`Daily provider request budget exhausted (${limit} requests on ${day})`);
    this.name = 'BudgetExhaustedError';
  }
}

export function isBudgetExhausted(e: unknown): e is BudgetExhaustedError {
  return e instanceof BudgetExhaustedError || (e as Error)?.name === 'BudgetExhaustedError';
}

/**
 * Counts every paid provider request against a per-UTC-day limit stored in the worker store
 * (so restarts and several processes share one budget) and spaces requests out.
 */
export class RequestBudget {
  private lastRequestAt = 0;
  private chain: Promise<void> = Promise.resolve();
  requestsThisProcess = 0;
  exhausted = false;

  constructor(
    private readonly store: WorkerStore,
    private readonly dailyLimit: number,
    private readonly minIntervalMs: number,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
    /** Extra cap for this process only (e.g. a one-off run), on top of the shared daily limit */
    private readonly processCap: number = Infinity,
  ) {}

  async remaining(): Promise<number> {
    const day = utcDay(this.now());
    return Math.max(0, this.dailyLimit - (await this.store.budgetUsed(day)));
  }

  /** The gate passed to setProviderRequestGate: reserve one request, then wait for the rate limit. */
  readonly gate = (): Promise<void> => {
    const turn = this.chain.then(async () => {
      const day = utcDay(this.now());
      if (this.requestsThisProcess >= this.processCap) {
        this.exhausted = true;
        throw new BudgetExhaustedError(day, this.processCap);
      }
      if (!(await this.store.reserveBudget(day, 1, this.dailyLimit))) {
        this.exhausted = true;
        throw new BudgetExhaustedError(day, this.dailyLimit);
      }
      this.requestsThisProcess++;
      const wait = this.lastRequestAt + this.minIntervalMs - this.now().getTime();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now().getTime();
    });
    // Serialise reservations so the interval holds across concurrent callers; a failure must not block the queue
    this.chain = turn.catch(() => {});
    return turn;
  };
}
