import { describe, expect, it, vi } from 'vitest'
import { tools, toolSchemas, type ConfirmFn } from '../src/agent/tools.js'
import { catalogueItem, stubClient } from './helpers.js'

/** A confirm that records what it was asked and answers with `answer`. */
function confirmStub(answer: boolean) {
  const asked: Array<{ toolName: string; priceUsd: number | undefined }> = []
  const confirm: ConfirmFn = async (req) => {
    asked.push({ toolName: req.toolName, priceUsd: req.priceUsd })
    return answer
  }
  return { confirm, asked }
}

async function ctxFor(routes: Parameters<typeof stubClient>[0], approve = true) {
  const { client, calls } = await stubClient(routes)
  const { confirm, asked } = confirmStub(approve)
  const logged: string[] = []
  return { ctx: { client, confirm, log: (l: string) => logged.push(l) }, calls, asked, logged }
}

describe('tool schemas', () => {
  it('exposes every tool to the model', () => {
    const names = toolSchemas().map((s) => s.function.name)
    expect(names).toContain('search_apis')
    expect(names).toContain('get_api_detail')
    expect(names).toContain('call_api')
    expect(names).toContain('list_models')
    expect(names).toContain('resolve_intent')
    expect(names).toContain('discover_agents')
    expect(names).toContain('check_balance')
    expect(names).toHaveLength(Object.keys(tools).length)
  })

  it('marks exactly the money-spending tools as paid', () => {
    // Mislabelling a paid tool as free would skip the confirmation prompt.
    const paid = Object.entries(tools)
      .filter(([, t]) => t.cost === 'paid')
      .map(([name]) => name)
    expect(paid).toEqual(['call_api'])
  })

  it('names each schema after its registry key', () => {
    // A mismatch would make the model call a name the runner cannot dispatch.
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.schema.function.name).toBe(name)
    }
  })
})

describe('search_apis', () => {
  it('sends the query as `q`', async () => {
    // `keyword` is silently ignored by the gateway, returning an unfiltered page
    // that looks like a successful but irrelevant search.
    const { ctx, calls } = await ctxFor([
      { path: '/api/marketplace/apis', body: { data: { items: [catalogueItem()], total: 1 } } },
    ])
    await tools['search_apis']!.run({ query: 'weather' }, ctx)
    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get('q')).toBe('weather')
    expect(url.searchParams.has('keyword')).toBe(false)
  })

  it('reports the handle, price and method the agent needs next', async () => {
    const { ctx } = await ctxFor([
      { path: '/api/marketplace/apis', body: { data: { items: [catalogueItem()], total: 1 } } },
    ])
    const out = await tools['search_apis']!.run({ query: 'weather' }, ctx)
    expect(out).toContain('federation/456')
    expect(out).toContain('City Weather')
    expect(out).toContain('0.01150')
    expect(out).toContain('POST')
  })

  it('lists the live categories when nothing matched', async () => {
    // The categories are read from the response, never hardcoded, so the agent
    // learns what actually exists rather than what the SDK once believed.
    const { ctx } = await ctxFor([
      {
        path: '/api/marketplace/apis',
        body: {
          data: {
            items: [],
            total: 0,
            categories: [{ category: 'blockchain', count: 249 }],
          },
        },
      },
    ])
    const out = await tools['search_apis']!.run({ query: 'nonexistent' }, ctx)
    expect(out).toContain('blockchain (249)')
  })
})

describe('get_api_detail', () => {
  it('surfaces the resource id call_api needs', async () => {
    const { ctx } = await ctxFor([
      { path: '/api/marketplace/apis/456', body: { data: catalogueItem() } },
    ])
    const out = await tools['get_api_detail']!.run({ ref: 'federation/456' }, ctx)
    expect(out).toContain('resource_id: 456')
    expect(out).toContain('$0.01150')
  })

  it('accepts a bare numeric handle as well as federation/N', async () => {
    const { ctx, calls } = await ctxFor([
      { path: '/api/marketplace/apis/456', body: { data: catalogueItem() } },
    ])
    await tools['get_api_detail']!.run({ ref: '456' }, ctx)
    expect(calls[0]!.url).toContain('/api/marketplace/apis/456')
  })

  it('says the API is gone rather than inventing a spec', async () => {
    const { ctx } = await ctxFor([{ path: '/api/marketplace/apis/999', body: { data: null } }])
    const out = await tools['get_api_detail']!.run({ ref: '999' }, ctx)
    expect(out).toMatch(/No catalogue API matches/)
  })
})

describe('call_api', () => {
  const routes = [
    { path: '/api/marketplace/apis/456', body: { data: catalogueItem() } },
    { path: '/v1/network/execute', body: { temperature_c: 21 } },
  ]

  it('asks before spending, quoting the live catalogue price', async () => {
    const { ctx, asked } = await ctxFor(routes)
    await tools['call_api']!.run({ resource_id: 456, payload: { city: 'Tokyo' } }, ctx)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toEqual({ toolName: 'call_api', priceUsd: 0.0115 })
  })

  it('does not call the paid endpoint when the user declines', async () => {
    const { ctx, calls } = await ctxFor(routes, false)
    const out = await tools['call_api']!.run({ resource_id: 456 }, ctx)
    expect(out).toMatch(/declined/)
    expect(calls.some((c) => c.url.includes('/v1/network/execute'))).toBe(false)
  })

  it('re-reads the price rather than trusting what the model passed', async () => {
    // The model may have read a price several turns ago. The user approves a
    // number, so it has to be the live one.
    const { ctx, asked, calls } = await ctxFor([
      { path: '/api/marketplace/apis/456', body: { data: catalogueItem({ display_price: 0.5 }) } },
      { path: '/v1/network/execute', body: { ok: true } },
    ])
    await tools['call_api']!.run({ resource_id: 456 }, ctx)
    expect(asked[0]?.priceUsd).toBe(0.5)
    expect(calls[0]!.url).toContain('/api/marketplace/apis/456')
  })

  it('refuses a resource that is no longer in the catalogue', async () => {
    const { ctx, calls } = await ctxFor([
      { path: '/api/marketplace/apis/999', body: { data: null } },
      { path: '/v1/network/execute', body: { ok: true } },
    ])
    const out = await tools['call_api']!.run({ resource_id: 999 }, ctx)
    expect(out).toMatch(/not in the catalogue/)
    expect(calls.some((c) => c.url.includes('/v1/network/execute'))).toBe(false)
  })

  it('rejects a non-numeric resource id without asking to pay', async () => {
    const { ctx, asked } = await ctxFor(routes)
    const out = await tools['call_api']!.run({ resource_id: 'city-weather' }, ctx)
    expect(out).toMatch(/must be a positive integer/)
    expect(asked).toHaveLength(0)
  })

  it('sends resource_id, payload and method to the execute endpoint', async () => {
    const { ctx, calls } = await ctxFor(routes)
    await tools['call_api']!.run(
      { resource_id: 456, payload: { city: 'Tokyo' }, endpoint: 'current' },
      ctx,
    )
    const exec = calls.find((c) => c.url.includes('/v1/network/execute'))
    expect(exec?.method).toBe('POST')
    expect(exec?.body).toEqual({
      resource_id: 456,
      payload: { city: 'Tokyo' },
      // Defaulted from the catalogue, so a GET endpoint is not forwarded as POST.
      method: 'POST',
      endpoint: 'current',
    })
  })

  it("defaults the method to the catalogue's, not to POST", async () => {
    const { ctx, calls } = await ctxFor([
      { path: '/api/marketplace/apis/321', body: { data: catalogueItem({ resource_id: 321, method: 'GET' }) } },
      { path: '/v1/network/execute', body: { ok: true } },
    ])
    await tools['call_api']!.run({ resource_id: 321 }, ctx)
    const exec = calls.find((c) => c.url.includes('/v1/network/execute'))
    expect((exec?.body as { method?: string }).method).toBe('GET')
  })

  it('omits payload entirely when none was given', async () => {
    // The gateway distinguishes an absent payload from an empty one, so sending
    // `{}` would change what the upstream endpoint receives.
    const { ctx, calls } = await ctxFor(routes)
    await tools['call_api']!.run({ resource_id: 456 }, ctx)
    const exec = calls.find((c) => c.url.includes('/v1/network/execute'))
    expect(Object.keys(exec?.body as object)).not.toContain('payload')
  })
})

describe('check_balance', () => {
  it('reports the balance and where it lives', async () => {
    const { ctx } = await ctxFor([{ path: '/v1/wallet/balance', body: { balance_usd: '3.25' } }])
    const out = await tools['check_balance']!.run({}, ctx)
    expect(out).toContain('3.250000')
  })
})

describe('discover_agents', () => {
  it('parses the JSON-encoded capabilities string', async () => {
    const { ctx } = await ctxFor([
      {
        path: '/api/agents',
        body: {
          data: [
            {
              agent_id: 'jarvisclaw-chat',
              name: 'JarvisClaw Chat',
              category: 'ai',
              capabilities: '["chat","streaming"]',
              price_per_call: 0,
              verified: true,
              mcp_url: 'https://api.jarvisclaw.ai/mcp',
            },
          ],
        },
      },
    ])
    const out = await tools['discover_agents']!.run({}, ctx)
    expect(out).toContain('chat, streaming')
    expect(out).not.toContain('["chat"')
    expect(out).toContain('verified')
  })

  it('survives a malformed capabilities value in someone else\'s row', async () => {
    const { ctx } = await ctxFor([
      {
        path: '/api/agents',
        body: { data: [{ agent_id: 'x', name: 'X', capabilities: 'not json', price_per_call: 0 }] },
      },
    ])
    const out = await tools['discover_agents']!.run({}, ctx)
    expect(out).toContain('X')
  })
})

describe('list_models', () => {
  it('lists the ids the model can pass as `model`', async () => {
    const { ctx } = await ctxFor([
      { path: '/api/discovery/models', body: { data: [{ model: 'openai/gpt-5', input_per_m_token_usd: 2, free: false }] } },
    ])
    const out = await tools['list_models']!.run({}, ctx)
    expect(out).toContain('openai/gpt-5')
  })

  it('separates free models from paid ones', async () => {
    // The agent should reach for a free model when the task does not need a paid
    // one, and it can only do that if the split is stated.
    const { ctx } = await ctxFor([
      {
        path: '/api/discovery/models',
        body: {
          data: [
            { model: 'zai/glm-4-flash', free: true },
            { model: 'openai/gpt-5', input_per_m_token_usd: 2, free: false },
          ],
        },
      },
    ])
    const out = await tools['list_models']!.run({}, ctx)
    expect(out).toMatch(/Free \(no charge\):[\s\S]*zai\/glm-4-flash/)
    expect(out).toMatch(/Paid \(1\)/)
  })

  it('says so plainly when the gateway reports none', async () => {
    const { ctx } = await ctxFor([{ path: '/api/discovery/models', body: { data: [] } }, { path: '/v1/models', body: { data: [] } }])
    const out = await tools['list_models']!.run({}, ctx)
    expect(out).toMatch(/no models/i)
  })
})
