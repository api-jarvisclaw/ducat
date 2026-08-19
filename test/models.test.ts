/**
 * Tests for the model-listing path.
 *
 * Its own file because it covers a bug a mocked test could not have found: the
 * command was written against `/v1/models`, which answers 401 without a
 * credential, so `jarvisclaw models` — documented as needing no login — failed for
 * exactly the audience it was for. Only running it against the real gateway showed
 * that. These tests pin the fix.
 */
import { describe, expect, it } from 'vitest'
import { stubClient } from './helpers.js'

const DISCOVERY = '/api/discovery/models'
const OPENAI_COMPAT = '/v1/models'

function discoveryRow(model: string, free = false, input = 0.5) {
  return {
    model,
    input_per_m_token_usd: free ? 0 : input,
    output_per_m_token_usd: free ? 0 : input * 2,
    pricing_type: 'per-token',
    currency: 'USDC',
    free,
  }
}

describe('models()', () => {
  it('reads the public discovery endpoint, which needs no credential', async () => {
    const { client, calls } = await stubClient([
      { path: DISCOVERY, body: { count: 1, data: [discoveryRow('openai/gpt-5')] } },
    ])
    const list = await client.models()
    expect(list.map((m) => m.id)).toEqual(['openai/gpt-5'])
    expect(calls[0]!.url).toContain(DISCOVERY)
    // Never reached, so an unauthenticated user is not 401'd.
    expect(calls.some((c) => c.url.includes(OPENAI_COMPAT))).toBe(false)
  })

  it('reports which models are free from the gateway, not from a local list', async () => {
    // A hardcoded free list drifts, and the drift shows up as the CLI promising a
    // free model the gateway now charges for.
    const { client } = await stubClient([
      {
        path: DISCOVERY,
        body: {
          data: [discoveryRow('zai/glm-4-flash', true), discoveryRow('openai/gpt-5', false, 2)],
        },
      },
    ])
    const list = await client.models()
    expect(list.find((m) => m.id === 'zai/glm-4-flash')?.free).toBe(true)
    expect(list.find((m) => m.id === 'openai/gpt-5')?.free).toBe(false)
  })

  it('carries per-token prices so the caller can show them', async () => {
    const { client } = await stubClient([
      { path: DISCOVERY, body: { data: [discoveryRow('openai/gpt-5', false, 2)] } },
    ])
    const model = (await client.models())[0]!
    expect(model.inputPerMTokenUsd).toBe(2)
    expect(model.outputPerMTokenUsd).toBe(4)
  })

  it('derives the vendor from the id prefix', async () => {
    const { client } = await stubClient([
      { path: DISCOVERY, body: { data: [discoveryRow('nvidia/nemotron-nano-9b-v2', true)] } },
    ])
    expect((await client.models())[0]!.ownedBy).toBe('nvidia')
  })

  it('falls back to /v1/models when discovery is unavailable', async () => {
    // A self-hosted gateway may not expose the discovery routes; the
    // OpenAI-compatible list still works there for an authenticated caller.
    const { client, calls } = await stubClient([
      { path: DISCOVERY, status: 404, body: { error: 'not found' } },
      { path: OPENAI_COMPAT, body: { data: [{ id: 'gpt-5', owned_by: 'openai' }] } },
    ])
    const list = await client.models()
    expect(list.map((m) => m.id)).toEqual(['gpt-5'])
    expect(calls.some((c) => c.url.includes(OPENAI_COMPAT))).toBe(true)
  })

  it('falls back when discovery answers with an empty list', async () => {
    const { client, calls } = await stubClient([
      { path: DISCOVERY, body: { count: 0, data: [] } },
      { path: OPENAI_COMPAT, body: { data: [{ id: 'gpt-5' }] } },
    ])
    expect((await client.models()).map((m) => m.id)).toEqual(['gpt-5'])
    expect(calls.some((c) => c.url.includes(OPENAI_COMPAT))).toBe(true)
  })

  it('does not claim a fallback model is free', async () => {
    // /v1/models carries no pricing, so `free` there would be an assumption.
    const { client } = await stubClient([
      { path: DISCOVERY, status: 500, body: {} },
      { path: OPENAI_COMPAT, body: { data: [{ id: 'gpt-5' }] } },
    ])
    expect((await client.models())[0]!.free).toBe(false)
  })
})

describe('freeModels()', () => {
  it('returns only the genuinely zero-cost rows', async () => {
    // The endpoint reports `free` and `cheap` side by side. Treating cheap as free
    // would quote "free" to someone who then gets charged.
    const { client } = await stubClient([
      {
        path: '/api/discovery/free-models',
        body: {
          free: [discoveryRow('zai/glm-4-flash', true)],
          cheap: [discoveryRow('ali/qwen3.5-flash', false, 0.1)],
        },
      },
    ])
    const list = await client.freeModels()
    expect(list.map((m) => m.id)).toEqual(['zai/glm-4-flash'])
  })

  it('drops a row the endpoint listed under free but did not mark free', async () => {
    const { client } = await stubClient([
      {
        path: '/api/discovery/free-models',
        body: { free: [discoveryRow('mislabelled/model', false, 1)] },
      },
    ])
    expect(await client.freeModels()).toEqual([])
  })

  it('returns nothing rather than failing when there are no free models', async () => {
    const { client } = await stubClient([{ path: '/api/discovery/free-models', body: {} }])
    expect(await client.freeModels()).toEqual([])
  })
})

/**
 * Video, image and music models bill per call and report BOTH token rates as 0. The
 * mapping read those as a price, so `jarvisclaw models` printed "$0/M in · $0/M out" for
 * bytedance/seedance-2.5 — which costs $1.575 a call. Understating a real charge as
 * free is the worst direction for this to be wrong in, and it is not visible from
 * the numbers alone: only `pricing_type` distinguishes the two.
 */
describe('per-call pricing', () => {
  function perCallRow(model: string, fixed: number) {
    return {
      model,
      // Exactly as the gateway reports it: zeroes that are not a price.
      input_per_m_token_usd: 0,
      output_per_m_token_usd: 0,
      pricing_type: 'per-call',
      fixed_price_usd: fixed,
      currency: 'USDC',
      free: false,
    }
  }

  it('does not report a zero token rate as the price of a per-call model', async () => {
    const { client } = await stubClient([
      { path: DISCOVERY, body: { data: [perCallRow('bytedance/seedance-2.5', 1.575)] } },
    ])
    const [m] = await client.models()
    expect(m!.inputPerMTokenUsd).toBeUndefined()
    expect(m!.outputPerMTokenUsd).toBeUndefined()
  })

  it('carries the per-call price and says how the model bills', async () => {
    const { client } = await stubClient([
      { path: DISCOVERY, body: { data: [perCallRow('zai/cogview-4', 0.04)] } },
    ])
    const [m] = await client.models()
    expect(m!.pricing).toBe('per-call')
    expect(m!.fixedPriceUsd).toBe(0.04)
    expect(m!.free).toBe(false)
  })

  it('still reports token rates for per-token models', async () => {
    const { client } = await stubClient([
      { path: DISCOVERY, body: { data: [discoveryRow('openai/gpt-5', false, 0.5)] } },
    ])
    const [m] = await client.models()
    expect(m!.pricing).toBe('per-token')
    expect(m!.inputPerMTokenUsd).toBe(0.5)
    expect(m!.fixedPriceUsd).toBeUndefined()
  })

  it('treats a gateway that omits pricing_type as per-token', async () => {
    // An older or self-hosted gateway may not send the field. Assuming per-call
    // would discard real token rates.
    const { client } = await stubClient([
      {
        path: DISCOVERY,
        body: { data: [{ model: 'x/y', input_per_m_token_usd: 1, output_per_m_token_usd: 2 }] },
      },
    ])
    const [m] = await client.models()
    expect(m!.pricing).toBe('per-token')
    expect(m!.inputPerMTokenUsd).toBe(1)
  })
})
