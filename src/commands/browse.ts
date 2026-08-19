/**
 * The read-only commands: search, models, agents, balance, config.
 *
 * These exist so someone can see what the platform holds before committing a
 * credential or spending anything. `search` and `models` need no login at all.
 */
import { JarvisClawError } from '@jarvisclaw-ai/sdk'
import { configPath, maskSecret, readConfig, writeConfig, type ResolvedConfig } from '../config.js'
import { buildAnonymousClient, buildClient } from '../platform/factory.js'
import type { ModelInfo } from '../platform/client.js'
import { formatPrice, formatUsd, heading, note, say, spinner, style, warn } from '../ui.js'

/** `ducat search <query>` — browse the catalogue. */
export async function search(
  query: string,
  config: ResolvedConfig,
  opts: { category?: string } = {},
): Promise<number> {
  const client = await buildAnonymousClient(config)
  const spin = spinner('searching the catalogue')
  try {
    const page = await client.searchApis({
      ...(query ? { query } : {}),
      ...(opts.category ? { category: opts.category } : {}),
      pageSize: 25,
    })
    spin.stop()

    if (page.items.length === 0) {
      say('Nothing matched.')
      if (page.categories.length > 0) {
        heading('Categories')
        for (const c of page.categories) say(`  ${c.category} ${style.dim(`(${c.count})`)}`)
      }
      return 0
    }

    heading(`${page.total} match${page.total === 1 ? '' : 'es'}`)
    for (const item of page.items) {
      say(
        `${style.bold(item.name)} ${style.dim(item.serviceId)}  ` +
          `${style.cyan(item.method)} ${formatPrice(item.pricePerCall)}`,
      )
      if (item.description) say(`  ${style.dim(item.description)}`)
    }

    if (page.total > page.items.length) {
      say()
      note(`showing ${page.items.length} of ${page.total}; narrow the query to see others`)
    }
    say()
    note(`Call one: ${style.bold(`ducat "use ${page.items[0]!.name} to ..."`)}`)
    return 0
  } catch (err) {
    spin.stop()
    return reportError(err)
  }
}

/**
 * `ducat models` — what the gateway serves, and how to pick one.
 *
 * Routes are listed first and models second, cheapest-known first within each
 * group. The gateway serves 300+ models; an unsorted dump of them is a list nobody
 * reads, and it left the user with no idea that naming one was even possible. The
 * point of this command is choosing, so it ends by showing how.
 *
 * `--all` exists because the full list is occasionally what you want, and a command
 * that truncates with no way to see the rest is worse than one that is long.
 */
export async function models(config: ResolvedConfig, opts: { all?: boolean } = {}): Promise<number> {
  const client = await buildAnonymousClient(config)
  const spin = spinner('reading the model list')
  try {
    const list = await client.models()
    spin.stop()

    if (list.length === 0) {
      say('The gateway reported no models.')
      note('That is a gateway-side problem rather than a bad request.')
      return 1
    }

    const free = list.filter((m) => m.free)
    const paid = list.filter((m) => !m.free)

    heading('Smart routes')
    note('  the gateway reads the request and picks a model per call')
    say(`  ${style.bold('auto')}          ${style.dim('balanced — the default once you have a credential')}`)
    say(`  ${style.bold('auto/free')}     ${style.dim('free models only — the default before setup')}`)
    say(`  ${style.bold('auto/eco')}      ${style.dim('cheapest paid models')}`)
    say(`  ${style.bold('auto/premium')}  ${style.dim('strongest models, highest cost')}`)

    if (free.length > 0) {
      heading(`Free (${free.length})`)
      for (const m of free) say(`  ${style.green(m.id)}`)
    }

    // Per-token and per-call models are listed separately rather than sorted into one
    // list. Their prices are not comparable — $0.02/M of tokens against $1.575 a call
    // — so ranking them together put fourteen video and image models at the top of
    // what someone reads to choose a chat model.
    const perToken = paid.filter((m) => m.pricing !== 'per-call')
    const perCall = paid.filter((m) => m.pricing === 'per-call')

    // Cheapest first: someone scanning this is deciding what they are willing to pay.
    // Unpriced rows last, because they cannot be compared.
    const byPrice = (pick: (m: ModelInfo) => number | undefined) => (a: ModelInfo, b: ModelInfo) => {
      const ap = pick(a)
      const bp = pick(b)
      if (ap === undefined && bp === undefined) return a.id.localeCompare(b.id)
      if (ap === undefined) return 1
      if (bp === undefined) return -1
      return ap - bp || a.id.localeCompare(b.id)
    }
    const sorted = [...perToken].sort(byPrice((m) => m.inputPerMTokenUsd))
    const shown = opts.all ? sorted : sorted.slice(0, PAID_MODEL_PREVIEW)

    heading(`Paid, per token (${perToken.length})`)
    for (const m of shown) {
      const price =
        m.inputPerMTokenUsd === undefined
          ? style.dim('  price not published')
          : style.dim(
              `  $${rate(m.inputPerMTokenUsd)}/M in · ` +
                `$${m.outputPerMTokenUsd === undefined ? '?' : rate(m.outputPerMTokenUsd)}/M out`,
            )
      say(`  ${m.id}${price}`)
    }
    if (shown.length < sorted.length) {
      note(`  … ${sorted.length - shown.length} more — ducat models --all`)
    }

    if (perCall.length > 0) {
      heading(`Paid, per call (${perCall.length})`)
      note('  video, image and music — one price per generation, not per token')
      for (const m of [...perCall].sort(byPrice((m) => m.fixedPriceUsd))) {
        const price =
          m.fixedPriceUsd === undefined
            ? style.dim('  price not published')
            : style.dim(`  ${formatUsd(m.fixedPriceUsd)} per call`)
        say(`  ${m.id}${price}`)
      }
    }

    say()
    note(`Pick one for a single task:  ducat -m <model> "<task>"`)
    note(`Make it the default:         ducat config set model <model>`)
    if (free.length > 0) {
      note(`Paid models need a credential — free ones and browsing do not.`)
    }
    return 0
  } catch (err) {
    spin.stop()
    return reportError(err)
  }
}

/**
 * How many paid models `ducat models` shows before asking for `--all`. The gateway
 * serves 300+; a screenful of the cheapest is what someone choosing actually reads.
 */
const PAID_MODEL_PREVIEW = 20

/**
 * A per-million-token rate, without the float noise.
 *
 * The gateway computes some rates by multiplication, so 0.0797 * 3 arrives as
 * 0.23909999999999998 and printing it raw is nineteen digits of nonsense in a list
 * meant to be scanned. Four decimals is finer than any rate published here, and
 * trailing zeros are dropped so $0.5 does not become $0.5000.
 */
function rate(usd: number): string {
  return String(Number(usd.toFixed(4)))
}


/** `ducat agents` — other agents on the platform. */
export async function agents(config: ResolvedConfig, opts: { search?: string } = {}): Promise<number> {
  const client = await buildAnonymousClient(config)
  const spin = spinner('reading the agent registry')
  try {
    const list = await client.discoverAgents(opts.search ? { search: opts.search } : {})
    spin.stop()

    if (list.length === 0) {
      say('No agent matched.')
      return 0
    }

    heading(`${list.length} agent${list.length === 1 ? '' : 's'}`)
    for (const a of list) {
      say(
        `${style.bold(a.name)} ${style.dim(a.agentId)}` +
          `${a.verified ? style.green(' ✓') : ''}  ${formatPrice(a.pricePerCall)}`,
      )
      if (a.description) say(`  ${style.dim(a.description)}`)
      if (a.capabilities.length > 0) say(`  ${style.dim(a.capabilities.join(', '))}`)
    }
    return 0
  } catch (err) {
    spin.stop()
    return reportError(err)
  }
}

/** `ducat balance` — what is spendable. */
export async function balance(config: ResolvedConfig): Promise<number> {
  const spin = spinner('reading the balance')
  try {
    const client = await buildClient(config)
    const usd = await client.getBalanceUsd()
    spin.stop()

    say(`${style.bold(formatUsd(usd))} USDC`)
    if (client.address) {
      note(`wallet ${client.address}`)
      note('This is the on-chain balance x402 settles against.')
    } else {
      note('Account deposit wallet, as the gateway reports it.')
    }
    if (usd === 0) {
      say()
      note('Zero is normal for a new account. Free models still work: --model auto/free')
    }
    return 0
  } catch (err) {
    spin.stop()
    return reportError(err)
  }
}

/**
 * `ducat config` — what is in effect, and where it came from.
 *
 * Reports the source of each setting because "it's using the wrong key" is almost
 * always a forgotten environment variable, and guessing at that is miserable.
 */
export async function showConfig(config: ResolvedConfig): Promise<number> {
  const stored = readConfig()

  heading('In effect')
  say(`  gateway  ${config.baseUrl}`)
  say(`  model    ${config.model}`)
  say(
    `  max/call ${config.maxCallUsd === undefined ? style.dim('SDK default (100 USDC)') : formatUsd(config.maxCallUsd)}`,
  )

  heading('Credential')
  if (config.source.credential === 'none') {
    say(`  ${style.dim('none — run `ducat setup`')}`)
  } else {
    const kind = config.walletKey ? 'wallet key' : 'api key'
    const secret = config.walletKey ?? config.apiKey ?? ''
    say(`  ${kind}  ${maskSecret(secret)}  ${style.dim(`from ${config.source.credential}`)}`)
    if (config.source.credential === 'env') {
      note('  An environment variable is overriding the config file.')
    }
  }

  heading('File')
  say(`  ${config.source.configPath}`)
  if (Object.keys(stored).length === 0) note('  (not created yet)')
  say()
  note('Change the default model:  ducat config set model <model|auto|auto/free>')
  return 0
}

/** Settings `config set` accepts. Credentials are not among them — see below. */
const SETTABLE = {
  model: 'model',
  'max-call': 'maxCallUsd',
  'max-spend': 'maxSpendUsd',
  gateway: 'baseUrl',
} as const

/**
 * `ducat config set <key> <value>` — persist a default.
 *
 * Credentials are deliberately not settable this way. `setup` writes those, and it
 * is the place that explains what a hot wallet means; a bare `config set api-key`
 * would let someone paste a secret into their shell history with no such warning.
 *
 * The model value is not validated against the catalogue. A gateway can add models
 * at any time, and refusing an unknown name would mean this command needs a network
 * round-trip to succeed — and would reject a model that works. A wrong name fails
 * at the point of use with the gateway's own error, which is more accurate than
 * anything guessed here.
 */
export async function setConfig(args: string[]): Promise<number> {
  const [rawKey, ...rest] = args
  const value = rest.join(' ')

  if (!rawKey || value === '') {
    say(`${style.red('✗')} usage: ducat config set <key> <value>`)
    note(`  keys: ${Object.keys(SETTABLE).join(', ')}`)
    return 2
  }

  const key = rawKey.replace(/^--/, '')
  if (!(key in SETTABLE)) {
    say(`${style.red('✗')} unknown setting ${style.bold(key)}`)
    note(`  keys: ${Object.keys(SETTABLE).join(', ')}`)
    if (key.includes('key') || key.includes('wallet')) {
      note('  Credentials are set by `ducat setup`, which explains the tradeoffs first.')
    }
    return 2
  }

  const field = SETTABLE[key as keyof typeof SETTABLE]
  const stored = readConfig()

  if (field === 'maxCallUsd' || field === 'maxSpendUsd') {
    const usd = Number(value)
    // Rejected rather than clamped: a ceiling someone believes they set, and did
    // not, is worse than an error. NaN and negatives both mean "unbounded" if
    // allowed through, which is the opposite of what they were reaching for.
    if (!Number.isFinite(usd) || usd < 0) {
      say(`${style.red('✗')} ${key} must be a non-negative number of USD, got ${style.bold(value)}`)
      return 2
    }
    writeConfig({ ...stored, [field]: usd })
  } else {
    writeConfig({ ...stored, [field]: value })
  }

  say(`${style.green('✓')} ${key} = ${style.bold(value)}`)
  note(`  ${configPath()}`)
  // A flag or an environment variable outranks the file, so saying "set" without
  // this would be a lie in exactly the case that confuses people most.
  if (key === 'model' && process.env['DUCAT_MODEL']) {
    warn('DUCAT_MODEL is set in this shell and overrides the file.')
  }
  return 0
}

function reportError(err: unknown): number {
  say(`${style.red('✗')} ${err instanceof JarvisClawError ? err.message : String(err)}`)
  return 1
}
