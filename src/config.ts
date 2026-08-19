/**
 * Where settings come from, and where a credential is allowed to live.
 *
 * Precedence: CLI flag, then environment, then the config file, then a default.
 * A flag beating the environment matters because a stale exported key in someone's
 * shell would otherwise silently override what they just typed.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadWallet } from './wallet.js'

export const DEFAULT_GATEWAY = 'https://api.jarvisclaw.ai'
/** Free tier virtual model — resolved by the gateway to a zero-cost model. */
export const DEFAULT_MODEL = 'auto/free'

export interface StoredConfig {
  apiKey?: string
  walletKey?: string
  baseUrl?: string
  model?: string
  /** Per-call ceiling in USD. Converted to base units when the client is built. */
  maxCallUsd?: number
  /** Per-session total ceiling in USD. */
  maxSpendUsd?: number
}

export interface ResolvedConfig {
  // Explicitly `| undefined` rather than optional: callers build a variant with
  // `{ ...config, apiKey: undefined }` to drop a credential, and under
  // exactOptionalPropertyTypes an optional-only field rejects that.
  apiKey?: string | undefined
  walletKey?: string | undefined
  baseUrl: string
  model: string
  maxCallUsd: number | undefined
  maxSpendUsd: number | undefined
  /** Where the config came from, for `ducat config` to report honestly. */
  source: {
    credential: 'flag' | 'env' | 'file' | 'wallet' | 'none'
    configPath: string
  }
}

/** `~/.ducat/config.json`. */
export function configPath(): string {
  return join(homedir(), '.ducat', 'config.json')
}

export function readConfig(): StoredConfig {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as StoredConfig
  } catch {
    // Missing or unreadable is the normal first-run state, not an error.
    return {}
  }
}

/**
 * Write the config with owner-only permissions.
 *
 * A private key in a 644 file in the home directory is readable by every other
 * account on a shared machine, so the mode is set explicitly rather than left to
 * the process umask.
 */
export function writeConfig(config: StoredConfig): string {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // No POSIX modes on some filesystems (Windows, network mounts). The write
    // still succeeded; the mode is a hardening step, not a requirement.
  }
  return path
}

export interface ConfigFlags {
  apiKey?: string
  walletKey?: string
  baseUrl?: string
  model?: string
  maxCallUsd?: number
  maxSpendUsd?: number
  /** Skip the generated wallet, for `setup` and for tests. */
  ignoreWallet?: boolean
}

export function resolveConfig(flags: ConfigFlags = {}): ResolvedConfig {
  const stored = readConfig()
  const env = process.env

  // The generated wallet is last: an explicitly chosen credential always wins over
  // one that happens to be lying on disk from an earlier `ducat setup`.
  const generated = flags.ignoreWallet ? undefined : loadWallet()

  const apiKey = flags.apiKey ?? env['DUCAT_API_KEY'] ?? env['JARVISCLAW_API_KEY'] ?? stored.apiKey
  const walletKey =
    flags.walletKey ??
    env['DUCAT_WALLET_KEY'] ??
    env['JARVISCLAW_WALLET_KEY'] ??
    stored.walletKey ??
    generated?.privateKey

  const credential: ResolvedConfig['source']['credential'] =
    flags.apiKey || flags.walletKey
      ? 'flag'
      : env['DUCAT_API_KEY'] ||
          env['JARVISCLAW_API_KEY'] ||
          env['DUCAT_WALLET_KEY'] ||
          env['JARVISCLAW_WALLET_KEY']
        ? 'env'
        : stored.apiKey || stored.walletKey
          ? 'file'
          : generated
            ? 'wallet'
            : 'none'

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(walletKey ? { walletKey } : {}),
    baseUrl: (flags.baseUrl ?? env['DUCAT_BASE_URL'] ?? env['JARVISCLAW_BASE_URL'] ?? stored.baseUrl ?? DEFAULT_GATEWAY)
      .replace(/\/+$/, ''),
    model: flags.model ?? env['DUCAT_MODEL'] ?? env['JARVISCLAW_MODEL'] ?? stored.model ?? DEFAULT_MODEL,
    maxCallUsd: flags.maxCallUsd ?? stored.maxCallUsd,
    maxSpendUsd: flags.maxSpendUsd ?? stored.maxSpendUsd,
    source: { credential, configPath: configPath() },
  }
}

/** USD to USDC base units (6 decimals), for the SDK's per-call ceiling. */
export function usdToBaseUnits(usd: number): bigint {
  // Rounded rather than truncated so a ceiling of 0.0000005 does not become zero,
  // which would reject every payment instead of allowing a tiny one.
  return BigInt(Math.round(usd * 1_000_000))
}

/** Mask a credential for display. Never print one in full. */
export function maskSecret(secret: string): string {
  if (secret.length <= 10) return '•'.repeat(secret.length)
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`
}
