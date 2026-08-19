/**
 * `ducat setup` — pick how payment works, once.
 *
 * Two ways, and the choice is the user's:
 *
 *   1. A local wallet ducat generates. Non-custodial, no account. The user funds it
 *      from their own wallet, and that transfer is both the consent and the cap.
 *   2. A jarvisclaw.ai API key. The account pays; billing, history and top-ups live
 *      on the website where they belong.
 *
 * Neither asks for an existing private key. That prompt is what phishing looks
 * like, and the key would grant far more than a per-call budget needs.
 */
import { readConfig, writeConfig, maskSecret, type ResolvedConfig } from '../config.js'
import { buildClient } from '../platform/factory.js'
import { assertNoWalletToOverwrite, getOrCreateWallet, loadWallet, walletPath } from '../wallet.js'
import { ask, formatUsd, heading, note, ok, say, spinner, style, warn } from '../ui.js'

export async function setup(config: ResolvedConfig): Promise<number> {
  say(`${style.bold('ducat setup')}`)
  say()
  say('How should paid calls be paid for?')
  say()
  say(`  ${style.bold('1')} ${style.bold('A wallet on this machine')}`)
  note('     ducat creates it. You send USDC to it from your own wallet.')
  note('     No account, no signup. Your keys stay here.')
  say()
  say(`  ${style.bold('2')} ${style.bold('A jarvisclaw.ai account')}`)
  note('     Your account balance pays. Top up on the website.')
  say()
  note('Either way, free models and browsing work without any of this.')
  say()

  const choice = (await ask('Which? [1/2] ')).trim()
  if (choice === '2') return setupAccount(config)
  if (choice === '1' || choice === '') return setupWallet()

  warn(`Expected 1 or 2, got ${JSON.stringify(choice)}. Nothing changed.`)
  return 1
}

/** Generate a local wallet and explain how to fund it. */
async function setupWallet(): Promise<number> {
  try {
    assertNoWalletToOverwrite()
  } catch (err) {
    say(`${style.red('✗')} ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  const existing = loadWallet()
  const { address, isNew } = await getOrCreateWallet()

  say()
  if (isNew) {
    ok('Wallet created.')
  } else {
    note(`Using the wallet already at ${walletPath()}.`)
    if (existing?.createdAt) {
      const days = Math.floor((Date.now() / 1000 - existing.createdAt) / 86400)
      note(`Created ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}.`)
    }
  }

  heading('Your address')
  say(`  ${style.cyan(address)}`)

  heading('To fund it')
  say('  Send USDC on Base to that address, from any wallet or exchange.')
  note('  Start small — $2 goes a long way at these prices.')
  note('  USDC, not ETH. You do not need ETH: the gateway pays the gas.')

  heading('Worth knowing')
  // Said plainly rather than buried. Someone who assumes this behaves like an
  // exchange account will eventually lose money and be surprised by it.
  say(`  This is a hot wallet stored at ${walletPath()}.`)
  say('  Anything in it can be spent by this machine. If you lose the file, or')
  say('  someone else reads it, the funds are gone — there is no recovery and no')
  say('  support desk. Keep only what you are willing to spend here.')

  say()
  note('Check it arrived:  ducat balance')
  note('Then just ask:     ducat "find a weather api and check Tokyo"')
  return 0
}

/** Store an API key and verify it works. */
async function setupAccount(config: ResolvedConfig): Promise<number> {
  say()
  note('Create a key at https://jarvisclaw.ai — Settings → API keys.')
  const key = await ask('api key: ', { secret: true })
  if (!key) {
    warn('Nothing entered; no change made.')
    return 1
  }

  const stored = readConfig()
  const next = { ...stored, apiKey: key }
  // The two modes are mutually exclusive in stored config: keeping both would make
  // which one pays depend on resolution order rather than on what the user chose.
  delete next.walletKey
  const path = writeConfig(next)
  ok(`API key ${maskSecret(key)} saved to ${path}`)

  // Verified now rather than at the first real task: a bad key found here is a
  // one-line fix, while the same key found mid-task looks like a broken tool.
  const spin = spinner('checking the key')
  try {
    const client = await buildClient({ ...config, apiKey: key, walletKey: undefined })
    const balance = await client.getBalanceUsd()
    spin.stop()
    ok(`balance ${formatUsd(balance)}`)
    if (balance === 0) {
      say()
      warn('The balance is zero, so paid calls will be refused.')
      note('Top up at https://jarvisclaw.ai, or use free models — they need nothing.')
    }
    return 0
  } catch (err) {
    spin.stop()
    say(`${style.red('✗')} ${err instanceof Error ? err.message : String(err)}`)
    note('The key was saved but could not be verified. Check it, or rerun setup.')
    return 1
  }
}
