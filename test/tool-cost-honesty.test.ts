/**
 * Tool cost labels must match what the gateway actually does.
 *
 * These tests exist because the first version got it wrong in a way the whole
 * suite missed: `resolve_intent` and `check_balance` were marked `free` and
 * described to the model as free, while both endpoints answer 402 to a caller with
 * no credential. `resolve_intent` was worse — it sent only `{query}`, which the
 * gateway rejects as a 400 for a missing `intent`, except the x402 middleware runs
 * first and quotes the flat $0.045 fallback before validation is reached. So the
 * documented-free tool billed nearly five cents for a call that could not have
 * worked.
 *
 * A 402 from a free-labelled tool then aborted the entire session and advised the
 * user to "switch to a free model with --model auto/free" while they were already
 * on auto/free.
 *
 * Measured against production, 2026-08-19:
 *
 *   POST /v1/intent/resolve  {"query":"hi"}                      -> 402 $0.045
 *   POST /v1/intent/resolve  {"query":..,"payload":{model:free}}  -> 400 intent required
 *   POST /v1/intent/resolve  {"intent":"chat_completion", free}   -> 200 free
 *   POST /v1/intent/resolve  {"intent":.., paid model}            -> 402 $0.675
 *   GET  /v1/wallet/balance                                       -> 402 $0.045
 */
import { InsufficientBalanceError } from '@jarvisclaw/sdk'
import { describe, expect, it, vi } from 'vitest'
import { run } from '../src/agent/runner.js'
import { toolSchemas, tools } from '../src/agent/tools.js'
import { PlatformClient } from '../src/platform/client.js'
import { answerResponse, stubClient, toolCallResponse } from './helpers.js'

describe('cost labels match the endpoints', () => {
  it('marks the two credential-only tools as such, not as free', () => {
    // Both are free of charge but 402 without a credential. Labelling them free
    // put the agent into a 402 it could neither pay nor act on.
    expect(tools['resolve_intent']!.cost).toBe('credentialed')
    expect(tools['check_balance']!.cost).toBe('credentialed')
  })

  it('keeps the genuinely anonymous tools free', () => {
    // Verified against production: all four answer 200 with no credential.
    for (const name of ['search_apis', 'get_api_detail', 'list_models', 'discover_agents']) {
      expect(tools[name]!.cost).toBe('free')
    }
  })

  it('keeps call_api the only money-spending tool', () => {
    const paid = Object.entries(tools)
      .filter(([, t]) => t.cost === 'paid')
      .map(([name]) => name)
    expect(paid).toEqual(['call_api'])
  })

  it('does not describe a credentialed tool to the model as simply free', () => {
    // The description is what the model reasons about. Calling it free led the
    // agent to reach for it in a session that could not use it.
    for (const name of ['resolve_intent', 'check_balance']) {
      const description = tools[name]!.schema.function.description
      expect(description).toMatch(/credential/i)
    }
  })
})

describe('anonymous tool set', () => {
  it('offers only the tools that work with no credential', () => {
    const names = toolSchemas({ anonymous: true }).map((s) => s.function.name)
    expect(names).toContain('search_apis')
    expect(names).toContain('list_models')
    expect(names).not.toContain('resolve_intent')
    expect(names).not.toContain('check_balance')
    expect(names).not.toContain('call_api')
  })

  it('offers everything when there is a credential', () => {
    const names = toolSchemas().map((s) => s.function.name)
    expect(names).toHaveLength(Object.keys(tools).length)
    expect(names).toContain('resolve_intent')
    expect(names).toContain('call_api')
  })

  it('tells the model why tools are missing rather than letting it guess', async () => {
    const { impl, chatBodies } = stubChat([answerResponse('ok')])
    const client = await PlatformClient.create({
      baseUrl: 'https://gateway.test',
      allowAnonymous: true,
      fetchImpl: impl,
    })
    await run('what can you do', {
      client,
      model: 'auto/free',
      confirm: async () => false,
      log: () => {},
      anonymous: true,
    })
    const system = (chatBodies[0] as { messages: Array<{ role: string; content: string }> }).messages
      .find((m) => m.role === 'system')!.content
    expect(system).toMatch(/no credential/i)
    expect(system).toMatch(/jarvisclaw login/)
  })
})

describe('a 402 from a free-labelled tool', () => {
  it('is reported to the model instead of killing the session', async () => {
    // The bug: an endpoint that 402s a caller aborted the whole run, so the user
    // saw a payment error for something they never asked to buy. An API key that
    // the gateway does not accept for this route reaches the real 402.
    const { impl, chatBodies } = stubChat(
      [toolCallResponse('check_balance', {}), answerResponse('You need to log in for that.')],
      [{ path: '/v1/wallet/balance', status: 402, body: { accepts: [] } }],
    )
    const client = await PlatformClient.create({
      apiKey: 'sk-not-accepted-here',
      baseUrl: 'https://gateway.test',
      fetchImpl: impl,
      maxRetries: 0,
    })

    const result = await run('what is my balance', {
      client,
      model: 'auto/free',
      confirm: async () => false,
      log: () => {},
    })

    const second = chatBodies[1] as { messages: Array<Record<string, unknown>> }
    const toolReply = second.messages.find((m) => m['role'] === 'tool')
    expect(String(toolReply?.['content'])).toMatch(/unavailable without a credential/)
    expect(String(toolReply?.['content'])).toMatch(/jarvisclaw login/)
    expect(result.answer).toBe('You need to log in for that.')
  })

  it('reports the anonymous case as needing a login too', async () => {
    // With no credential the SDK refuses before the request, since there is no
    // balance to read. That must also reach the model rather than abort the run.
    const { impl, chatBodies } = stubChat([
      toolCallResponse('check_balance', {}),
      answerResponse('Log in to see a balance.'),
    ])
    const client = await PlatformClient.create({
      baseUrl: 'https://gateway.test',
      allowAnonymous: true,
      fetchImpl: impl,
    })

    const result = await run('what is my balance', {
      client,
      model: 'auto/free',
      confirm: async () => false,
      log: () => {},
      anonymous: true,
    })

    const second = chatBodies[1] as { messages: Array<Record<string, unknown>> }
    expect(String(second.messages.find((m) => m['role'] === 'tool')?.['content'])).toMatch(
      /no balance to read/,
    )
    expect(result.answer).toBe('Log in to see a balance.')
  })

  it('still ends the session when a paid tool runs out of funds', async () => {
    // The user approved a charge there, so every further attempt fails identically
    // and looping only wastes their time.
    const { impl } = stubChat(
      [toolCallResponse('call_api', { resource_id: 456 })],
      [
        {
          path: '/api/marketplace/apis/456',
          body: { data: { service_id: 'federation/456', resource_id: 456, name: 'X', display_price: 0.01, method: 'POST' } },
        },
        { path: '/v1/network/execute', status: 402, body: { error: { message: 'insufficient' } } },
      ],
    )
    const client = await PlatformClient.create({
      apiKey: 'sk-test',
      baseUrl: 'https://gateway.test',
      fetchImpl: impl,
      maxRetries: 0,
    })

    await expect(
      run('call it', {
        client,
        model: 'auto/free',
        confirm: async () => true,
        log: () => {},
      }),
    ).rejects.toThrow(InsufficientBalanceError)
  })
})

describe('resolveIntent request shape', () => {
  it('sends `intent`, which the gateway requires', async () => {
    // Sending only {query} is a 400 for a missing intent — and the x402 middleware
    // answers 402 at the $0.045 fallback before validation is even reached, so the
    // caller is billed for a request that could never have succeeded.
    const { client, calls } = await stubClient([
      { path: '/v1/intent/resolve', body: { matches: [] } },
    ])
    await client.resolveIntent({ intent: 'chat_completion' })
    expect(calls[0]!.body).toEqual({ intent: 'chat_completion' })
  })

  it('omits the model unless one was asked for', async () => {
    // The gateway prices this lookup on the model in the payload, so volunteering
    // a paid model would make a free lookup cost that model's price.
    const { client, calls } = await stubClient([
      { path: '/v1/intent/resolve', body: { matches: [] } },
    ])
    await client.resolveIntent({ intent: 'image_generation' })
    expect(Object.keys(calls[0]!.body as object)).not.toContain('payload')
  })

  it('passes a model through when the caller named one', async () => {
    const { client, calls } = await stubClient([
      { path: '/v1/intent/resolve', body: { matches: [] } },
    ])
    await client.resolveIntent({ intent: 'chat_completion', model: 'zai/glm-4-flash' })
    expect(calls[0]!.body).toEqual({
      intent: 'chat_completion',
      payload: { model: 'zai/glm-4-flash' },
    })
  })

  it('reads the live response field names, not just the documented ones', async () => {
    // Production returns provider_id and estimated_price_usd; the documented shape
    // uses provider_name and price_usd. A match rendered with an empty name is
    // indistinguishable from no match at all.
    const { client } = await stubClient([
      {
        path: '/v1/intent/resolve',
        body: {
          matches: [
            {
              provider_id: 'smart_route',
              score: 1,
              estimated_price_usd: 0,
              model: 'zai/glm-4-flash',
            },
          ],
        },
      },
    ])
    const resolved = await client.resolveIntent({ intent: 'chat_completion' })
    expect(resolved.matches[0]?.providerName).toBe('smart_route')
    expect(resolved.matches[0]?.priceUsd).toBe(0)
  })
})

/** A gateway whose chat answers come from a queue, other routes stubbed by path. */
function stubChat(
  chatTurns: unknown[],
  routes: Array<{ path: string; body: unknown; status?: number }> = [],
) {
  const chatBodies: unknown[] = []
  const queue = [...chatTurns]
  const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const href = String(url)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined

    if (href.includes('/v1/chat/completions')) {
      chatBodies.push(body)
      const next = queue.shift()
      if (!next) throw new Error('unexpected chat call')
      return new Response(JSON.stringify(next), {
        headers: { 'content-type': 'application/json' },
      })
    }
    const route = routes.find((r) => href.includes(r.path))
    if (!route) throw new Error(`no route for ${href}`)
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { impl: impl as unknown as typeof fetch, chatBodies }
}
