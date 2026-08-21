/**
 * Output budget, and what happens when a model runs out of it.
 *
 * These exist because the first version set no `max_tokens`, which broke the free
 * tier in the most confusing way possible. Several free models are reasoning models
 * that think in the content field before emitting a tool call. Against the
 * provider's small default they spent the whole budget reasoning and returned
 * `finish_reason: length` with `tool_calls: []` — so the agent explained which API
 * it should call instead of calling it, and the run looked like a slow success.
 *
 * Measured against production 2026-08-19, same prompt, tools attached:
 *
 *   auto/free -> nvidia/nemotron-3-super-120b   49s  finish=length     tools=0
 *   zai/glm-4-flash                              3s  finish=tool_calls tools=1
 *   nvidia/step-3.7-flash                        4s  finish=tool_calls tools=1
 *   nvidia/mistral-nemotron                     12s  finish=tool_calls tools=1
 *   nvidia/nemotron-nano-9b-v2                  18s  finish=tool_calls tools=1
 *   nvidia/deepseek-v4-flash                    42s  finish=tool_calls tools=1
 *
 * Every free model can call tools. Only the budget was wrong.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAX_TOKENS, TOOL_TURN_MAX_TOKENS, run } from '../src/agent/runner.js'
import { PlatformClient } from '../src/platform/client.js'
import { answerResponse, catalogueItem, toolCallResponse } from './helpers.js'

/** A chat turn that hit the output cap mid-thought and emitted no tool call. */
function truncatedResponse(content: string) {
  return {
    model: 'nvidia/nemotron-3-super-120b',
    choices: [{ finish_reason: 'length', message: { content, tool_calls: [] } }],
    usage: { completion_tokens: 512 },
  }
}

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

async function runWith(chatTurns: unknown[], opts: {
  routes?: Array<{ path: string; body: unknown; status?: number }>
  maxTokens?: number
  maxRounds?: number
  anonymous?: boolean
} = {}) {
  const { impl, chatBodies } = stubChat(chatTurns, opts.routes ?? [])
  const client = await PlatformClient.create({
    apiKey: 'sk-test',
    baseUrl: 'https://gateway.test',
    fetchImpl: impl,
    maxRetries: 0,
  })
  const result = await run('東京の天気', {
    client,
    model: 'auto/free',
    confirm: async () => true,
    log: () => {},
    ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
    ...(opts.maxRounds === undefined ? {} : { maxRounds: opts.maxRounds }),
    ...(opts.anonymous ? { anonymous: true } : {}),
  })
  return { result, chatBodies }
}

describe('output budget', () => {
  it('sends a max_tokens on every turn', async () => {
    // Without one, a reasoning model gets the provider's small default and spends
    // it all thinking, never reaching the tool call.
    const { chatBodies } = await runWith([answerResponse('done')])
    expect((chatBodies[0] as { max_tokens?: number }).max_tokens).toBeGreaterThan(0)
  })

  // On a PAID model the tool-selection turn is trimmed, because that turn is what
  // repeats and it is 83% of the bill. Measured against the gateway: max_tokens=1536
  // on google/gemini-3.5-flash quotes $0.2074 a turn, and the turns in the reported
  // incident produced 26-257 completion tokens — a mean of 134 against 1536 reserved.
  it('trims the tool-selection turn when it is being paid for', async () => {
    const { chatBodies } = await runWith([answerResponse('done')])
    expect((chatBodies[0] as { max_tokens?: number }).max_tokens).toBe(TOOL_TURN_MAX_TOKENS)
    expect(TOOL_TURN_MAX_TOKENS).toBeLessThan(DEFAULT_MAX_TOKENS)
  })

  // ...but not on the free tier, which is where the generous budget was measured to
  // be necessary. max_tokens is the price only when there is a price; trimming here
  // would reintroduce the original stall to save nothing.
  it('keeps the full budget on the free tier, where it costs nothing', async () => {
    const { chatBodies } = await runWith([answerResponse('done')], { anonymous: true })
    expect((chatBodies[0] as { max_tokens?: number }).max_tokens).toBe(DEFAULT_MAX_TOKENS)
  })

  // The trimmed budget must clear the largest tool turn actually observed, or the
  // saving is paid for in truncated work.
  it('leaves headroom above the largest observed tool turn', () => {
    // 257 was the largest completion in the reported incident.
    expect(TOOL_TURN_MAX_TOKENS).toBeGreaterThanOrEqual(257 * 2)
  })

  it('is generous enough for a reasoning preamble plus a tool call', () => {
    // The stalled production turn produced 512 completion tokens of reasoning and
    // still had not emitted the call, so the budget has to clear that with room.
    //
    // The floor was 2048 while this number was only about capability. It is also the
    // price: x402 prepays, the gateway quotes max_tokens × output_price, and EIP-3009
    // authorizes an exact value that cannot be reduced after the fact — so an unused
    // budget is money gone. 4096 made one agent turn cost $0.553.
    //
    // 1024 is the floor now, from measurement rather than taste. Over 7 days of
    // production logs the busiest free model averaged 466 completion tokens, p95 968,
    // max 1818. Probed serially against the live gateway with the real toolset, both
    // 1536 and 1024 reached call_api 5/5 with zero truncated turns, so the stall does
    // not return at either. The default sits at 1536 to clear p95 outright.
    expect(DEFAULT_MAX_TOKENS).toBeGreaterThanOrEqual(1024)
    // And an upper bound, because the reason this number is not simply "as large as
    // possible" is that every unused token is charged for.
    expect(DEFAULT_MAX_TOKENS).toBeLessThanOrEqual(2048)
  })

  it('sends the budget on the forced final turn too', async () => {
    const { chatBodies } = await runWith(
      [toolCallResponse('search_apis', { query: 'weather' }), answerResponse('final')],
      {
        routes: [
          { path: '/api/marketplace/apis', body: { data: { items: [catalogueItem()], total: 1 } } },
        ],
        maxRounds: 1,
      },
    )
    const last = chatBodies[chatBodies.length - 1] as { max_tokens?: number }
    expect(last.max_tokens).toBe(DEFAULT_MAX_TOKENS)
  })

  it('honours a caller-supplied budget', async () => {
    const { chatBodies } = await runWith([answerResponse('done')], { maxTokens: 256 })
    expect((chatBodies[0] as { max_tokens?: number }).max_tokens).toBe(256)
  })
})

describe('a model that runs out of budget', () => {
  // On the free tier the budget is already the full one, so a truncated turn is
  // terminal: retrying at the same size would stall identically and buy nothing.
  it('says so rather than passing its reasoning off as the answer', async () => {
    // This is what the bug looked like: a plausible paragraph about which API to
    // call, returned as though the task were done.
    const { result } = await runWith(
      [truncatedResponse('好的，用户问东京的天气。首先我需要检查有没有直接获取天气的工具…')],
      { anonymous: true },
    )
    expect(result.truncated).toBe(true)
    expect(result.toolsUsed).toEqual([])
  })

  it('does not keep looping once the budget is the problem', async () => {
    // Another round would stall identically and cost another call.
    const { chatBodies } = await runWith([truncatedResponse('thinking…')], { anonymous: true })
    expect(chatBodies).toHaveLength(1)
  })

  it('still returns the partial text, since it is often useful', async () => {
    const { result } = await runWith([truncatedResponse('I would call the weather API at')], {
      anonymous: true,
    })
    expect(result.answer).toContain('weather API')
  })

  it('explains itself when the model returned nothing at all', async () => {
    const { result } = await runWith([truncatedResponse('   ')], { anonymous: true })
    expect(result.answer).toMatch(/whole output budget/)
  })

  // On a PAID model the tool turn runs on the trimmed budget, so a truncated ANSWER
  // may simply have been given too little room. Retrying once at the full budget is
  // what keeps the saving honest: without it, trimming would buy a cheaper run by
  // cutting real answers short, which is not a saving at all.
  it('retries once at the full budget when a paid tool turn is truncated', async () => {
    const { result, chatBodies } = await runWith([
      truncatedResponse('The gas fee is roughly'),
      answerResponse('The current Ethereum gas fee is 12 gwei.'),
    ])
    expect(chatBodies).toHaveLength(2)
    expect((chatBodies[0] as { max_tokens?: number }).max_tokens).toBe(TOOL_TURN_MAX_TOKENS)
    expect((chatBodies[1] as { max_tokens?: number }).max_tokens).toBe(DEFAULT_MAX_TOKENS)
    expect(result.answer).toBe('The current Ethereum gas fee is 12 gwei.')
    expect(result.truncated).toBe(false)
  })

  it('reports truncation when even the full budget was not enough', async () => {
    const { result } = await runWith([
      truncatedResponse('thinking…'),
      truncatedResponse('still going and still not done'),
    ])
    expect(result.truncated).toBe(true)
    expect(result.answer).toContain('still going')
  })

  // The retry withholds tools, so it cannot start new paid work in order to finish a
  // sentence.
  it('withholds tools on the retry', async () => {
    const { chatBodies } = await runWith([
      truncatedResponse('partial'),
      answerResponse('done'),
    ])
    expect((chatBodies[1] as { tools?: unknown[] }).tools).toBeUndefined()
  })

  it('is not flagged when the model finished normally', async () => {
    const { result } = await runWith([answerResponse('Tokyo is 21°C.')])
    expect(result.truncated).toBe(false)
  })

  it('is not flagged when a truncated turn still emitted a tool call', async () => {
    // Truncation only matters when it stopped the work. A call was made, so the
    // loop continues normally.
    const truncatedButCalled = {
      model: 'test',
      choices: [
        {
          finish_reason: 'length',
          message: {
            content: 'thinking…',
            tool_calls: [{ id: 'c1', function: { name: 'search_apis', arguments: '{"query":"weather"}' } }],
          },
        },
      ],
    }
    const { result } = await runWith([truncatedButCalled, answerResponse('Found it.')], {
      routes: [
        { path: '/api/marketplace/apis', body: { data: { items: [catalogueItem()], total: 1 } } },
      ],
    })
    expect(result.toolsUsed).toEqual(['search_apis'])
    expect(result.answer).toBe('Found it.')
    expect(result.truncated).toBe(false)
  })
})
