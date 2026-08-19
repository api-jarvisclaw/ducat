/**
 * The gateway surface the agent is allowed to reach.
 *
 * Every method here is one live endpoint. Nothing about the catalogue is baked
 * into this file: models, categories, prices and API specs are all read at call
 * time, because a hardcoded list goes stale silently and an agent acting on a
 * stale list fails in a way the user cannot diagnose.
 */
import { BaseClient } from '@jarvisclaw-ai/sdk'

/** One model the gateway currently serves. */
export interface ModelInfo {
  id: string
  ownedBy: string
  /** Zero-cost per the gateway's own pricing, not a guess from a local list. */
  free: boolean
  /**
   * How the model bills. Per-call models (video, image, music) report both token
   * rates as 0, so the two cannot be told apart by looking at the numbers.
   */
  pricing?: 'per-token' | 'per-call'
  /** Only on per-token models; absent rather than 0 when billing is per call. */
  inputPerMTokenUsd?: number
  outputPerMTokenUsd?: number
  /** Only on per-call models: the cost of one call. */
  fixedPriceUsd?: number
}

/** One catalogue API, as the marketplace lists it. */
export interface CatalogueEntry {
  /** Stable handle, e.g. `federation/456`. What `apiDetail` and `callApi` take. */
  serviceId: string
  /** Numeric resource id, needed by the execute endpoint. */
  resourceId: number
  name: string
  category: string
  description: string
  /** USD per call, already including the platform's markup. */
  pricePerCall: number
  priceUnit: string
  /** The HTTP method the upstream endpoint expects. */
  method: string
  slug: string
  tags: string
}

/** A page of catalogue results, plus the live category counts. */
export interface CataloguePage {
  items: CatalogueEntry[]
  total: number
  page: number
  pageSize: number
  categories: Array<{ category: string; count: number }>
}

/** An agent registered on the platform. */
export interface AgentInfo {
  agentId: string
  name: string
  description: string
  category: string
  capabilities: string[]
  pricePerCall: number
  verified: boolean
  mcpUrl?: string
  apiBaseUrl?: string
}

/** A chat message in the OpenAI shape. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

/** A tool the model may call, in the OpenAI function-calling shape. */
export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** What one chat turn came back with. */
export interface ChatTurn {
  content: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  model: string
  usage: Record<string, unknown>
  finishReason: string
}

/**
 * Typed access to the gateway endpoints the CLI uses.
 *
 * Extends the SDK's BaseClient, so the x402 402→pay→retry loop, the retry policy
 * and the error mapping all apply to every call below without repeating them.
 */
export class PlatformClient extends BaseClient {
  // No `create` override: BaseClient.create is typed on its `this`, so
  // `PlatformClient.create(...)` already resolves to a PlatformClient.

  /**
   * Every model the gateway serves right now.
   *
   * `/v1/models` is the OpenAI-compatible list and needs a credential; it answers
   * 401 without one. The public discovery endpoint carries the same model ids plus
   * per-token prices, so it is preferred and the authenticated one is a fallback.
   * Reading prices here also means `free: true` comes from the gateway rather than
   * from a list in this file that would drift.
   */
  async models(): Promise<ModelInfo[]> {
    try {
      const data = await this.get<{ data?: RawDiscoveryModel[] }>('/api/discovery/models')
      const rows = data.data ?? []
      if (rows.length > 0) return rows.map(toModelInfo)
    } catch {
      // Fall through: a self-hosted gateway may not expose discovery.
    }

    const data = await this.get<{ data?: Array<{ id?: string; owned_by?: string }> }>(
      '/v1/models',
    )
    return (data.data ?? []).map((m) => ({
      id: m.id ?? '',
      ownedBy: m.owned_by ?? '',
      free: false,
    }))
  }

  /** The models that currently cost nothing, as the gateway reports them. */
  async freeModels(): Promise<ModelInfo[]> {
    const data = await this.get<{ free?: RawDiscoveryModel[]; cheap?: RawDiscoveryModel[] }>(
      '/api/discovery/free-models',
    )
    // The endpoint returns `free` and `cheap` separately; only genuinely zero-cost
    // rows belong here, or "free" would quote a price to someone who trusted it.
    return (data.free ?? []).map(toModelInfo).filter((m) => m.free)
  }

  /**
   * Search the API catalogue.
   *
   * Free, and unauthenticated on the gateway side — the agent can look before the
   * user has any credential at all.
   */
  async searchApis(
    opts: { query?: string; category?: string; page?: number; pageSize?: number } = {},
  ): Promise<CataloguePage> {
    const data = await this.get<{ data?: RawCataloguePage }>('/api/marketplace/apis', {
      query: {
        // The parameter is `q`. `keyword` is silently ignored, which returns an
        // unfiltered page that looks like a successful but irrelevant search.
        q: opts.query,
        category: opts.category,
        page: opts.page ?? 1,
        page_size: opts.pageSize ?? 20,
      },
    })
    const page = data.data ?? {}
    return {
      items: (page.items ?? []).map(toCatalogueEntry),
      total: page.total ?? 0,
      page: page.page ?? 1,
      pageSize: page.page_size ?? 0,
      categories: page.categories ?? [],
    }
  }

  /** The full spec for one catalogue API, by `federation/456`, `456`, or slug. */
  async apiDetail(ref: string): Promise<CatalogueEntry | undefined> {
    const id = ref.includes('/') ? (ref.split('/').pop() ?? ref) : ref
    const data = await this.get<{ data?: RawCatalogueItem }>(
      `/api/marketplace/apis/${encodeURIComponent(id)}`,
    )
    return data.data ? toCatalogueEntry(data.data) : undefined
  }

  /**
   * Invoke a catalogue API and return its raw upstream response.
   *
   * This is the call that costs money, so it takes the numeric `resourceId` that
   * `apiDetail` returned rather than a name — a name would have to be resolved
   * here, and resolving the wrong one would charge for the wrong API.
   */
  async callApi(args: {
    resourceId: number
    payload?: unknown
    method?: string
    endpoint?: string
    headers?: Record<string, string>
  }): Promise<unknown> {
    return this.post('/v1/network/execute', {
      body: {
        resource_id: args.resourceId,
        ...(args.payload === undefined ? {} : { payload: args.payload }),
        ...(args.method ? { method: args.method } : {}),
        ...(args.endpoint ? { endpoint: args.endpoint } : {}),
        ...(args.headers ? { headers: args.headers } : {}),
      },
    })
  }

  /** The intent types the AIP router currently understands. */
  async intentTypes(): Promise<string[]> {
    const data = await this.get<{ intent_types?: string[] }>('/v1/intent/types')
    return data.intent_types ?? []
  }

  /**
   * List the providers that can serve an intent, ranked, without executing it.
   *
   * `intent` is required by the gateway — sending only a free-text query is a 400,
   * and the x402 middleware runs first, so such a request is answered 402 at the
   * flat fallback price before validation ever reports the missing field.
   *
   * The price of this lookup follows the model in the payload: a free model (or a
   * credential with no model) costs nothing, while naming a paid model quotes that
   * model's own price for the lookup. Nothing is sent unless the caller asked for it.
   */
  async resolveIntent(args: { intent: string; model?: string }): Promise<{
    status: string
    intent?: string
    message?: string
    matches: Array<{ providerName: string; model?: string; priceUsd?: number; score: number }>
  }> {
    const data = await this.post<{
      status?: string
      intent?: string
      message?: string
      matches?: Array<{
        provider_id?: string
        provider_name?: string
        model?: string
        price_usd?: number
        estimated_price_usd?: number
        score?: number
        reason?: string
      }>
    }>('/v1/intent/resolve', {
      body: {
        intent: args.intent,
        ...(args.model ? { payload: { model: args.model } } : {}),
      },
    })

    return {
      status: data.status ?? 'resolved',
      ...(data.intent ? { intent: data.intent } : {}),
      ...(data.message ? { message: data.message } : {}),
      matches: (data.matches ?? []).map((m) => {
        // The live response uses provider_id and estimated_price_usd; the documented
        // shape uses provider_name and price_usd. Both are read rather than assuming
        // one, since a match rendered as an empty name is indistinguishable from no
        // match at all.
        const price = m.price_usd ?? m.estimated_price_usd
        return {
          providerName: m.provider_name ?? m.provider_id ?? '',
          ...(m.model ? { model: m.model } : {}),
          ...(price === undefined ? {} : { priceUsd: price }),
          score: m.score ?? 0,
        }
      }),
    }
  }

  /** Other agents on the platform, for delegation. */
  async discoverAgents(opts: { search?: string; category?: string } = {}): Promise<AgentInfo[]> {
    const data = await this.get<{ data?: RawAgent[] }>('/api/agents', {
      query: { search: opts.search, category: opts.category, page_size: 20 },
    })
    return (data.data ?? []).map((a) => ({
      agentId: a.agent_id ?? '',
      name: a.name ?? '',
      description: a.description ?? '',
      category: a.category ?? '',
      // Stored as a JSON string in the registry, not an array — parsed here so the
      // agent sees capabilities rather than a quoted blob.
      capabilities: parseStringList(a.capabilities),
      pricePerCall: a.price_per_call ?? 0,
      verified: a.verified === true,
      ...(a.mcp_url ? { mcpUrl: a.mcp_url } : {}),
      ...(a.api_base_url ? { apiBaseUrl: a.api_base_url } : {}),
    }))
  }

  /** One chat completion, with optional tool definitions for function calling. */
  async chat(args: {
    model: string
    messages: ChatMessage[]
    tools?: ToolSchema[]
    temperature?: number
    maxTokens?: number
  }): Promise<ChatTurn> {
    const data = await this.post<RawChatResponse>('/v1/chat/completions', {
      body: {
        model: args.model,
        messages: args.messages,
        ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
        ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
        ...(args.maxTokens === undefined ? {} : { max_tokens: args.maxTokens }),
      },
    })

    const choice = data.choices?.[0]
    return {
      content: choice?.message?.content ?? '',
      toolCalls: (choice?.message?.tool_calls ?? []).map((tc) => ({
        id: tc.id ?? '',
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '{}',
      })),
      model: data.model ?? args.model,
      usage: data.usage ?? {},
      finishReason: choice?.finish_reason ?? '',
    }
  }
}

// ─── Wire shapes ─────────────────────────────────────────────────────────────

interface RawCatalogueItem {
  service_id?: string
  resource_id?: number
  name?: string
  category?: string
  description?: string
  display_price?: number
  price_unit?: string
  method?: string
  slug?: string
  tags?: string
}

interface RawCataloguePage {
  items?: RawCatalogueItem[]
  total?: number
  page?: number
  page_size?: number
  categories?: Array<{ category: string; count: number }>
}

interface RawAgent {
  agent_id?: string
  name?: string
  description?: string
  category?: string
  capabilities?: string
  price_per_call?: number
  verified?: boolean
  mcp_url?: string
  api_base_url?: string
}

/**
 * Parse a JSON-encoded string list, tolerating a plain comma-separated one.
 *
 * The registry stores `capabilities` as a JSON string. A malformed value yields an
 * empty list rather than throwing: a bad row in someone else's registration should
 * not break the whole listing.
 */
function parseStringList(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return []
}

interface RawDiscoveryModel {
  model?: string
  input_per_m_token_usd?: number
  output_per_m_token_usd?: number
  /** `per-token` or `per-call`. Absent on older gateways; treated as per-token. */
  pricing_type?: string
  /** Set on per-call models. The token rates are 0 for these, which is not a price. */
  fixed_price_usd?: number
  free?: boolean
}

function toModelInfo(raw: RawDiscoveryModel): ModelInfo {
  // Video, image and music models are priced per call, and report both token rates
  // as 0. Reading those as a price displayed "$0/M in · $0/M out" for a model that
  // costs $1.575 a call — understating a real charge as free, which is the worst
  // direction for this to be wrong in. The token rates are only meaningful when the
  // gateway says the model is priced per token.
  const perCall = raw.pricing_type === 'per-call'

  return {
    id: raw.model ?? '',
    // The discovery endpoint reports pricing rather than an owner; the id already
    // carries the vendor prefix (`openai/gpt-5`), so nothing is lost.
    ownedBy: (raw.model ?? '').includes('/') ? (raw.model ?? '').split('/')[0]! : '',
    free: raw.free === true,
    ...(perCall || raw.input_per_m_token_usd === undefined
      ? {}
      : { inputPerMTokenUsd: raw.input_per_m_token_usd }),
    ...(perCall || raw.output_per_m_token_usd === undefined
      ? {}
      : { outputPerMTokenUsd: raw.output_per_m_token_usd }),
    ...(raw.fixed_price_usd === undefined ? {} : { fixedPriceUsd: raw.fixed_price_usd }),
    ...(perCall ? { pricing: 'per-call' as const } : { pricing: 'per-token' as const }),
  }
}

interface RawChatResponse {
  model?: string
  usage?: Record<string, unknown>
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string
      tool_calls?: Array<{
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
}

function toCatalogueEntry(raw: RawCatalogueItem): CatalogueEntry {
  return {
    serviceId: raw.service_id ?? '',
    resourceId: raw.resource_id ?? 0,
    name: raw.name ?? '',
    category: raw.category ?? '',
    description: raw.description ?? '',
    pricePerCall: raw.display_price ?? 0,
    priceUnit: raw.price_unit ?? 'call',
    method: raw.method ?? 'POST',
    slug: raw.slug ?? '',
    tags: raw.tags ?? '',
  }
}
