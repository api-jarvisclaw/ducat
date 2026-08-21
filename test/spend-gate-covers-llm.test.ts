import { PaymentDeclinedError } from '@jarvisclaw-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { run } from '../src/agent/runner.js'
import { PlatformClient } from '../src/platform/client.js'
import { SpendPolicy } from '../src/spend.js'
import { answerResponse, toolCallResponse } from './helpers.js'

/**
 * The spend ceilings used to govern one tool and nothing else.
 *
 * `--max-call` and `--max-spend` were consulted by the `call_api` tool, so they
 * bounded paid catalogue APIs — and left the agent's own reasoning turns, the most
 * expensive part of a run, entirely ungated. A real session held `--max-call 0.05`
 * and `--max-spend 1` and still spent $1.47, because six LLM turns quoted at ~$0.21
 * each are not `call_api`.
 *
 * The gate now sits on the payment path, where it sees every x402 charge. These tests
 * are about the LLM turns specifically, since those are what escaped.
 */

/** A gateway that answers 402 with `quoteUsd`, then serves `turns` once paid. */
function payingGateway(quoteUsd: number, turns: unknown[]) {
  const queue = [...turns]
  let quotes = 0
  let served = 0

  const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const href = String(url)
    const headers = new Headers(init?.headers ?? {})

    if (!headers.has('PAYMENT-SIGNATURE')) {
      quotes += 1
      return new Response(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: 'exact',
              network: 'eip155:8453',
              amount: String(Math.round(quoteUsd * 1_000_000)),
              asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              payTo: '0x2222222222222222222222222222222222222222',
              maxTimeoutSeconds: 300,
              extra: { name: 'USD Coin', version: '2' },
            },
          ],
          resource: { description: 'AI chat completions' },
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      )
    }

    if (href.includes('/v1/chat/completions')) {
      served += 1
      const next = queue.shift()
      if (!next) throw new Error(`unexpected chat call #${served}`)
      return new Response(JSON.stringify(next), {
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`no route for ${href}`)
  })

  return { impl: impl as unknown as typeof fetch, quotes: () => quotes, served: () => served }
}

// A throwaway key: this signs nothing that leaves the test process.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

async function clientWith(policy: SpendPolicy, impl: typeof fetch) {
  const approvals: number[] = []
  const client = await PlatformClient.create({
    privateKey: TEST_KEY,
    network: 'base',
    baseUrl: 'https://gateway.test',
    fetchImpl: impl,
    maxRetries: 1,
    approvePayment: (req) => {
      approvals.push(req.amountUsd)
      const verdict = policy.evaluate(req.amountUsd)
      if (verdict.decision === 'deny') return { approved: false, reason: verdict.reason }
      // 'confirm' counts as approval here: the interactive prompt is the CLI's, and
      // what is under test is that the policy SEES the charge at all.
      policy.record(req.amountUsd)
      return true
    },
  })
  return { client, approvals }
}

describe('the spend gate covers LLM inference', () => {
  it('sees the reasoning turn, not just call_api', async () => {
    const g = payingGateway(0.21, [answerResponse('done')])
    const policy = new SpendPolicy({ confirmAboveUsd: 0.05, sessionLimitUsd: 1 })
    const { client, approvals } = await clientWith(policy, g.impl)

    await run('what is the eth gas fee', {
      client,
      model: 'google/gemini-3.5-flash',
      confirm: async () => true,
      log: () => {},
    })

    // This is the assertion that would have failed before: an LLM turn reaching the
    // policy at all.
    expect(approvals).toEqual([0.21])
    expect(policy.spentUsd()).toBeCloseTo(0.21, 6)
  })

  it('stops the run when the session limit is reached, mid-loop', async () => {
    // Three turns quoted at $0.40: two fit inside a $1 session limit, the third does
    // not. The incident shape exactly — many turns, each individually affordable.
    const g = payingGateway(0.4, [
      toolCallResponse('search_apis', { query: 'eth gas' }),
      toolCallResponse('search_apis', { query: 'gas oracle' }),
      answerResponse('never reached'),
    ])
    const policy = new SpendPolicy({ confirmAboveUsd: 10, sessionLimitUsd: 1 })
    const { client, approvals } = await clientWith(policy, g.impl)

    const result = await run('x', {
      client,
      model: 'm',
      confirm: async () => true,
      log: () => {},
    })

    expect(approvals.length, 'the third turn must have been offered and refused').toBe(3)
    expect(policy.spentUsd()).toBeCloseTo(0.8, 6)
    expect(result.stoppedBySpendLimit).toBe(true)
    // The rounds already paid for must not be thrown away.
    expect(result.answer).toContain('Stopped without finishing')
    expect(result.answer).toContain('--max-spend')
  })

  it('does not spend past the ceiling even when the model keeps asking', async () => {
    const g = payingGateway(0.6, [
      toolCallResponse('search_apis', { query: 'a' }),
      toolCallResponse('search_apis', { query: 'b' }),
      toolCallResponse('search_apis', { query: 'c' }),
      answerResponse('no'),
    ])
    const policy = new SpendPolicy({ confirmAboveUsd: 10, sessionLimitUsd: 1 })
    const { client } = await clientWith(policy, g.impl)

    await run('x', { client, model: 'm', confirm: async () => true, log: () => {} })

    // One turn at $0.60 fits; a second would reach $1.20. The total must never exceed
    // the stated limit, which is the whole promise of the flag.
    expect(policy.spentUsd()).toBeLessThanOrEqual(1)
    expect(policy.spentUsd()).toBeCloseTo(0.6, 6)
  })

  it('a declined charge ends the run without crashing', async () => {
    const g = payingGateway(5, [answerResponse('unreachable')])
    const policy = new SpendPolicy({ confirmAboveUsd: 0.05, sessionLimitUsd: 1 })
    const { client } = await clientWith(policy, g.impl)

    // Must resolve, not reject: the user asked to stay cheap, which is not an error.
    const result = await run('x', {
      client,
      model: 'm',
      confirm: async () => true,
      log: () => {},
    })

    expect(result.stoppedBySpendLimit).toBe(true)
    expect(g.served(), 'nothing may be served after a refusal').toBe(0)
  })

  it('a declined paid tool is reported to the model rather than ending the session', async () => {
    // The tool-level refusal path: the model should be told, and get a chance to
    // answer from what it has, instead of the run aborting.
    const turns = [answerResponse('I could not run that; the charge was declined.')]
    const g = payingGateway(0.001, turns)
    const policy = new SpendPolicy({ confirmAboveUsd: 10, sessionLimitUsd: 10 })
    const { client } = await clientWith(policy, g.impl)

    const result = await run('x', {
      client,
      model: 'm',
      confirm: async () => true,
      log: () => {},
    })
    expect(result.answer).toContain('declined')
    expect(result.stoppedBySpendLimit).toBeFalsy()
  })
})

describe('PaymentDeclinedError', () => {
  it('is distinguishable from a failure, and says what it refused', () => {
    const err = new PaymentDeclinedError({
      amountUsd: 0.21,
      resourceUrl: 'https://gateway.test/v1/chat/completions',
      reason: 'above the $0.05 per-call threshold',
    })
    expect(err.message).toContain('0.210000')
    expect(err.message).toContain('above the $0.05 per-call threshold')
    expect(err.amountUsd).toBe(0.21)
  })
})
