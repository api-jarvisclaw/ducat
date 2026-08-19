/**
 * The agent loop: ask the model, run the tools it asks for, feed results back.
 *
 * Bounded on purpose. An unbounded loop with paid tools in it can spend money in a
 * cycle the user never sees, so there is a hard cap on rounds and a per-session
 * spend ceiling that stops the loop rather than warning about it.
 */
import { APIError, InsufficientBalanceError } from '@jarvisclaw/sdk'
import type { ChatMessage, PlatformClient } from '../platform/client.js'
import { toolSchemas, tools, type ConfirmFn } from './tools.js'

/** How many model→tool→model rounds one request may take. */
export const DEFAULT_MAX_ROUNDS = 8

/**
 * Output budget per turn.
 *
 * Set because leaving it unset broke the free tier in practice: several free models
 * are reasoning models that think in the content field before emitting a tool call,
 * and against the provider's small default they spent the entire budget reasoning
 * and returned `finish_reason: length` with no tool call at all — the agent
 * described the API it should call instead of calling it. Generous enough for a
 * reasoning preamble plus the call.
 */
export const DEFAULT_MAX_TOKENS = 4096

export interface RunnerOptions {
  client: PlatformClient
  model: string
  confirm: ConfirmFn
  log: (line: string) => void
  maxRounds?: number
  /** Extra context appended to the system prompt, e.g. what mode we are in. */
  systemSuffix?: string
  /**
   * No credential: offer only the tools that work without one, and tell the model
   * why the others are missing so it can say so rather than guess.
   */
  anonymous?: boolean
  /** Output budget per turn. Defaults to DEFAULT_MAX_TOKENS. */
  maxTokens?: number
}

export interface RunResult {
  /** The assistant's final answer. */
  answer: string
  /** Every tool that ran, in order. */
  toolsUsed: string[]
  rounds: number
  /** True when the round cap stopped the loop before the model was finished. */
  hitRoundLimit: boolean
  /** True when the model hit its output budget instead of finishing. */
  truncated: boolean
}

/**
 * The system prompt.
 *
 * Written to counter the two failure modes that make an agent useless to a
 * beginner: explaining an API instead of calling it, and inventing a resource id
 * or price rather than looking one up.
 */
function systemPrompt(suffix?: string): string {
  return [
    'You are jarvisclaw, a terminal agent for the JarvisClaw gateway. You do not just',
    'describe how to use the platform — you call it. When a request can be answered by',
    'invoking something, invoke it and report the result.',
    '',
    'How to work:',
    '- Never invent a model id, resource id, price or API name. Look them up with',
    '  list_models, search_apis and get_api_detail. These are free, so there is no',
    '  reason to guess.',
    '- Before invoking a paid API, call get_api_detail so the user is shown the real',
    '  price. The user is asked to approve every paid call; if they decline, say so',
    '  plainly and suggest a free alternative if one exists.',
    '- Many users here are new to this. Explain what you are about to do in one short',
    '  sentence before doing it, and say what it cost afterwards. No jargon they did',
    '  not use first.',
    '- If a call fails, report what the gateway actually said. Do not retry the same',
    '  call unchanged, and do not fabricate a plausible-looking result.',
    suffix ? `\n${suffix}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Run one user request to completion. */
export async function run(prompt: string, opts: RunnerOptions): Promise<RunResult> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS
  const schemas = toolSchemas(opts.anonymous ? { anonymous: true } : {})
  const suffix = [
    opts.systemSuffix,
    opts.anonymous
      ? 'This session has no credential, so only the free tools are available. ' +
        'Paid APIs, intent resolution and balance lookups need one — if the user ' +
        'asks for those, say `jarvisclaw login` is needed rather than guessing at ' +
        'an answer.'
      : undefined,
  ]
    .filter(Boolean)
    .join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(suffix || undefined) },
    { role: 'user', content: prompt },
  ]

  const toolsUsed: string[] = []
  const ctx = { client: opts.client, confirm: opts.confirm, log: opts.log }

  for (let round = 1; round <= maxRounds; round++) {
    const turn = await opts.client.chat({
      model: opts.model,
      messages,
      tools: schemas,
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    })

    // A reasoning model that runs out of budget mid-thought returns prose and no
    // tool call, so the task silently becomes a description of what should have
    // happened. Saying so beats presenting that as the answer.
    if (turn.finishReason === 'length' && turn.toolCalls.length === 0) {
      return {
        answer:
          turn.content.trim() ||
          'The model stopped before answering — it used its whole output budget.',
        toolsUsed,
        rounds: round,
        hitRoundLimit: false,
        truncated: true,
      }
    }

    if (turn.toolCalls.length === 0) {
      return {
        answer: turn.content,
        toolsUsed,
        rounds: round,
        hitRoundLimit: false,
        truncated: false,
      }
    }

    // The assistant turn must be recorded with its tool_calls before the results,
    // or the next request has tool replies answering nothing and the model errors.
    messages.push({
      role: 'assistant',
      content: turn.content,
      tool_calls: turn.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    })

    for (const call of turn.toolCalls) {
      toolsUsed.push(call.name)
      const output = await runOneTool(call, ctx)
      messages.push({ role: 'tool', tool_call_id: call.id, content: output })
    }
  }

  // Out of rounds with tools still pending. Ask once more with tools withheld, so
  // the user gets an answer built from the work already done instead of nothing.
  const final = await opts.client.chat({
    model: opts.model,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [
      ...messages,
      {
        role: 'user',
        content:
          'Stop calling tools and answer now with what you have. Say plainly if the ' +
          'task is unfinished and what remains.',
      },
    ],
  })
  return {
    answer: final.content,
    toolsUsed,
    rounds: maxRounds,
    hitRoundLimit: true,
    truncated: final.finishReason === 'length',
  }
}

/**
 * Run one tool call and turn any failure into text the model can act on.
 *
 * Errors are returned rather than thrown: a failed tool is information the model
 * should route around, while throwing would abort a session that is often still
 * recoverable. Genuinely terminal conditions are re-thrown.
 */
async function runOneTool(
  call: { name: string; arguments: string },
  ctx: { client: PlatformClient; confirm: ConfirmFn; log: (line: string) => void },
): Promise<string> {
  const tool = tools[call.name]
  if (!tool) {
    return `No such tool: ${call.name}. Available: ${Object.keys(tools).join(', ')}.`
  }

  let args: Record<string, unknown>
  try {
    args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {}
  } catch (err) {
    return `Your arguments for ${call.name} were not valid JSON (${String(err)}). Send them again.`
  }

  try {
    return await tool.run(args, ctx)
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      // A 402 from a tool the user was never asked to pay for is not the same
      // condition as running out of funds mid-purchase. Several endpoints answer 402
      // to a caller whose credential they do not accept, so aborting here killed the
      // whole session — and told the user to "switch to a free model" when they were
      // already on one. Report it to the model instead and let it route around.
      //
      // Keyed on "not paid" rather than "is free": a credentialed tool takes this
      // path too, and that is exactly the case that was breaking sessions.
      if (tool.cost !== 'paid') {
        return (
          `${call.name} is unavailable without a credential: the gateway wants ` +
          `payment for it (${err.message}). Do not retry it. Use a different tool, ` +
          `and tell the user this one needs \`jarvisclaw login\`.`
        )
      }
      // On a genuinely paid tool the user did approve a charge, so being out of
      // funds is terminal: every further attempt fails identically.
      throw err
    }
    if (err instanceof APIError) {
      return `${call.name} failed: ${err.message} (HTTP ${err.statusCode}). Do not retry this unchanged.`
    }
    return `${call.name} failed: ${String(err)}. Do not retry this unchanged.`
  }
}
