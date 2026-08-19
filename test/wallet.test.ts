/**
 * The local wallet.
 *
 * This replaces a design that asked the user to paste their own private key. That
 * was wrong twice over: it teaches the habit phishing depends on, and the key it
 * asked for controls everything the user owns rather than the few dollars a
 * per-call budget needs. A generated key that only ever holds what the user chose
 * to send it caps the damage before the agent starts.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertNoWalletToOverwrite,
  getOrCreateWallet,
  loadWallet,
  saveWallet,
  walletPath,
} from '../src/wallet.js'

let home: string

beforeEach(() => {
  // A real HOME would read the developer's own wallet, and saveWallet would
  // overwrite it — with funds in it.
  home = mkdtempSync(join(tmpdir(), 'ducat-w-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('getOrCreateWallet', () => {
  it('generates a wallet without asking for a key', async () => {
    const { address, privateKey, isNew } = await getOrCreateWallet()
    expect(isNew).toBe(true)
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/)
  })

  it('derives the address from the key it generated', async () => {
    // A mismatch would print a funding address the wallet cannot spend from, so
    // the user's money would land somewhere unreachable.
    const { address, privateKey } = await getOrCreateWallet()
    const { privateKeyToAccount } = await import('viem/accounts')
    expect(privateKeyToAccount(privateKey as `0x${string}`).address).toBe(address)
  })

  it('returns the same wallet on a second call', async () => {
    // Regenerating would strand whatever the user had already sent to the first
    // address.
    const first = await getOrCreateWallet()
    const second = await getOrCreateWallet()
    expect(second.isNew).toBe(false)
    expect(second.address).toBe(first.address)
    expect(second.privateKey).toBe(first.privateKey)
  })

  it('generates a different wallet for a different home', async () => {
    // Guards against a fixed or seeded key, which would make every install share
    // one wallet.
    const first = await getOrCreateWallet()
    const other = mkdtempSync(join(tmpdir(), 'ducat-w2-'))
    try {
      vi.stubEnv('HOME', other)
      vi.stubEnv('USERPROFILE', other)
      const second = await getOrCreateWallet()
      expect(second.address).not.toBe(first.address)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('writes the key where `ducat wallet` reports it', async () => {
    await getOrCreateWallet()
    expect(existsSync(walletPath())).toBe(true)
    expect(walletPath()).toContain('.ducat')
  })

  it('stores the key owner-only', async () => {
    // Anything that can read this file can spend the wallet.
    await getOrCreateWallet()
    if (process.platform !== 'win32') {
      expect(statSync(walletPath()).mode & 0o777).toBe(0o600)
    }
    // Windows reports 666 for every file whatever mode is requested, which is why
    // the guarantee is also asserted in CI on Linux (test/check-permissions.ts).
  })

  it('records when it was created', async () => {
    await getOrCreateWallet()
    const stored = loadWallet()!
    expect(stored.createdAt).toBeGreaterThan(1_700_000_000)
  })
})

describe('loadWallet', () => {
  it('returns undefined when there is none', () => {
    expect(loadWallet()).toBeUndefined()
  })

  it('returns undefined for a file missing the key', () => {
    saveWallet({ privateKey: '', address: '0xabc', createdAt: 0 })
    expect(loadWallet()).toBeUndefined()
  })

  it('tolerates a missing createdAt from an older file', () => {
    // Written through saveWallet first so the directory exists, then rewritten
    // without the field an earlier version did not store.
    saveWallet({ privateKey: '0x11', address: '0xaa', createdAt: 0 })
    writeFileSync(walletPath(), JSON.stringify({ privateKey: '0x11', address: '0xaa' }))
    expect(loadWallet()?.address).toBe('0xaa')
    expect(loadWallet()?.createdAt).toBe(0)
  })
})

describe('assertNoWalletToOverwrite', () => {
  it('permits a first run', () => {
    expect(() => assertNoWalletToOverwrite()).not.toThrow()
  })

  it('permits a readable existing wallet', async () => {
    await getOrCreateWallet()
    expect(() => assertNoWalletToOverwrite()).not.toThrow()
  })

  it('refuses to run past a corrupt wallet file', async () => {
    // Generating a fresh key over an unreadable one abandons whatever the old key
    // held, irreversibly. That is the user's call, not ours.
    await getOrCreateWallet()
    writeFileSync(walletPath(), '{ this is not json')
    expect(() => assertNoWalletToOverwrite()).toThrow(/could not be read/)
    expect(() => assertNoWalletToOverwrite()).toThrow(/will not be replaced/)
  })

  it('leaves the corrupt file in place', async () => {
    await getOrCreateWallet()
    writeFileSync(walletPath(), '{ corrupt')
    try {
      assertNoWalletToOverwrite()
    } catch {
      // expected
    }
    expect(readFileSync(walletPath(), 'utf8')).toBe('{ corrupt')
  })
})
