/**
 * The credential-less first run.
 *
 * This path is the reason the CLI exists: a novice who must obtain an API key
 * before seeing anything work is a novice who leaves. It was also wrong at first —
 * `buildClient` refused without a credential, and the anonymous helper sent a
 * placeholder key the gateway 401s. Both were only visible by running against the
 * live gateway.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAnonymousClient, buildRunClient, buildClient } from '../src/platform/factory.js'
import { resolveConfig } from '../src/config.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jc-anon-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  for (const key of ['JARVISCLAW_API_KEY', 'JARVISCLAW_WALLET_KEY']) delete process.env[key]
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('buildRunClient', () => {
  it('runs anonymously when there is no credential, instead of refusing', async () => {
    const { client, anonymous } = await buildRunClient(resolveConfig())
    expect(anonymous).toBe(true)
    expect(client.isAnonymous).toBe(true)
  })

  it('forces a free model in anonymous mode', async () => {
    // An anonymous request for a paid model answers 402, and reporting "payment
    // required" to someone who never asked to pay is its own dead end.
    const { model } = await buildRunClient(resolveConfig({ model: 'openai/gpt-5' }))
    expect(model).toBe('auto/free')
  })

  it('keeps a free model the user asked for', async () => {
    const { model } = await buildRunClient(resolveConfig({ model: 'auto/free' }))
    expect(model).toBe('auto/free')
  })

  it('uses the real credential and the requested model when one exists', async () => {
    const config = resolveConfig({ apiKey: 'sk-test', model: 'openai/gpt-5' })
    const { client, model, anonymous } = await buildRunClient(config)
    expect(anonymous).toBe(false)
    expect(client.isAnonymous).toBe(false)
    expect(model).toBe('openai/gpt-5')
  })

  it('does not downgrade a paying user to a free model', async () => {
    // Silently switching a credentialed user to auto/free would give them worse
    // answers than they asked and paid for.
    const { model } = await buildRunClient(
      resolveConfig({ walletKey: `0x${'11'.repeat(32)}`, model: 'auto/premium' }),
    )
    expect(model).toBe('auto/premium')
  })
})

describe('buildAnonymousClient', () => {
  it('sends no credential when there is none', async () => {
    const client = await buildAnonymousClient(resolveConfig())
    expect(client.isAnonymous).toBe(true)
  })

  it('prefers a real credential when one exists', async () => {
    const client = await buildAnonymousClient(resolveConfig({ apiKey: 'sk-test' }))
    expect(client.isAnonymous).toBe(false)
  })
})

describe('buildClient', () => {
  it('points a first-time user at login rather than at env vars', async () => {
    // The SDK's own message names environment variables, which is not the next step
    // for someone who just installed a CLI.
    await expect(buildClient(resolveConfig())).rejects.toThrow(/jarvisclaw login/)
  })
})
