/**
 * The tools the agent can call, wired to real gateway endpoints.
 *
 * This is what separates this from a chat wrapper: the model does not describe how
 * to call an API, it calls one. Two rules hold throughout:
 *
 *  - No catalogue is hardcoded. Names, categories, prices and specs are read live,
 *    so nothing here can go stale against the platform.
 *  - Nothing that costs money runs without consent. A paid tool asks first, through
 *    the `confirm` callback, and the price it quotes is the one the catalogue just
 *    returned rather than an estimate.
 */
import type { PlatformClient, ToolSchema } from '../platform/client.js'

/**
 * What a tool costs, which decides whether the runner asks first.
 *
 * `free` — reachable with no credential at all.
 * `credentialed` — free of charge, but the gateway answers 402 without a
 *   credential, so it is unusable anonymously. Not prompted for (there is no price
 *   to approve) but excluded from the anonymous tool set, because offering it would
 *   send the agent into a 402 it cannot act on.
 * `paid` — spends money per call; always confirmed with a live price.
 */
export type ToolCost = 'free' | 'credentialed' | 'paid'

/** Asked before a paid call. Returning false cancels it. */
export type ConfirmFn = (request: {
  toolName: string
  summary: string
  priceUsd: number | undefined
}) => Promise<boolean>

export interface ToolContext {
  client: PlatformClient
  confirm: ConfirmFn
  /** Where progress goes; the runner supplies something that renders it. */
  log: (line: string) => void
}

/** One tool: its schema for the model, and its implementation. */
export interface Tool {
  schema: ToolSchema
  cost: ToolCost
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

/** The result the model sees when it declines to pay, or the user does. */
const DECLINED = 'The user declined this call, so it was not made and nothing was charged.'

export const tools: Record<string, Tool> = {
  list_models: {
    cost: 'free',
    schema: {
      type: 'function',
      function: {
        name: 'list_models',
        description:
          'List the AI models this gateway currently serves, with the exact ids to pass as `model`. Free. Use it before assuming a model exists — the gateway answers 503 for one it has no channel for rather than substituting another.',
        parameters: { type: 'object', properties: {} },
      },
    },
    async run(_args, ctx) {
      const models = await ctx.client.models()
      if (models.length === 0) {
        return 'The gateway reported no models. This is unusual and probably a gateway-side problem, not a bad query.'
      }

      // Free models are called out because the agent should reach for one when the
      // task does not need a paid model, and it can only know which are free if the
      // gateway says so.
      const free = models.filter((m) => m.free).map((m) => m.id)
      const paid = models.filter((m) => !m.free)
      const lines = paid.map((m) => {
        const price =
          m.inputPerMTokenUsd === undefined
            ? ''
            : ` — $${m.inputPerMTokenUsd}/M in, $${m.outputPerMTokenUsd ?? '?'}/M out`
        return `${m.id}${price}`
      })

      return [
        free.length > 0 ? `Free (no charge):\n${free.join('\n')}\n` : '',
        `Paid (${paid.length}):\n${lines.join('\n')}`,
      ]
        .filter(Boolean)
        .join('\n')
    },
  },

  search_apis: {
    cost: 'free',
    schema: {
      type: 'function',
      function: {
        name: 'search_apis',
        description:
          'Search the catalogue of callable APIs — thousands of endpoints across search, blockchain, image, audio, document, geo, dns, email and more. Free to search; you pay only when you invoke one. Each result carries the handle, price per call and HTTP method needed to call it.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'What to look for. Matches name, description, tags and category.',
            },
            category: {
              type: 'string',
              description:
                'Optional category filter. Omit it and the result lists the live categories with counts, which is the reliable way to learn what exists.',
            },
          },
        },
      },
    },
    async run(args, ctx) {
      const page = await ctx.client.searchApis({
        ...(typeof args['query'] === 'string' ? { query: args['query'] } : {}),
        ...(typeof args['category'] === 'string' ? { category: args['category'] } : {}),
        pageSize: 15,
      })

      if (page.items.length === 0) {
        const categories = page.categories
          .map((c) => `${c.category} (${c.count})`)
          .join(', ')
        return `No API matched. Available categories: ${categories || 'none reported'}.`
      }

      const rows = page.items.map(
        (i) =>
          `${i.serviceId} — ${i.name} [${i.category}] ${i.method} $${i.pricePerCall.toFixed(5)}/call` +
          (i.description ? `\n    ${i.description}` : ''),
      )
      return (
        `${page.total} match${page.total === 1 ? '' : 'es'}, showing ${page.items.length}:\n\n` +
        rows.join('\n') +
        `\n\nCall get_api_detail with a handle for the full spec, then call_api to invoke it.`
      )
    },
  },

  get_api_detail: {
    cost: 'free',
    schema: {
      type: 'function',
      function: {
        name: 'get_api_detail',
        description:
          'Get the full spec for one catalogue API: price, HTTP method, and the resource id that call_api needs. Free. Do this before invoking, so the call is made against the real spec rather than a guess.',
        parameters: {
          type: 'object',
          properties: {
            ref: {
              type: 'string',
              description:
                "The handle from search_apis — 'federation/456', a bare '456', or a slug.",
            },
          },
          required: ['ref'],
        },
      },
    },
    async run(args, ctx) {
      const ref = String(args['ref'] ?? '')
      if (!ref) return 'No ref given. Pass a handle from search_apis.'

      const detail = await ctx.client.apiDetail(ref)
      if (!detail) {
        return `No catalogue API matches ${ref}. It may have been withdrawn; search again.`
      }
      return [
        `${detail.name} (${detail.serviceId})`,
        `resource_id: ${detail.resourceId}   ← pass this to call_api`,
        `category: ${detail.category}`,
        `method: ${detail.method}`,
        `price: $${detail.pricePerCall.toFixed(5)} per ${detail.priceUnit}`,
        detail.tags ? `tags: ${detail.tags}` : '',
        detail.description ? `\n${detail.description}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    },
  },

  call_api: {
    cost: 'paid',
    schema: {
      type: 'function',
      function: {
        name: 'call_api',
        description:
          'Invoke a catalogue API and get its response. This spends money — the user is asked to confirm the exact price first. Get resource_id from get_api_detail rather than guessing it, since a wrong id charges for the wrong API.',
        parameters: {
          type: 'object',
          properties: {
            resource_id: {
              type: 'integer',
              description: 'The numeric resource id from get_api_detail.',
            },
            payload: {
              type: 'object',
              description:
                'Request body, for endpoints that take one. Omit entirely for GET endpoints that carry no body.',
            },
            method: {
              type: 'string',
              description:
                "HTTP method, when it differs from the endpoint's default of POST. Take it from get_api_detail.",
            },
            endpoint: {
              type: 'string',
              description:
                "Sub-path, for services exposing many endpoints under one base path (e.g. 'exchange/price?pair=BTC-USDT').",
            },
          },
          required: ['resource_id'],
        },
      },
    },
    async run(args, ctx) {
      const resourceId = Number(args['resource_id'])
      if (!Number.isInteger(resourceId) || resourceId <= 0) {
        return 'resource_id must be a positive integer from get_api_detail.'
      }

      // Re-read the price from the catalogue instead of trusting what the model
      // remembered from an earlier turn: the user is about to approve a number, and
      // it has to be the live one.
      const detail = await ctx.client.apiDetail(String(resourceId))
      if (!detail) {
        return `Resource ${resourceId} is not in the catalogue. It may have been withdrawn — search again rather than calling it.`
      }

      // No confirmation here. The spend gate now sits at the payment layer, where it
      // sees EVERY x402 charge rather than only the ones a tool remembered to wrap —
      // which is what let six LLM turns at ~$0.21 past a $0.05 per-call limit.
      //
      // Asking here as well would charge the policy twice for one call (inflating the
      // session total and prompting twice), and would ask about the CATALOGUE price
      // while the gateway quotes its own. The quote is what gets signed, so the quote
      // is what the user must be shown. The name and price read above still matter:
      // they make the price in the prompt a live number and catch a withdrawn
      // resource before any payment is attempted.
      ctx.log(`calling ${detail.name} (about ${detail.pricePerCall.toFixed(5)} USD)…`)
      const result = await ctx.client.callApi({
        resourceId,
        ...(args['payload'] === undefined ? {} : { payload: args['payload'] }),
        ...(typeof args['method'] === 'string'
          ? { method: args['method'] }
          : { method: detail.method }),
        ...(typeof args['endpoint'] === 'string' ? { endpoint: args['endpoint'] } : {}),
      })
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    },
  },

  resolve_intent: {
    // Not free: /v1/intent/resolve answers 402 to a caller with no credential, and
    // it prices on the model in the payload — a paid model there is quoted at that
    // model's price, and naming no model at all lands on the gateway's flat $0.045
    // fallback. With a credential and a free model it costs nothing, which is what
    // this tool sends.
    cost: 'credentialed',
    schema: {
      type: 'function',
      function: {
        name: 'resolve_intent',
        description:
          'Given an intent type, list the providers that can serve it, ranked, with prices — without executing anything. Free with a credential. Call aip_list_intents first if unsure which intent type applies; an unknown one is rejected.',
        parameters: {
          type: 'object',
          properties: {
            intent: {
              type: 'string',
              description:
                "The intent type, e.g. 'chat_completion', 'image_generation', 'web_search'. Required by the gateway — a plain-language description alone is rejected.",
            },
            model: {
              type: 'string',
              description:
                'Optional model to resolve against. Leave it out unless the user named one: the gateway prices this call on the model given, so a paid model here makes the lookup itself cost that model\'s price.',
            },
          },
          required: ['intent'],
        },
      },
    },
    async run(args, ctx) {
      const intent = String(args['intent'] ?? '')
      if (!intent) {
        const types = await ctx.client.intentTypes()
        return `No intent given. The gateway accepts: ${types.join(', ')}.`
      }

      const resolved = await ctx.client.resolveIntent({
        intent,
        ...(typeof args['model'] === 'string' ? { model: args['model'] } : {}),
      })
      if (resolved.matches.length === 0) {
        return (
          `No provider matched (status: ${resolved.status}).` +
          (resolved.message ? ` ${resolved.message}` : '') +
          ' Try search_apis with concrete keywords instead.'
        )
      }
      const rows = resolved.matches.map((m) => {
        const price = m.priceUsd === undefined ? '' : ` $${m.priceUsd.toFixed(5)}`
        return `${m.providerName}${m.model ? ` / ${m.model}` : ''}${price} (score ${m.score.toFixed(2)})`
      })
      return `intent: ${resolved.intent ?? 'unclassified'}\n\n${rows.join('\n')}`
    },
  },

  discover_agents: {
    cost: 'free',
    schema: {
      type: 'function',
      function: {
        name: 'discover_agents',
        description:
          'Find other agents registered on this platform, with their MCP URLs and endpoints, so work can be delegated or chained. Free.',
        parameters: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Match against name and description.' },
            category: { type: 'string', description: "Filter, e.g. 'ai', 'defi', 'data'." },
          },
        },
      },
    },
    async run(args, ctx) {
      const agents = await ctx.client.discoverAgents({
        ...(typeof args['search'] === 'string' ? { search: args['search'] } : {}),
        ...(typeof args['category'] === 'string' ? { category: args['category'] } : {}),
      })
      if (agents.length === 0) return 'No agent matched.'

      return agents
        .map((a) => {
          const price = a.pricePerCall > 0 ? `$${a.pricePerCall.toFixed(5)}/call` : 'free'
          return [
            `${a.name} (${a.agentId})${a.verified ? ' ✓verified' : ''} [${a.category}] ${price}`,
            a.description ? `    ${a.description}` : '',
            a.capabilities.length > 0 ? `    capabilities: ${a.capabilities.join(', ')}` : '',
            a.mcpUrl ? `    mcp: ${a.mcpUrl}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        })
        .join('\n\n')
    },
  },

  check_balance: {
    // /v1/wallet/balance answers 402 to a caller with no credential, so this is
    // free of charge but not reachable anonymously.
    cost: 'credentialed',
    schema: {
      type: 'function',
      function: {
        name: 'check_balance',
        description:
          'Report the spendable balance in USD. Free, but needs a credential. Worth checking before a run of paid calls, so the user is not surprised mid-task.',
        parameters: { type: 'object', properties: {} },
      },
    },
    async run(_args, ctx) {
      const usd = await ctx.client.getBalanceUsd()
      const where = ctx.client.address
        ? `wallet ${ctx.client.address}`
        : 'the account deposit wallet'
      return `$${usd.toFixed(6)} USDC available in ${where}.`
    },
  },
}

/**
 * The tool schemas to hand to the model.
 *
 * Anonymous sessions get only the tools that work without a credential. Offering
 * the rest would send the agent into a 402 it cannot pay and cannot act on, which
 * reads to the user as the tool being broken rather than as needing a login.
 */
export function toolSchemas(opts: { anonymous?: boolean } = {}): ToolSchema[] {
  return Object.values(tools)
    .filter((t) => !opts.anonymous || t.cost === 'free')
    .map((t) => t.schema)
}
