/**
 * `jarvisclaw "<task>"` and the interactive session — the CLI's main path.
 */
import { InsufficientBalanceError, JarvisClawError, PaymentDeclinedError, type PaymentApprover } from '@jarvisclaw-ai/sdk'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { run } from '../agent/runner.js'
import type { ConfirmFn } from '../agent/tools.js'
import { buildRunClient } from '../platform/factory.js'
import type { ResolvedConfig } from '../config.js'
import { SpendPolicy } from '../spend.js'
import { DEFAULT_MODEL } from '../config.js'
import { confirmYesNo, formatPrice, formatUsd, note, say, spinner, style, warn } from '../ui.js'

/** Build the session's spend policy from resolved config. */
function policyFor(config: ResolvedConfig): SpendPolicy {
  return new SpendPolicy({
    ...(config.maxCallUsd === undefined ? {} : { confirmAboveUsd: config.maxCallUsd }),
    ...(config.maxSpendUsd === undefined ? {} : { sessionLimitUsd: config.maxSpendUsd }),
  })
}

/**
 * Decides each paid call, prompting only when a ceiling says to.
 *
 * Small calls go through silently but are always reported, so the user sees what
 * was spent without being asked six times about fractions of a cent.
 */
/**
 * Describe a charge the user did not explicitly ask for, from its URL.
 *
 * The gateway's own description is used when it sends one; this is the fallback, and
 * it exists because "payment for /v1/chat/completions" means nothing to a beginner.
 */
function describeCharge(resourceUrl: string, description?: string): string {
  if (description) return description
  const path = (() => {
    try {
      return new URL(resourceUrl).pathname
    } catch {
      return resourceUrl
    }
  })()
  if (path.includes('/chat/completions')) return 'a reasoning step (the agent thinking)'
  if (path.includes('/embeddings')) return 'a catalogue lookup'
  if (path.includes('/network/execute') || path.includes('/federation')) return 'an API call'
  return path
}

/**
 * The approval hook the SDK consults before signing ANY x402 payment.
 *
 * This is what makes the limits mean what they say. `SpendPolicy` was only ever
 * consulted by the `call_api` tool, so it governed paid catalogue APIs and nothing
 * else — and the agent's own reasoning turns, the most expensive part of a run, were
 * outside it. A real run held `--max-call 0.05` and `--max-spend 1` and still spent
 * $1.47, because six LLM turns quoted at ~$0.21 each never reached this policy.
 *
 * Wired at the payment layer rather than at each call site on purpose: a gate that
 * has to be remembered at every call site is a gate that will be forgotten at the
 * next one.
 *
 * The quoted amount is the amount charged — x402 prepays a fixed authorisation and
 * never settles down to actual usage — so gating on the quote is gating on the money.
 */
function makeApprover(
  policy: SpendPolicy,
  log: (line: string) => void,
): PaymentApprover {
  return async (req) => {
    const verdict = policy.evaluate(req.amountUsd)
    const what = describeCharge(req.resourceUrl, req.description)

    if (verdict.decision === 'deny') {
      say()
      say(`${style.yellow('!')} Declined ${formatPrice(req.amountUsd)} for ${what}`)
      note(`  ${verdict.reason}`)
      return { approved: false, reason: verdict.reason }
    }

    if (verdict.decision === 'allow') {
      policy.record(req.amountUsd)
      log(`paying ${formatPrice(req.amountUsd)} — ${what}`)
      return true
    }

    say()
    say(`${style.yellow('$')} ${what}`)
    say(`  ${style.dim('cost')} ${formatPrice(req.amountUsd)}`)
    note(`  ${verdict.reason}`)
    const approved = await confirmYesNo('  Pay it?')
    if (approved) policy.record(req.amountUsd)
    return approved ? true : { approved: false, reason: 'you declined it' }
  }
}

function makeConfirm(policy: SpendPolicy): { confirm: ConfirmFn; spentUsd: () => number } {
  const confirm: ConfirmFn = async ({ summary, priceUsd }) => {
    const verdict = policy.evaluate(priceUsd)

    if (verdict.decision === 'deny') {
      say()
      say(`${style.yellow('!')} Skipped ${summary}`)
      note(`  ${verdict.reason}`)
      return false
    }

    if (verdict.decision === 'allow') {
      // Not silent: spending money with no trace is worse than a prompt. Just not
      // a question.
      note(`  paying ${formatPrice(priceUsd ?? 0)} — ${summary}`)
      if (priceUsd !== undefined) policy.record(priceUsd)
      return true
    }

    say()
    say(`${style.yellow('$')} ${summary}`)
    say(`  ${style.dim('cost')} ${priceUsd === undefined ? 'unknown' : formatPrice(priceUsd)}`)
    note(`  ${verdict.reason}`)
    const approved = await confirmYesNo('  Run it?')
    if (approved && priceUsd !== undefined) policy.record(priceUsd)
    return approved
  }
  return { confirm, spentUsd: () => policy.spentUsd() }
}

/** Run one task and exit. */
export async function runOnce(prompt: string, config: ResolvedConfig): Promise<number> {
  const policy = policyFor(config)
  const { confirm, spentUsd } = makeConfirm(policy)

  const spin = spinner('thinking')
  let stopped = false
  const log = (line: string) => {
    if (!stopped) {
      spin.stop()
      stopped = true
    }
    note(`  ${line}`)
  }

  // The approver is built before the client, because the client needs it: the gate
  // lives on the payment path, so it has to exist by the time the first charge is
  // quoted.
  const { client, model, anonymous, downgraded } = await buildRunClient(config, {
    approvePayment: makeApprover(policy, log),
  })
  if (anonymous) announceAnonymous(config.model, model, downgraded)

  try {
    const result = await run(prompt, { client, model, confirm, log, ...(anonymous ? { anonymous: true } : {}) })
    if (!stopped) spin.stop()

    say()
    say(result.answer)

    if (result.toolsUsed.length > 0) {
      say()
      note(`used: ${result.toolsUsed.join(' → ')}`)
    }
    if (spentUsd() > 0) note(`spent: ${formatUsd(spentUsd())}`)
    if (result.truncated) {
      warn("The model ran out of output budget, so the answer above may be cut short.")
    }
    if (result.stoppedBySpendLimit) {
      // Said explicitly rather than folded into the round-limit warning: this stop was
      // the user's own ceiling doing its job, and the fix is a different one.
      warn('A spend ceiling stopped this run before it finished.')
    } else if (result.hitRoundLimit) {
      warn(`Stopped after ${result.rounds} rounds. The answer above may be incomplete.`)
    }
    return 0
  } catch (err) {
    if (!stopped) spin.stop()
    return reportError(err, { anonymous })
  }
}

/** Interactive session. Context carries across turns; spending does not reset. */
export async function runInteractive(config: ResolvedConfig): Promise<number> {
  const policy = policyFor(config)
  const { confirm, spentUsd } = makeConfirm(policy)
  const { client, model, anonymous, downgraded } = await buildRunClient(config, {
    approvePayment: makeApprover(policy, (line) => note(`  ${line}`)),
  })

  say(`${style.bold('jarvisclaw')} ${style.dim(`· ${model} · ${config.baseUrl}`)}`)
  if (anonymous) {
    announceAnonymous(config.model, model, downgraded)
  } else {
    note(client.address ? `wallet ${client.address}` : 'api key mode')
  }
  note(
    `paid calls under ${formatUsd(policy.confirmAboveUsd)} run without asking; ` +
      `session limit ${formatUsd(policy.sessionLimitUsd)}`,
  )
  note("Ask for something, or type 'exit'.")
  say()

  const rl = createInterface({ input: stdin, output: stdout })
  let exitCode = 0

  try {
    for (;;) {
      const prompt = (await rl.question(`${style.cyan('›')} `)).trim()
      if (!prompt) continue
      if (prompt === 'exit' || prompt === 'quit') break

      // The readline interface has to be released while the agent runs, or its
      // confirmation prompts compete with this one for stdin and neither reads.
      rl.pause()
      const spin = spinner('thinking')
      let stopped = false
      const log = (line: string) => {
        if (!stopped) {
          spin.stop()
          stopped = true
        }
        note(`  ${line}`)
      }

      try {
        const result = await run(prompt, { client, model, confirm, log, ...(anonymous ? { anonymous: true } : {}) })
        if (!stopped) spin.stop()
        say()
        say(result.answer)
        if (result.toolsUsed.length > 0) note(`\nused: ${result.toolsUsed.join(' → ')}`)
        say()
      } catch (err) {
        if (!stopped) spin.stop()
        exitCode = reportError(err, { anonymous })
        // Out of funds ends the session; anything else is worth another turn.
        if (err instanceof InsufficientBalanceError) break
      } finally {
        rl.resume()
      }
    }
  } finally {
    rl.close()
  }

  if (spentUsd() > 0) note(`session total: ${formatUsd(spentUsd())}`)
  return exitCode
}

/**
 * Say that this run has no credential, and what that means.
 *
 * Stated rather than left implicit: the user should know why paid APIs will be
 * refused, and that the model was switched if they had asked for another one.
 */
/**
 * Say what is running and, if it is not what was asked for, why.
 *
 * `downgraded` comes from the factory rather than being recomputed from the two
 * names, because the default model is now `auto` — so a name mismatch no longer
 * means the user asked for anything. Warning "auto needs payment" at someone who
 * never typed `auto` would be blaming them for a default.
 */
function announceAnonymous(requestedModel: string, actualModel: string, downgraded: boolean): void {
  note(`no credential — running free on ${actualModel}`)
  if (downgraded && requestedModel !== DEFAULT_MODEL) {
    warn(`${requestedModel} needs payment, so ${actualModel} is used instead.`)
    note('Run `jarvisclaw setup` to use paid models and APIs.')
  }
}

/**
 * Turn an error into something a beginner can act on.
 *
 * The gateway's own message is always shown — a rewritten one hides the real cause —
 * with a line added about what to do next.
 */
function reportError(err: unknown, ctx: { anonymous: boolean } = { anonymous: false }): number {
  const fail = (t: string) => say(`${style.red('✗')} ${t}`)

  if (err instanceof InsufficientBalanceError) {
    fail(err.message)
    // The advice has to match the situation. Telling someone already on auto/free
    // to "switch to a free model" is the kind of dead end that makes a tool look
    // broken — and with no credential there is no wallet to top up either.
    note(
      ctx.anonymous
        ? 'That needs a credential. Run `jarvisclaw setup` — free models work without one.'
        : 'Top up the wallet, or switch to a free model with --model auto/free.',
    )
    return 2
  }
  if (err instanceof JarvisClawError) {
    fail(err.message)
    return 1
  }
  fail(String(err))
  return 1
}
