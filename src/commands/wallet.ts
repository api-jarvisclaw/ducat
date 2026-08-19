/** `jarvisclaw wallet` — what the local wallet is, and how to fund it. */
import { loadWallet, walletIsWorldReadable, walletPath } from '../wallet.js'
import { heading, note, say, style, warn } from '../ui.js'

export async function wallet(): Promise<number> {
  const stored = loadWallet()
  if (!stored) {
    say('No local wallet yet.')
    note('Create one with `jarvisclaw setup`, or use an API key instead.')
    return 1
  }

  heading('Address')
  say(`  ${style.cyan(stored.address)}`)
  note('  Send USDC on Base here. You do not need ETH — the gateway pays the gas.')

  heading('File')
  say(`  ${walletPath()}`)
  if (stored.createdAt) {
    say(`  created ${new Date(stored.createdAt * 1000).toISOString().slice(0, 10)}`)
  }

  if (walletIsWorldReadable()) {
    // Worth interrupting for: the file holds a spendable key, and permissions can
    // drift through a copy, a restore, or a synced folder.
    say()
    warn('That file is readable by other accounts on this machine.')
    note(`  Fix it with: chmod 600 ${walletPath()}`)
  }

  say()
  note('Balance:  jarvisclaw balance')
  // Stated on every viewing, not just at creation — this is the screen someone
  // returns to weeks later, having forgotten what kind of wallet it is.
  note('This is a hot wallet. Keep only what you are willing to spend here.')
  return 0
}
