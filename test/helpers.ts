/** Test doubles: a stubbed gateway and a PlatformClient wired to it. */
import { vi } from 'vitest'
import { PlatformClient } from '../src/platform/client.js'

export interface RecordedCall {
  url: string
  method: string
  body: unknown
}

/** One stubbed route: matched on a path substring. */
export interface Route {
  path: string
  status?: number
  body: unknown
}

/**
 * A fetch stub that answers by path rather than by call order.
 *
 * Order-based stubs make these tests fragile: the agent loop legitimately varies
 * how many lookups it does before a call, and a reordering should not read as a
 * behavioural failure.
 */
export function stubGateway(routes: Route[]) {
  const calls: RecordedCall[] = []
  const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const href = String(url)
    calls.push({
      href,
      url: href,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    } as RecordedCall & { href: string })

    const route = routes.find((r) => href.includes(r.path))
    if (!route) {
      throw new Error(`stubGateway: no route for ${href}\nknown: ${routes.map((r) => r.path).join(', ')}`)
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })

  return { impl: impl as unknown as typeof fetch, calls }
}

/** A client pointed at a stubbed gateway. */
export async function stubClient(routes: Route[]) {
  const { impl, calls } = stubGateway(routes)
  const client = await PlatformClient.create({
    apiKey: 'sk-test',
    baseUrl: 'https://gateway.test',
    fetchImpl: impl,
    maxRetries: 0,
  })
  return { client, calls }
}

/** One catalogue row, in the gateway's wire shape. */
export function catalogueItem(overrides: Record<string, unknown> = {}) {
  return {
    service_id: 'federation/456',
    resource_id: 456,
    name: 'City Weather',
    category: 'geo',
    description: 'Current conditions for a city.',
    display_price: 0.0115,
    price_unit: 'call',
    method: 'POST',
    slug: 'city-weather',
    tags: 'weather,geo',
    ...overrides,
  }
}

/** A chat response asking for one tool call. */
export function toolCallResponse(name: string, args: unknown, id = 'call_1') {
  return {
    model: 'test-model',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: '',
          tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: { total_tokens: 10 },
  }
}

/** A chat response with a plain answer and no tool calls. */
export function answerResponse(content: string) {
  return {
    model: 'test-model',
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { total_tokens: 5 },
  }
}
