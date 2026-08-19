/**
 * The local hot wallet.
 *
 * Generated here, never asked for. A CLI that prompts for a private key teaches
 * users the exact habit that phishing relies on, and the key they would paste
 * controls everything they own rather than the few dollars a tool like this needs.
 *
 * What this is instead: a fresh key with nothing in it until the user sends USDC to
 * it from their own wallet. That transfer is the consent — signed in their own
 * wallet UI, for an amount they chose — and it also caps the blast radius. Losing
 * this file loses what is in this wallet and nothing else.
 *
 * It is a hot wallet on a developer's disk. Treat it like cash in a coat pocket.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Where the key lives. Sibling of config.json, same 0600 treatment.
 *
 * `~/.jarvisclaw/` is shared with the Python SDK, which writes cost_log.jsonl and a
 * cache/ directory there. Sharing one directory per brand is the usual convention
 * (gh, aws), but it means this file has a neighbour that did not create it: never
 * clear the directory, only this file, and keep the 0600 mode on every write rather
 * than relying on the directory's permissions.
 */
export function walletPath(): string {
  return join(homedir(), '.jarvisclaw', 'wallet.json')
}

export interface StoredWallet {
  /** 0x-prefixed 32-byte key. */
  privateKey: string
  address: string
  /** Unix seconds, for `jarvisclaw wallet` to say how old it is. */
  createdAt: number
}

export interface WalletResult {
  address: string
  privateKey: string
  /** True when this call generated it, so the caller can show funding steps. */
  isNew: boolean
}

/**
 * Load the wallet, generating one if there is none.
 *
 * Key generation goes through viem's `generatePrivateKey`, which draws from the
 * platform CSPRNG. Deliberately not hand-rolled: a weak key here is silent and
 * total, and there is no reason to reimplement an audited primitive.
 */
export async function getOrCreateWallet(): Promise<WalletResult> {
  const existing = loadWallet()
  if (existing) {
    return { address: existing.address, privateKey: existing.privateKey, isNew: false }
  }

  const { generatePrivateKey, privateKeyToAccount } = await loadViemAccounts()
  const privateKey = generatePrivateKey()
  const address = privateKeyToAccount(privateKey).address

  saveWallet({ privateKey, address, createdAt: Math.floor(Date.now() / 1000) })
  return { address, privateKey, isNew: true }
}

/** Read the stored wallet, or undefined if there is none or it is unreadable. */
export function loadWallet(): StoredWallet | undefined {
  try {
    const parsed = JSON.parse(readFileSync(walletPath(), 'utf8')) as Partial<StoredWallet>
    if (!parsed.privateKey || !parsed.address) return undefined
    return {
      privateKey: parsed.privateKey,
      address: parsed.address,
      createdAt: parsed.createdAt ?? 0,
    }
  } catch {
    // Missing is the normal first-run state. A corrupt file is deliberately not
    // overwritten here — see assertNoWalletToOverwrite.
    return undefined
  }
}

/**
 * Write the wallet with owner-only permissions.
 *
 * The mode is set on the open and again explicitly, because the first depends on
 * the process umask. On Windows neither has an effect — POSIX modes are not
 * implemented there — which is why the permission guarantee is asserted in CI on
 * Linux rather than in the local test suite.
 */
export function saveWallet(wallet: StoredWallet): string {
  const path = walletPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(wallet, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // No POSIX modes on this filesystem. The write succeeded; the mode is
    // hardening, not a precondition.
  }
  return path
}

/**
 * Refuse to proceed if a wallet file exists but cannot be read.
 *
 * Generating a fresh wallet over an unreadable one would abandon whatever funds
 * the old key held, with no way back. A corrupt file is a case for the user to
 * look at, not for us to silently replace.
 */
export function assertNoWalletToOverwrite(): void {
  const path = walletPath()
  if (!existsSync(path)) return
  if (loadWallet()) return
  throw new Error(
    `${path} exists but could not be read. It may hold funds, so it will not be ` +
      'replaced automatically. Move it aside if you are sure it is not needed.',
  )
}

/** True when the wallet file is readable by anyone but its owner (POSIX only). */
export function walletIsWorldReadable(): boolean {
  try {
    if (process.platform === 'win32') return false
    return (statSync(walletPath()).mode & 0o077) !== 0
  } catch {
    return false
  }
}

async function loadViemAccounts(): Promise<{
  generatePrivateKey(): `0x${string}`
  privateKeyToAccount(key: `0x${string}`): { address: string }
}> {
  try {
    return (await import('viem/accounts')) as unknown as {
      generatePrivateKey(): `0x${string}`
      privateKeyToAccount(key: `0x${string}`): { address: string }
    }
  } catch (err) {
    throw new Error(
      `viem is required to create a wallet but could not be loaded (${String(err)}).`,
    )
  }
}
