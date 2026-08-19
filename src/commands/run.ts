/**
 * `jarvisclaw "<task>"` and the interactive session — the CLI's main path.
 */
import { InsufficientBalanceError, JarvisClawError } from '@jarvisclaw/sdk'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { run } from '../agent/runner.js'
import type { ConfirmFn } from '../agent/tools.js'
import { buildRunClient } from '../platform/factory.js'
import type { ResolvedConfig } from '../config.js'
import { confirmYesNo, formatUsd, note, say, spinner, style, warn } from '../ui.js'

/** Prompts before each paid call, and keeps a running total of what was spent. */
function makeConfirm(): { confirm: ConfirmFn; spentUsd: () => number } {
  let spent = 0
  const confirm: ConfirmFn = async ({ summary, priceUsd }) => {
    const price = priceUsd === undefined ? 'an unstated price' : formatUsd(priceUsd)
    say()
    say(`${style.yellow('$')} ${summary}`)
    say(`  ${style.dim('cost')} ${price}`)
    const approved = await confirmYesNo('  Run it?')
    if (approved && priceUsd !== undefined) spent += priceUsd
    return approved
  }
  return { confirm, spentUsd: () => spent }
}

/** Run one task and exit. */
export async function runOnce(prompt: string, config: ResolvedConfig): Promise<number> {
  const { client, model, anonymous } = await buildRunClient(config)
  if (anonymous) announceAnonymous(config.model, model)
  const { confirm, spentUsd } = makeConfirm()

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

    if (result.toolsUsed.length > 0) {
      say()
      note(`used: ${result.toolsUsed.join(' → ')}`)
    }
    if (spentUsd() > 0) note(`spent: ${formatUsd(spentUsd())}`)
    if (result.truncated) {
      warn("The model ran out of output budget, so the answer above may be cut short.")
    }
    if (result.hitRoundLimit) {
      warn(`Stopped after  rounds. The answer above may be incomplete.`)
    }
    return 0
  } catch (err) {
    if (!stopped) spin.stop()
    return reportError(err, { anonymous })
  }
}

/** Interactive session. Context carries across turns; spending does not reset. */
export async function runInteractive(config: ResolvedConfig): Promise<number> {
  const { client, model, anonymous } = await buildRunClient(config)
  const { confirm, spentUsd } = makeConfirm()

  say(`${style.bold('jarvisclaw')} ${style.dim(`· ${model} · ${config.baseUrl}`)}`)
  if (anonymous) {
    announceAnonymous(config.model, model)
  } else {
    note(client.address ? `wallet ${client.address}` : 'api key mode')
  }
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
function announceAnonymous(requestedModel: string, actualModel: string): void {
  note(`no credential — running free on ${actualModel}`)
  if (requestedModel !== actualModel) {
    warn(`${requestedModel} needs payment, so ${actualModel} is used instead.`)
    note('Run `jarvisclaw login` to use paid models and APIs.')
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
        ? 'That needs a credential. Run `jarvisclaw login` — free models work without one.'
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
