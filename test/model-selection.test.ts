/**
 * The default model changed from `auto/free` to `auto` once a credential exists, so
 * a paying user gets smart routing rather than being confined to free models. That
 * moves a safety property: "a first run cannot cost anything" used to be guaranteed
 * by the constant, and is now guaranteed by buildRunClient forcing FREE_MODEL when
 * there is no credential. These tests hold that line, and cover the paid selection
 * the change exists to enable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from '../src/args.js'
import { DEFAULT_MODEL, FREE_MODEL, VIRTUAL_ROUTES, resolveConfig } from '../src/config.js'
import { buildRunClient } from '../src/platform/factory.js'
import { setConfig } from '../src/commands/browse.js'

const ENV_KEYS = ['JARVISCLAW_MODEL', 'JARVISCLAW_MODEL', 'JARVISCLAW_API_KEY', 'JARVISCLAW_API_KEY']

let home: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jarvisclaw-model-'))
  // A real HOME would read the developer's own config into these assertions, and
  // `config set` would write to it. Same approach as test/config.test.ts.
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
})

describe('the default model', () => {
  it('is smart routing, not a pinned model name', () => {
    // A pinned name would be wrong in both directions: a cheap model on hard work,
    // or a premium one on "what time is it". The gateway classifies per request and
    // can be retuned without a CLI release.
    expect(DEFAULT_MODEL).toBe('auto')
    expect(VIRTUAL_ROUTES).toContain(DEFAULT_MODEL)
  })

  it('is not the free route, so a paying user is not confined to free models', () => {
    expect(DEFAULT_MODEL).not.toBe(FREE_MODEL)
  })
})

describe('what a request without a credential runs on', () => {
  it('is forced to the free route even though the default is now paid', async () => {
    const config = resolveConfig()
    expect(config.model).toBe(DEFAULT_MODEL)

    const { model, anonymous, downgraded } = await buildRunClient(config)
    expect(anonymous).toBe(true)
    expect(model).toBe(FREE_MODEL)
    expect(downgraded).toBe(true)
  })

  it('is still forced when a paid model was asked for explicitly', async () => {
    const config = resolveConfig({ model: 'anthropic/claude-opus-4.8' })
    const { model, downgraded } = await buildRunClient(config)
    // 402 is the alternative, and "payment required" to someone who never asked to
    // pay is a dead end on the first command.
    expect(model).toBe(FREE_MODEL)
    expect(downgraded).toBe(true)
  })

  it('reports no downgrade when the free route was what was asked for', async () => {
    const config = resolveConfig({ model: FREE_MODEL })
    const { model, downgraded } = await buildRunClient(config)
    expect(model).toBe(FREE_MODEL)
    expect(downgraded).toBe(false)
  })

  it('does not let a lookalike model name through on a prefix match', async () => {
    // `startsWith('auto/free')` would pass this to the gateway and earn a 402. The
    // free route is one exact name.
    const config = resolveConfig({ model: 'auto/freewheeling' })
    const { model, downgraded } = await buildRunClient(config)
    expect(model).toBe(FREE_MODEL)
    expect(downgraded).toBe(true)
  })
})

describe('choosing a paid model', () => {
  it('passes a named model through untouched when there is a credential', async () => {
    const config = resolveConfig({ apiKey: 'sk-test', model: 'anthropic/claude-sonnet-4.6' })
    const { model, anonymous, downgraded } = await buildRunClient(config)
    expect(anonymous).toBe(false)
    expect(model).toBe('anthropic/claude-sonnet-4.6')
    expect(downgraded).toBe(false)
  })

  it('passes a paid smart route through untouched', async () => {
    const config = resolveConfig({ apiKey: 'sk-test', model: 'auto/premium' })
    const { model, downgraded } = await buildRunClient(config)
    expect(model).toBe('auto/premium')
    expect(downgraded).toBe(false)
  })

  it('lets a credentialed user stay on free models if they choose to', async () => {
    // Choosing the free tier while holding a credential is a legitimate request, not
    // something to be "upgraded" for them.
    const config = resolveConfig({ apiKey: 'sk-test', model: FREE_MODEL })
    const { model } = await buildRunClient(config)
    expect(model).toBe(FREE_MODEL)
  })

  it('accepts -m and --model, and lets the flag beat the environment', () => {
    process.env['JARVISCLAW_MODEL'] = 'from/env'
    expect(parseArgs(['-m', 'from/flag', 'do a thing']).flags.model).toBe('from/flag')
    const config = resolveConfig({ model: 'from/flag' })
    expect(config.model).toBe('from/flag')
  })
})

describe('config set', () => {
  it('persists a model as the default', async () => {
    expect(await setConfig(['model', 'auto/eco'])).toBe(0)
    const stored = JSON.parse(readFileSync(join(home, '.jarvisclaw', 'config.json'), 'utf8'))
    expect(stored.model).toBe('auto/eco')
    expect(resolveConfig().model).toBe('auto/eco')
  })

  it('accepts a specific paid model, not just a route', async () => {
    expect(await setConfig(['model', 'anthropic/claude-opus-4.8'])).toBe(0)
    expect(resolveConfig().model).toBe('anthropic/claude-opus-4.8')
  })

  it('does not validate the model against the catalogue', async () => {
    // Validating would need a network round-trip to succeed, and would reject a
    // model the gateway added after this CLI shipped. A wrong name fails at the
    // point of use with the gateway's own error, which is more accurate.
    expect(await setConfig(['model', 'nonexistent/model'])).toBe(0)
    expect(resolveConfig().model).toBe('nonexistent/model')
  })

  it('persists spend ceilings as numbers', async () => {
    expect(await setConfig(['max-call', '0.25'])).toBe(0)
    expect(await setConfig(['max-spend', '5'])).toBe(0)
    const stored = JSON.parse(readFileSync(join(home, '.jarvisclaw', 'config.json'), 'utf8'))
    expect(stored.maxCallUsd).toBe(0.25)
    expect(stored.maxSpendUsd).toBe(5)
  })

  it('rejects a ceiling that is not a number rather than storing nothing', async () => {
    // Silently ignoring this would leave someone believing they set a limit.
    expect(await setConfig(['max-call', 'cheap'])).toBe(2)
    // Nothing is written at all, so there may be no file yet — which is itself the
    // assertion. Reading it directly would throw ENOENT and pass for the wrong
    // reason on a first run.
    expect(resolveConfig().maxCallUsd).toBeUndefined()
  })

  it('rejects a negative ceiling', async () => {
    expect(await setConfig(['max-spend', '-1'])).toBe(2)
  })

  it('refuses to store a credential, pointing at setup instead', async () => {
    // `setup` is where the hot-wallet tradeoff is explained; a bare `config set
    // api-key` would put a secret in shell history with no such warning.
    expect(await setConfig(['api-key', 'sk-secret'])).toBe(2)
    expect(await setConfig(['wallet-key', '0xdead'])).toBe(2)
    let contents = ''
    try {
      contents = readFileSync(join(home, '.jarvisclaw', 'config.json'), 'utf8')
    } catch {
      contents = ''
    }
    expect(contents).not.toContain('sk-secret')
    expect(contents).not.toContain('0xdead')
  })

  it('rejects an unknown key and a missing value', async () => {
    expect(await setConfig(['nonsense', 'x'])).toBe(2)
    expect(await setConfig(['model'])).toBe(2)
    expect(await setConfig([])).toBe(2)
  })

  it('does not clobber other settings', async () => {
    await setConfig(['max-call', '0.5'])
    await setConfig(['model', 'auto/premium'])
    const stored = JSON.parse(readFileSync(join(home, '.jarvisclaw', 'config.json'), 'utf8'))
    expect(stored.maxCallUsd).toBe(0.5)
    expect(stored.model).toBe('auto/premium')
  })
})
