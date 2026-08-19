import { InsufficientBalanceError } from '@jarvisclaw/sdk'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAX_ROUNDS, run } from '../src/agent/runner.js'
import { PlatformClient } from '../src/platform/client.js'
import { answerResponse, catalogueItem, toolCallResponse } from './helpers.js'

/**
 * A gateway whose /v1/chat/completions answers come from a queue, while every
 * other route is stubbed by path. The chat queue is ordered because the loop's
 * turn sequence is exactly what these tests are about.
 */
function stubAgentGateway(
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
      if (!next) throw new Error(`unexpected chat call #${chatBodies.length}`)
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

async function runWith(
  chatTurns: unknown[],
  opts: {
    routes?: Array<{ path: string; body: unknown; status?: number }>
    approve?: boolean
    maxRounds?: number
  } = {},
) {
  const { impl, chatBodies } = stubAgentGateway(chatTurns, opts.routes ?? [])
  const client = await PlatformClient.create({
    apiKey: 'sk-test',
    baseUrl: 'https://gateway.test',
    fetchImpl: impl,
    maxRetries: 0,
  })

  const logged: string[] = []
  const result = await run('do the thing', {
    client,
    model: 'test-model',
    confirm: async () => opts.approve ?? true,
    log: (l) => logged.push(l),
    ...(opts.maxRounds === undefined ? {} : { maxRounds: opts.maxRounds }),
  })
  return { result, chatBodies, logged }
}

describe('the agent loop', () => {
  it('returns a plain answer without calling any tool', async () => {
    const { result } = await runWith([answerResponse('Here is the answer.')])
    expect(result.answer).toBe('Here is the answer.')
    expect(result.toolsUsed).toEqual([])
    expect(result.rounds).toBe(1)
    expect(result.hitRoundLimit).toBe(false)
  })

  it('runs a tool and feeds the result back for the next turn', async () => {
    const { result, chatBodies } = await runWith(
      [
        toolCallResponse('search_apis', { query: 'weather' }),
        answerResponse('Found City Weather.'),
      ],
      {
        routes: [
          {
            path: '/api/marketplace/apis',
            body: { data: { items: [catalogueItem()], total: 1 } },
          },
        ],
      },
    )

    expect(result.toolsUsed).toEqual(['search_apis'])
    expect(result.answer).toBe('Found City Weather.')

    // The second request must carry the assistant turn with its tool_calls, then
    // the tool reply. Without the assistant turn the model sees a reply answering
    // nothing and errors.
    const second = chatBodies[1] as { messages: Array<Record<string, unknown>> }
    const assistant = second.messages.find((m) => m['role'] === 'assistant')
    expect(assistant?.['tool_calls']).toBeTruthy()
    const toolReply = second.messages.find((m) => m['role'] === 'tool')
    expect(toolReply?.['tool_call_id']).toBe('call_1')
    expect(String(toolReply?.['content'])).toContain('City Weather')
  })

  it('offers the tools on every turn', async () => {
    const { chatBodies } = await runWith([answerResponse('done')])
    const first = chatBodies[0] as { tools?: unknown[] }
    expect(first.tools?.length).toBeGreaterThan(0)
  })

  it('tells the model what happened when a tool fails, instead of aborting', async () => {
    // A failed tool is something to route around. Throwing would end a session
    // that is usually still recoverable.
    const { result, chatBodies } = await runWith(
      [toolCallResponse('search_apis', { query: 'x' }), answerResponse('That search failed.')],
      {
        routes: [
          {
            path: '/api/marketplace/apis',
            status: 500,
            body: { error: { message: 'catalogue read failed' } },
          },
        ],
      },
    )
    const second = chatBodies[1] as { messages: Array<Record<string, unknown>> }
    const toolReply = second.messages.find((m) => m['role'] === 'tool')
    expect(String(toolReply?.['content'])).toContain('catalogue read failed')
    expect(String(toolReply?.['content'])).toContain('Do not retry')
    expect(result.answer).toBe('That search failed.')
  })

  it('reports an unknown tool name back to the model', async () => {
    const { chatBodies } = await runWith([
      toolCallResponse('teleport', {}),
      answerResponse('No such tool.'),
    ])
    const second = chatBodies[1] as { messages: Array<Record<string, unknown>> }
    const toolReply = second.messages.find((m) => m['role'] === 'tool')
    expect(String(toolReply?.['content'])).toContain('No such tool: teleport')
  })

  it('reports malformed tool arguments rather than crashing', async () => {
    const malformed = {
      model: 'test-model',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: '',
            tool_calls: [{ id: 'c1', function: { name: 'search_apis', arguments: '{not json' } }],
          },
        },
      ],
    }
    const { chatBodies } = await runWith([malformed, answerResponse('retrying')])
    const second = chatBodies[1] as { messages: Array<Record<string, unknown>> }
    expect(String(second.messages.find((m) => m['role'] === 'tool')?.['content'])).toContain(
      'not valid JSON',
    )
  })

  it('runs every tool call in a single turn', async () => {
    const twoCalls = {
      model: 'test-model',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: '',
            tool_calls: [
              { id: 'c1', function: { name: 'list_models', arguments: '{}' } },
              { id: 'c2', function: { name: 'search_apis', arguments: '{"query":"x"}' } },
            ],
          },
        },
      ],
    }
    const { result } = await runWith([twoCalls, answerResponse('both done')], {
      routes: [
        { path: '/api/discovery/models', body: { data: [{ model: 'openai/gpt-5', free: true }] } },
        { path: '/api/marketplace/apis', body: { data: { items: [catalogueItem()], total: 1 } } },
      ],
    })
    expect(result.toolsUsed).toEqual(['list_models', 'search_apis'])
  })

  it('stops at the round cap and still answers', async () => {
    // An unbounded loop with a paid tool in it can spend in a cycle the user never
    // sees, so the cap is a real limit rather than a warning.
    const looping = Array.from({ length: 3 }, (_, i) =>
      toolCallResponse('list_models', {}, `c${i}`),
    )
    const { result } = await runWith([...looping, answerResponse('Partial answer.')], {
      routes: [{ path: '/api/discovery/models', body: { data: [{ model: 'openai/gpt-5', free: true }] } }],
      maxRounds: 3,
    })

    expect(result.hitRoundLimit).toBe(true)
    expect(result.rounds).toBe(3)
    expect(result.answer).toBe('Partial answer.')
    expect(result.toolsUsed).toHaveLength(3)
  })

  it('withholds tools on the forced final turn', async () => {
    // Otherwise the model calls another tool on the turn meant to conclude, and
    // the loop never terminates.
    const { chatBodies } = await runWith(
      [toolCallResponse('list_models', {}), answerResponse('final')],
      {
        routes: [{ path: '/api/discovery/models', body: { data: [{ model: 'openai/gpt-5', free: true }] } }],
        maxRounds: 1,
      },
    )
    const last = chatBodies[chatBodies.length - 1] as { tools?: unknown[] }
    expect(last.tools).toBeUndefined()
  })

  it('ends the session when the balance runs out', async () => {
    // Every further paid attempt fails identically, so looping on it only wastes
    // the user's time.
    const { impl } = stubAgentGateway(
      [toolCallResponse('call_api', { resource_id: 456 })],
      [
        { path: '/api/marketplace/apis/456', body: { data: catalogueItem() } },
        {
          path: '/v1/network/execute',
          status: 402,
          body: { error: { message: 'insufficient balance' } },
        },
      ],
    )
    const client = await PlatformClient.create({
      apiKey: 'sk-test',
      baseUrl: 'https://gateway.test',
      fetchImpl: impl,
      maxRetries: 0,
    })

    await expect(
      run('pay for something', {
        client,
        model: 'test-model',
        confirm: async () => true,
        log: () => {},
      }),
    ).rejects.toThrow(InsufficientBalanceError)
  })

  it('does not spend when the user declines, and carries on', async () => {
    const { result, chatBodies } = await runWith(
      [toolCallResponse('call_api', { resource_id: 456 }), answerResponse('Not run, then.')],
      {
        routes: [
          { path: '/api/marketplace/apis/456', body: { data: catalogueItem() } },
          { path: '/v1/network/execute', body: { should: 'never be reached' } },
        ],
        approve: false,
      },
    )
    const second = chatBodies[1] as { messages: Array<Record<string, unknown>> }
    expect(String(second.messages.find((m) => m['role'] === 'tool')?.['content'])).toMatch(
      /declined/,
    )
    expect(result.answer).toBe('Not run, then.')
  })

  it('instructs the model not to invent ids or prices', async () => {
    // The prompt is load-bearing: without it the model answers from memory and
    // fabricates resource ids that charge for the wrong API.
    const { chatBodies } = await runWith([answerResponse('ok')])
    const first = chatBodies[0] as { messages: Array<{ role: string; content: string }> }
    const system = first.messages.find((m) => m.role === 'system')?.content ?? ''
    expect(system).toMatch(/Never invent/)
    expect(system).toMatch(/approve every paid call/)
  })

  it('defaults to a bounded number of rounds', () => {
    expect(DEFAULT_MAX_ROUNDS).toBeGreaterThan(0)
    expect(DEFAULT_MAX_ROUNDS).toBeLessThanOrEqual(20)
  })
})
