/**
 * The agent loop: ask the model, run the tools it asks for, feed results back.
 *
 * Bounded on purpose. An unbounded loop with paid tools in it can spend money in a
 * cycle the user never sees, so there is a hard cap on rounds and a per-session
 * spend ceiling that stops the loop rather than warning about it.
 */
import { APIError, InsufficientBalanceError, PaymentDeclinedError } from '@jarvisclaw-ai/sdk'
import type { ChatMessage, PlatformClient } from '../platform/client.js'
import { toolSchemas, tools, type ConfirmFn } from './tools.js'

/** How many model→tool→model rounds one request may take. */
export const DEFAULT_MAX_ROUNDS = 8

/**
 * Output budget per turn.
 *
 * Set at all because leaving it unset broke the free tier in practice: several free
 * models are reasoning models that think in the content field before emitting a tool
 * call, and against the provider's small default they spent the entire budget
 * reasoning and returned `finish_reason: length` with no tool call at all — the agent
 * described the API it should call instead of calling it.
 *
 * Set to 1536 rather than 4096 because on a paid model this number IS the price.
 * x402 prepays, so the gateway must quote the worst case: cost is
 * (input_tokens × input_price + max_tokens × output_price), and EIP-3009 authorizes
 * an exact value that cannot be reduced afterwards. Asking for 4096 and using 500
 * pays for 4096. That is not a gateway bug — a prepaid protocol has nothing else to
 * quote — but it made one agent turn cost $0.553 and a four-round task $2.2, for a
 * few cents of actual work.
 *
 * 1536 comes from measured output, not from taste. Over 7 days of production logs the
 * busiest free model averaged 466 completion tokens with a p95 of 968 and a maximum
 * of 1818; the paid models in the same window ran lower. 1536 clears p95 with room
 * for a reasoning preamble while cutting the quote to $0.207 — and the round-limit
 * path already asks for a final answer with tools withheld, so a turn that does hit
 * the ceiling degrades to a shorter reply rather than to nothing.
 */
export const DEFAULT_MAX_TOKENS = 1536

/**
 * Output budget for a turn whose job is to pick a tool, on a PAID model.
 *
 * Reserving the full DEFAULT_MAX_TOKENS for every turn is what made a single question
 * cost $1.47. Measured against the gateway: at max_tokens=1536 one turn on
 * google/gemini-3.5-flash is quoted $0.2074, and six turns come to $1.24 — 83% of the
 * bill is this reservation, not the growing context (~$0.017 across the same six).
 *
 * The reservation was 91% waste. In that same run the turns actually produced 26, 37,
 * 120, 134, 229 and 257 completion tokens — mean 134 against 1536 reserved. A turn
 * that emits a tool call does not need room for prose; it needs room for a short
 * preamble and a JSON function call.
 *
 * 640 rather than 256: the reasoning models that DEFAULT_MAX_TOKENS was raised for
 * think in the content field before emitting the call, and cutting to the observed
 * mean would truncate exactly those. 640 clears the largest observed tool turn (257)
 * with 2.5x headroom, and a turn that still hits the ceiling is handled — the loop
 * reports finish_reason: length rather than presenting prose as an answer.
 *
 * Applies ONLY when the turn is being paid for per token. On a free model the budget
 * costs nothing, so the generous value stays where it was measured to be needed. See
 * budgetFor.
 */
export const TOOL_TURN_MAX_TOKENS = 640

/**
 * The output budget for one turn.
 *
 * `final` is the answer the user reads, and gets the full budget: a truncated answer
 * is the failure this budget exists to prevent. A tool-selection turn gets the
 * smaller one, but only when it is paid per token — the trimming exists to stop
 * paying for 1536 tokens to receive 134, and on a free model there is nothing to
 * save and a reasoning preamble to protect.
 */
function budgetFor(
  kind: 'tool' | 'final',
  opts: { maxTokens?: number; anonymous?: boolean },
): number {
  // An explicit budget is the caller's decision and is never second-guessed.
  if (opts.maxTokens !== undefined) return opts.maxTokens
  if (kind === 'final') return DEFAULT_MAX_TOKENS
  // Anonymous means the free tier, where max_tokens is not the price.
  if (opts.anonymous) return DEFAULT_MAX_TOKENS
  return TOOL_TURN_MAX_TOKENS
}

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
  /**
   * True when a spend ceiling (or the user) declined a charge and ended the run.
   *
   * Reported separately from the other stop reasons because it is the only one the
   * user chose: the answer is incomplete on purpose, and telling them to raise the
   * limit is useful where "the model ran out of budget" would be misleading.
   */
  stoppedBySpendLimit?: boolean
}

/**
 * What to say when a spend ceiling stopped the run.
 *
 * Names the work already done, because it was paid for: a bare "declined" hides the
 * fact that the earlier rounds produced something.
 */
function buildDeclinedAnswer(toolsUsed: string[], detail: string): string {
  const done =
    toolsUsed.length > 0
      ? ` Work completed before stopping: ${toolsUsed.join(', ')}.`
      : ''
  return (
    `Stopped without finishing: the next step was declined (${detail}).${done} ` +
    `Raise the ceiling with --max-spend or --max-call to continue.`
  )
}

/**
 * The system prompt.
 *
 * Written to counter the failure modes that make an agent useless to a beginner:
 * explaining an API instead of calling it, inventing a resource id or price rather
 * than looking one up, and — the one that cost a whole live run — asking for
 * permission in prose.
 *
 * The consent paragraph is the load-bearing part. It used to read "The user is
 * asked to approve every paid call", describing what the CLI does. The model read
 * that as its own job: it would run search_apis and get_api_detail, then write
 * "shall I proceed?" and stop. The turn was over, so the user only saw that
 * question afterwards and had nothing to answer it with — the task never ran and
 * the payment path was never reached.
 *
 * Measured on the same free model with stubbed tool results, 7 tools, one prompt:
 * the old wording reached call_api in 2 of 6 runs, the wording below in 6 of 6.
 * The point is not politeness — a question the model asks itself is a dead end,
 * and it has to be told so explicitly.
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
    '- Before invoking a paid API, call get_api_detail so the price is known. Then',
    '  CALL IT. Do not ask for permission in your reply: the CLI asks the user for',
    '  you, and it cannot ask until you make the call. A question in your text ends',
    '  the turn, so the user reads it with no way to answer and nothing runs. If they',
    '  decline, the tool result will tell you so and you can say it plainly.',
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
        'asks for those, say `jarvisclaw setup` is needed rather than guessing at ' +
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
    let turn
    try {
      turn = await opts.client.chat({
        model: opts.model,
        messages,
        tools: schemas,
        // A turn offered tools is a tool-selection turn: it may answer directly, but
        // it does not need room for a full reply to do so, and this is the turn that
        // repeats. The wrap-up call below keeps the full budget.
        maxTokens: budgetFor('tool', opts),
      })
    } catch (err) {
      // The reasoning turn itself now passes the spend gate, so it can be declined —
      // by the session limit or by the user. That is a stop, not a crash: report what
      // the work already produced instead of throwing away the rounds paid for.
      if (err instanceof PaymentDeclinedError) {
        return {
          answer: buildDeclinedAnswer(toolsUsed, err.message),
          toolsUsed,
          rounds: round,
          hitRoundLimit: false,
          truncated: false,
          stoppedBySpendLimit: true,
        }
      }
      throw err
    }

    // A reasoning model that runs out of budget mid-thought returns prose and no
    // tool call, so the task silently becomes a description of what should have
    // happened. Saying so beats presenting that as the answer.
    if (turn.finishReason === 'length' && turn.toolCalls.length === 0) {
      // The tool-turn budget is deliberately small, and a turn that chose to ANSWER
      // rather than call a tool can legitimately need more room than it was given.
      // Retry once at the full budget before giving up: without this, trimming the
      // reserve would have bought a cheaper run by truncating real answers, which is
      // not a saving — it is the same failure the budget exists to prevent.
      const toolBudget = budgetFor('tool', opts)
      const fullBudget = budgetFor('final', opts)
      if (fullBudget > toolBudget) {
        try {
          const retry = await opts.client.chat({
            model: opts.model,
            messages,
            maxTokens: fullBudget,
          })
          return {
            answer:
              retry.content.trim() ||
              'The model stopped before answering — it used its whole output budget.',
            toolsUsed,
            rounds: round,
            hitRoundLimit: false,
            truncated: retry.finishReason === 'length',
          }
        } catch (err) {
          if (!(err instanceof PaymentDeclinedError)) throw err
          return {
            answer: buildDeclinedAnswer(toolsUsed, err.message),
            toolsUsed,
            rounds: round,
            hitRoundLimit: false,
            truncated: false,
            stoppedBySpendLimit: true,
          }
        }
      }
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
  let final
  try {
    final = await opts.client.chat({
      model: opts.model,
      // Full budget: this is the answer the user reads.
      maxTokens: budgetFor('final', opts),
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
  } catch (err) {
    // This wrap-up turn costs money too, so the ceiling can land exactly here — the
    // worst place to throw, since every round has already been paid for.
    if (err instanceof PaymentDeclinedError) {
      return {
        answer: buildDeclinedAnswer(toolsUsed, err.message),
        toolsUsed,
        rounds: maxRounds,
        hitRoundLimit: true,
        truncated: false,
        stoppedBySpendLimit: true,
      }
    }
    throw err
  }
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
          `and tell the user this one needs \`jarvisclaw setup\`.`
        )
      }
      // On a genuinely paid tool the user did approve a charge, so being out of
      // funds is terminal: every further attempt fails identically.
      throw err
    }
    // A declined charge is a decision, not a fault. The spend gate lives at the
    // payment layer now, so a refusal arrives here as a thrown error rather than as
    // a false return from the tool's own confirm — and it must not end the session:
    // the model can still answer from what it has, or say plainly that the user
    // declined. Rethrowing would abort a run the user only meant to keep cheap.
    if (err instanceof PaymentDeclinedError) {
      return (
        `${call.name} was not run: the charge was declined (${err.message}). ` +
        `Do not retry it. Tell the user plainly, and answer with what you already ` +
        `have if you can.`
      )
    }
    if (err instanceof APIError) {
      return `${call.name} failed: ${err.message} (HTTP ${err.statusCode}). Do not retry this unchanged.`
    }
    return `${call.name} failed: ${String(err)}. Do not retry this unchanged.`
  }
}
