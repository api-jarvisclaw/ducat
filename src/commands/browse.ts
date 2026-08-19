/**
 * The read-only commands: search, models, agents, balance, config.
 *
 * These exist so someone can see what the platform holds before committing a
 * credential or spending anything. `search` and `models` need no login at all.
 */
import { JarvisClawError } from '@jarvisclaw/sdk'
import { maskSecret, readConfig, type ResolvedConfig } from '../config.js'
import { buildAnonymousClient, buildClient } from '../platform/factory.js'
import { formatPrice, formatUsd, heading, note, say, spinner, style } from '../ui.js'

/** `jarvisclaw search <query>` — browse the catalogue. */
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
    note(`Call one: ${style.bold(`jarvisclaw "use ${page.items[0]!.name} to ..."`)}`)
    return 0
  } catch (err) {
    spin.stop()
    return reportError(err)
  }
}

/** `jarvisclaw models` — what the gateway serves. */
export async function models(config: ResolvedConfig): Promise<number> {
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
    heading(`${list.length} model${list.length === 1 ? '' : 's'}`)

    if (free.length > 0) {
      say(style.green(`  ${free.length} free:`))
      for (const m of free) say(`    ${m.id}`)
      say()
    }

    for (const m of list) {
      if (m.free) continue
      const price =
        m.inputPerMTokenUsd === undefined
          ? ''
          : style.dim(`  $${m.inputPerMTokenUsd}/M in, $${m.outputPerMTokenUsd ?? '?'}/M out`)
      say(`  ${m.id}${price}`)
    }

    say()
    note('Virtual routes: auto, auto/free, auto/eco, auto/premium — the gateway picks a model.')
    return 0
  } catch (err) {
    spin.stop()
    return reportError(err)
  }
}

/** `jarvisclaw agents` — other agents on the platform. */
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
 * `jarvisclaw config` — what is in effect, and where it came from.
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
  return 0
}

function reportError(err: unknown): number {
  say(`${style.red('✗')} ${err instanceof JarvisClawError ? err.message : String(err)}`)
  return 1
}
