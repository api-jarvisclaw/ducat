/**
 * When to ask before spending, and when not to.
 *
 * Confirming every call is the wrong default. At $0.001 a call, a task that makes
 * six of them turns into six prompts, and a user who is clicking through prompts
 * has stopped reading them — so the confirmation stops protecting anything while
 * still being annoying.
 *
 * What actually bounds the risk is the wallet: a local wallet holds only what the
 * user chose to send it, so the worst case is already capped before the agent
 * starts. This layer adds two ceilings on top and asks only when one is reached:
 *
 *   - per call, so one unexpectedly expensive API cannot slip through
 *   - per session, so many cheap calls cannot add up past what was intended
 *
 * Both are advisory limits the CLI enforces, not gateway limits. The hard limit is
 * the balance.
 */

/** Default per-call threshold above which a call is confirmed, in USD. */
export const DEFAULT_CONFIRM_ABOVE_USD = 0.05

/** Default per-session total, in USD. Reaching it stops the run. */
export const DEFAULT_SESSION_LIMIT_USD = 1

export interface SpendPolicyOptions {
  /** Confirm any single call above this. Defaults to DEFAULT_CONFIRM_ABOVE_USD. */
  confirmAboveUsd?: number
  /** Session total. Defaults to DEFAULT_SESSION_LIMIT_USD. */
  sessionLimitUsd?: number
  /** Confirm every paid call regardless of price. */
  confirmEverything?: boolean
}

export type SpendVerdict =
  /** Under both ceilings — proceed without interrupting. */
  | { decision: 'allow' }
  /** Over the per-call threshold — worth a prompt. */
  | { decision: 'confirm'; reason: string }
  /** Would exceed the session total — refuse, do not prompt. */
  | { decision: 'deny'; reason: string }

/**
 * Tracks what a session has spent and decides each call.
 *
 * Deliberately not a balance check: the gateway rejects a call the wallet cannot
 * cover, and duplicating that here would mean guessing at fees and race conditions.
 * This only enforces the user's own stated intent.
 */
export class SpendPolicy {
  private spent = 0
  private readonly confirmAbove: number
  private readonly sessionLimit: number
  private readonly confirmEverything: boolean

  constructor(opts: SpendPolicyOptions = {}) {
    this.confirmAbove = opts.confirmAboveUsd ?? DEFAULT_CONFIRM_ABOVE_USD
    this.sessionLimit = opts.sessionLimitUsd ?? DEFAULT_SESSION_LIMIT_USD
    this.confirmEverything = opts.confirmEverything ?? false
  }

  /** Total approved and charged so far this session. */
  spentUsd(): number {
    return this.spent
  }

  /** What is left of the session ceiling. */
  remainingUsd(): number {
    return Math.max(0, this.sessionLimit - this.spent)
  }

  get sessionLimitUsd(): number {
    return this.sessionLimit
  }

  get confirmAboveUsd(): number {
    return this.confirmAbove
  }

  /**
   * Decide one call.
   *
   * An unknown price is always confirmed: a call whose cost cannot be read is
   * exactly the one not to wave through, and it cannot be checked against a
   * ceiling either.
   */
  evaluate(priceUsd: number | undefined): SpendVerdict {
    if (priceUsd === undefined) {
      return { decision: 'confirm', reason: 'the price could not be read' }
    }
    if (priceUsd === 0) return { decision: 'allow' }

    if (this.spent + priceUsd > this.sessionLimit) {
      return {
        decision: 'deny',
        reason:
          `this call costs $${priceUsd.toFixed(5)} and the session has spent ` +
          `$${this.spent.toFixed(5)} of its $${this.sessionLimit} limit — ` +
          'raise it with --max-spend',
      }
    }

    if (this.confirmEverything) {
      return { decision: 'confirm', reason: 'every paid call is being confirmed' }
    }
    if (priceUsd > this.confirmAbove) {
      return {
        decision: 'confirm',
        reason: `$${priceUsd.toFixed(5)} is above the $${this.confirmAbove} per-call threshold`,
      }
    }
    return { decision: 'allow' }
  }

  /**
   * Record a charge that went ahead.
   *
   * Called after approval rather than at evaluation, so a declined or failed call
   * does not consume budget the user still has.
   */
  record(priceUsd: number): void {
    this.spent += priceUsd
  }
}
