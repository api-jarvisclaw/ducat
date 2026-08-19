/**
 * `ducat logout` — remove a stored credential.
 *
 * There is no `login` here any more. It used to offer "paste your private key",
 * which is the prompt phishing imitates and which grants far more than a per-call
 * budget needs. `ducat setup` replaced it: it generates a wallet rather than asking
 * for one. `login` remains registered as an alias for setup, since it is the word
 * people type.
 */
import { existsSync, rmSync } from 'node:fs'
import { readConfig, writeConfig } from '../config.js'
import { walletPath } from '../wallet.js'
import { confirmYesNo, note, ok, say, warn } from '../ui.js'

export async function logout(): Promise<number> {
  const stored = readConfig()
  const hasStored = Boolean(stored.apiKey ?? stored.walletKey)
  const hasWallet = existsSync(walletPath())

  if (!hasStored && !hasWallet) {
    note('Nothing stored to remove.')
    return 0
  }

  if (hasStored) {
    const what = stored.walletKey ? 'wallet key' : 'API key'
    if (await confirmYesNo(`Remove the stored ${what}?`)) {
      const next = { ...stored }
      delete next.apiKey
      delete next.walletKey
      writeConfig(next)
      ok(`Removed the stored ${what}.`)
    } else {
      note('Credential left unchanged.')
    }
  }

  // The generated wallet is deliberately a separate question, and deliberately
  // never removed by default. It can hold real USDC, deleting the file destroys
  // the only key to it, and "logout" does not mean "burn my money" — someone
  // clearing a credential to switch accounts would lose their balance.
  if (hasWallet) {
    say()
    warn(`A local wallet remains at ${walletPath()}.`)
    note('  It may hold USDC. Deleting the file destroys the only key to it.')
    note('  Check it first with: ducat wallet   /   ducat balance')
    if (await confirmYesNo('  Delete it anyway? This cannot be undone.')) {
      // Asked twice on purpose. The first answer can be a reflex; this one is
      // irreversible and unrecoverable.
      if (await confirmYesNo('  Are you sure? Any USDC in it will be unrecoverable.')) {
        rmSync(walletPath(), { force: true })
        ok('Wallet file deleted.')
      } else {
        note('  Wallet kept.')
      }
    } else {
      note('  Wallet kept.')
    }
  }

  note('Environment variables, if you have any set, are untouched.')
  return 0
}
