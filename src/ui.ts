/**
 * Terminal output and prompts.
 *
 * Deliberately dependency-free: colours are raw ANSI and prompts use readline. The
 * CLI's whole pitch is `npx ducat` on a fresh machine, so every dependency is
 * install time a beginner waits through before seeing anything.
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

/** Colour is dropped when output is piped, or when NO_COLOR is set. */
const useColor = stdout.isTTY === true && !process.env['NO_COLOR']

const wrap = (code: string) => (text: string) => (useColor ? `[${code}m${text}[0m` : text)

export const style = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
}

export function say(text = ''): void {
  stdout.write(`${text}\n`)
}

export function heading(text: string): void {
  say(`\n${style.bold(text)}`)
}

export function note(text: string): void {
  say(style.dim(text))
}

export function warn(text: string): void {
  say(`${style.yellow('!')} ${text}`)
}

export function fail(text: string): void {
  say(`${style.red('✗')} ${text}`)
}

export function ok(text: string): void {
  say(`${style.green('✓')} ${text}`)
}

/** A spinner that degrades to a single line when stdout is not a TTY. */
export function spinner(label: string): { stop(finalLine?: string): void } {
  if (!stdout.isTTY) {
    say(style.dim(`… ${label}`))
    return { stop: (finalLine?: string) => finalLine && say(finalLine) }
  }

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0
  const timer = setInterval(() => {
    stdout.write(`\r${style.cyan(frames[i % frames.length]!)} ${style.dim(label)}`)
    i++
  }, 80)

  return {
    stop(finalLine?: string) {
      clearInterval(timer)
      // Clear the spinner line before anything else prints over it.
      stdout.write(`\r${' '.repeat(label.length + 4)}\r`)
      if (finalLine) say(finalLine)
    },
  }
}

/**
 * Ask a yes/no question, defaulting to no.
 *
 * No is the default because this gates spending. If stdin is not a TTY there is
 * nobody to ask, so it answers no rather than proceeding unattended — a piped
 * invocation must not spend money it was never told it could.
 */
export async function confirmYesNo(question: string): Promise<boolean> {
  if (!stdin.isTTY) {
    warn('Not an interactive terminal, so this was declined rather than approved silently.')
    return false
  }

  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await rl.question(`${question} ${style.dim('[y/N]')} `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

/** Read a line of input. `secret` suppresses echo, for keys. */
export async function ask(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true })
  try {
    if (!opts.secret) return (await rl.question(question)).trim()

    // readline has no built-in masked input. Muting the output stream keeps the
    // key off the screen and out of the scrollback.
    const asMutable = rl as unknown as {
      _writeToOutput?: ((text: string) => void) | undefined
    }
    const original = asMutable._writeToOutput
    asMutable._writeToOutput = (text: string) => {
      if (text.includes(question)) stdout.write(text)
    }
    try {
      const answer = await rl.question(question)
      stdout.write('\n')
      return answer.trim()
    } finally {
      asMutable._writeToOutput = original
    }
  } finally {
    rl.close()
  }
}

/** A price the user is about to approve. Small amounts get more decimals. */
export function formatUsd(usd: number): string {
  // Zero is only "free" when it is a price. Used for a balance it read
  // "free USDC", which says nothing about having no money.
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(6)}`
  return `$${usd.toFixed(4)}`
}

/**
 * A price, where zero means the call costs nothing.
 *
 * Separate from formatUsd because the two zeroes mean opposite things: a $0 price
 * is good news, a $0 balance is not.
 */
export function formatPrice(usd: number): string {
  return usd === 0 ? 'free' : formatUsd(usd)
}
