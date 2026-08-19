/**
 * The spend policy.
 *
 * The first version confirmed every paid call. At $0.001 a call that turns a
 * six-step task into six prompts, and a user clicking through prompts has stopped
 * reading them — the confirmation protects nothing while still being in the way.
 *
 * What bounds the risk is the wallet holding only what the user sent it. These
 * ceilings sit on top: one so a single expensive call cannot slip through, one so
 * many cheap ones cannot add up past what was intended.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIRM_ABOVE_USD,
  DEFAULT_SESSION_LIMIT_USD,
  SpendPolicy,
} from '../src/spend.js'

describe('routine calls', () => {
  it('lets a cheap call through without asking', () => {
    // The catalogue price this was measured against is $0.00138 a call.
    const policy = new SpendPolicy()
    expect(policy.evaluate(0.00138).decision).toBe('allow')
  })

  it('lets many cheap calls through in a row', () => {
    const policy = new SpendPolicy()
    for (let i = 0; i < 20; i++) {
      expect(policy.evaluate(0.001).decision).toBe('allow')
      policy.record(0.001)
    }
    expect(policy.spentUsd()).toBeCloseTo(0.02)
  })

  it('treats a free call as free', () => {
    const policy = new SpendPolicy()
    expect(policy.evaluate(0).decision).toBe('allow')
  })
})

describe('the per-call threshold', () => {
  it('confirms a call above it', () => {
    const policy = new SpendPolicy({ confirmAboveUsd: 0.01 })
    const verdict = policy.evaluate(0.05)
    expect(verdict.decision).toBe('confirm')
    expect(verdict.decision === 'confirm' && verdict.reason).toMatch(/per-call threshold/)
  })

  it('allows a call exactly at it', () => {
    // Off-by-one here means either a needless prompt or an unapproved charge.
    const policy = new SpendPolicy({ confirmAboveUsd: 0.05 })
    expect(policy.evaluate(0.05).decision).toBe('allow')
  })

  it('defaults to a threshold small enough to catch a surprise', () => {
    // Most catalogue APIs are well under a cent; anything at five cents deserves a
    // look.
    expect(DEFAULT_CONFIRM_ABOVE_USD).toBeGreaterThan(0)
    expect(DEFAULT_CONFIRM_ABOVE_USD).toBeLessThanOrEqual(0.1)
  })

  it('confirms everything when asked to', () => {
    const policy = new SpendPolicy({ confirmEverything: true })
    expect(policy.evaluate(0.00001).decision).toBe('confirm')
  })

  it('still treats free calls as free under --confirm-all', () => {
    const policy = new SpendPolicy({ confirmEverything: true })
    expect(policy.evaluate(0).decision).toBe('allow')
  })
})

describe('the session limit', () => {
  it('denies a call that would exceed it', () => {
    const policy = new SpendPolicy({ sessionLimitUsd: 0.1, confirmAboveUsd: 1 })
    policy.record(0.09)
    const verdict = policy.evaluate(0.02)
    expect(verdict.decision).toBe('deny')
    expect(verdict.decision === 'deny' && verdict.reason).toMatch(/--max-spend/)
  })

  it('denies rather than prompting, so the answer is not a click away', () => {
    // A prompt at the ceiling would let a tired user approve past the limit they
    // set. The limit is meant to be a limit.
    const policy = new SpendPolicy({ sessionLimitUsd: 0.01, confirmEverything: true })
    policy.record(0.01)
    expect(policy.evaluate(0.001).decision).toBe('deny')
  })

  it('allows a call that lands exactly on it', () => {
    const policy = new SpendPolicy({ sessionLimitUsd: 0.1, confirmAboveUsd: 1 })
    policy.record(0.09)
    expect(policy.evaluate(0.01).decision).toBe('allow')
  })

  it('reports what is left', () => {
    const policy = new SpendPolicy({ sessionLimitUsd: 1 })
    policy.record(0.25)
    expect(policy.remainingUsd()).toBeCloseTo(0.75)
  })

  it('never reports a negative remainder', () => {
    const policy = new SpendPolicy({ sessionLimitUsd: 0.1 })
    policy.record(0.5)
    expect(policy.remainingUsd()).toBe(0)
  })

  it('has a default low enough that an unattended run cannot drain a wallet', () => {
    expect(DEFAULT_SESSION_LIMIT_USD).toBeGreaterThan(0)
    expect(DEFAULT_SESSION_LIMIT_USD).toBeLessThanOrEqual(5)
  })
})

describe('an unknown price', () => {
  it('is always confirmed', () => {
    // A call whose cost cannot be read is exactly the one not to wave through, and
    // it cannot be checked against a ceiling either.
    const policy = new SpendPolicy()
    const verdict = policy.evaluate(undefined)
    expect(verdict.decision).toBe('confirm')
    expect(verdict.decision === 'confirm' && verdict.reason).toMatch(/price could not be read/)
  })

  it('is confirmed even when the session has plenty left', () => {
    const policy = new SpendPolicy({ sessionLimitUsd: 1000, confirmAboveUsd: 100 })
    expect(policy.evaluate(undefined).decision).toBe('confirm')
  })
})

describe('accounting', () => {
  it('only counts calls that were recorded', () => {
    // record() is called after approval, so a declined or failed call must not eat
    // budget the user still has.
    const policy = new SpendPolicy()
    policy.evaluate(0.5)
    policy.evaluate(0.5)
    expect(policy.spentUsd()).toBe(0)
  })

  it('accumulates across calls', () => {
    const policy = new SpendPolicy()
    policy.record(0.01)
    policy.record(0.02)
    expect(policy.spentUsd()).toBeCloseTo(0.03)
  })
})
