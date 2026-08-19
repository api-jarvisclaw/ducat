/**
 * Money formatting.
 *
 * A single formatter treated every zero as "free", so `ducat balance` on an empty
 * wallet printed "free USDC" — which says nothing about having no money, and reads
 * as though the account were on some free plan. Found by running the command, not
 * by a test.
 */
import { describe, expect, it } from 'vitest'
import { formatPrice, formatUsd } from '../src/ui.js'

describe('formatUsd, for balances and limits', () => {
  it('shows an empty balance as an amount, not as "free"', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0)).not.toContain('free')
  })

  it('gives sub-cent amounts enough decimals to be legible', () => {
    // Catalogue prices run to six decimals; $0.00 for a real charge would look
    // like it cost nothing.
    expect(formatUsd(0.00138)).toBe('$0.001380')
  })

  it('keeps larger amounts short', () => {
    expect(formatUsd(1.5)).toBe('$1.5000')
  })
})

describe('formatPrice, for what a call costs', () => {
  it('says free when a call genuinely costs nothing', () => {
    expect(formatPrice(0)).toBe('free')
  })

  it('agrees with formatUsd on every non-zero amount', () => {
    // The two must only ever differ at zero; anything else is two spellings of
    // the same number in one interface.
    for (const amount of [0.000001, 0.00138, 0.05, 1, 123.456]) {
      expect(formatPrice(amount)).toBe(formatUsd(amount))
    }
  })
})
