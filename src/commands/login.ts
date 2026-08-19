/** `jarvisclaw login` — the first-run path, and the one that has to not lose people. */
import { JarvisClawError } from '@jarvisclaw/sdk'
import { detectKeyType } from '@jarvisclaw/sdk'
import { readConfig, writeConfig, maskSecret, type ResolvedConfig } from '../config.js'
import { buildClient } from '../platform/factory.js'
import { ask, confirmYesNo, formatUsd, note, ok, say, spinner, style, warn } from '../ui.js'

export async function login(config: ResolvedConfig): Promise<number> {
  say(`${style.bold('jarvisclaw login')}`)
  say()
  say('Two ways in:')
  say(`  ${style.bold('1')} API key      ${style.dim('— an account on the gateway pays for calls')}`)
  say(`  ${style.bold('2')} Wallet key   ${style.dim('— your own USDC pays per call, no account')}`)
  say()

  const choice = await ask('Which? [1/2] ')
  const useWallet = choice.trim() === '2'

  const stored = readConfig()

  if (useWallet) {
    say()
    note('An EVM (Base) private key, or a Solana one in base58.')
    warn('This key can spend money. It is stored locally in ~/.jarvisclaw/config.json.')
    const key = await ask('wallet key: ', { secret: true })
    if (!key) {
      warn('Nothing entered; no change made.')
      return 1
    }

    // Classify before storing, so a mistyped key is caught here rather than at the
    // first payment attempt.
    let kind: string
    try {
      kind = detectKeyType(key)
    } catch (err) {
      say(`${style.red('✗')} ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }

    const next = { ...stored, walletKey: key }
    delete next.apiKey
    const path = writeConfig(next)
    ok(`${kind === 'solana' ? 'Solana' : 'EVM'} wallet key saved to ${path}`)
    return verify({ ...config, walletKey: key, apiKey: undefined })
  }

  say()
  note('Create one at https://jarvisclaw.ai (Settings → API keys).')
  const key = await ask('api key: ', { secret: true })
  if (!key) {
    warn('Nothing entered; no change made.')
    return 1
  }

  const next = { ...stored, apiKey: key }
  delete next.walletKey
  const path = writeConfig(next)
  ok(`API key ${maskSecret(key)} saved to ${path}`)
  return verify({ ...config, apiKey: key, walletKey: undefined })
}

/**
 * Confirm the credential actually works, before the user runs a real task.
 *
 * Worth the extra request: a bad key discovered here is a one-line fix, while the
 * same key discovered mid-task looks like the tool is broken.
 */
async function verify(config: ResolvedConfig): Promise<number> {
  const spin = spinner('checking the credential')
  try {
    const client = await buildClient(config)
    const balance = await client.getBalanceUsd()
    spin.stop()

    if (client.address) ok(`wallet ${client.address}`)
    ok(`balance ${formatUsd(balance)}`)

    if (balance === 0) {
      say()
      warn('The balance is zero, so paid calls will be refused.')
      note(`Free models still work: ${style.bold('jarvisclaw --model auto/free "hello"')}`)
    } else {
      say()
      note(`Try: ${style.bold('jarvisclaw "what can you do?"')}`)
    }
    return 0
  } catch (err) {
    spin.stop()
    say(`${style.red('✗')} ${err instanceof JarvisClawError ? err.message : String(err)}`)
    say()
    note('The credential was saved but could not be verified. Check it, or rerun login.')
    return 1
  }
}

/** `jarvisclaw logout` — remove stored credentials. */
export async function logout(): Promise<number> {
  const stored = readConfig()
  if (!stored.apiKey && !stored.walletKey) {
    note('No stored credential to remove.')
    return 0
  }

  const what = stored.walletKey ? 'wallet key' : 'API key'
  if (!(await confirmYesNo(`Remove the stored ${what}?`))) {
    note('Left unchanged.')
    return 0
  }

  const next = { ...stored }
  delete next.apiKey
  delete next.walletKey
  writeConfig(next)
  ok(`Removed the stored ${what}.`)
  note('Environment variables, if you have any set, are untouched.')
  return 0
}
