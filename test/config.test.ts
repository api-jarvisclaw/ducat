import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import {
  DEFAULT_GATEWAY,
  DEFAULT_MODEL,
  maskSecret,
  resolveConfig,
  usdToBaseUnits,
  writeConfig,
} from '../src/config.js'

const ENV_KEYS = [
  'JARVISCLAW_API_KEY',
  'JARVISCLAW_WALLET_KEY',
  'JARVISCLAW_BASE_URL',
  'JARVISCLAW_MODEL',
] as const

let home: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  // A real HOME would read the developer's own credentials into these assertions
  // and, worse, writeConfig would overwrite their config file.
  home = mkdtempSync(join(tmpdir(), 'jc-test-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)

  saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(home, { recursive: true, force: true })
})

describe('resolveConfig precedence', () => {
  it('defaults to the public gateway and the free model', () => {
    const config = resolveConfig()
    expect(config.baseUrl).toBe(DEFAULT_GATEWAY)
    expect(config.model).toBe(DEFAULT_MODEL)
    expect(config.source.credential).toBe('none')
  })

  it('defaults to a free model so a first run cannot cost anything', () => {
    // A paid default would charge someone who typed one command to try the tool.
    expect(DEFAULT_MODEL).toContain('free')
  })

  it('reads a credential from the environment', () => {
    process.env['JARVISCLAW_API_KEY'] = 'sk-env'
    const config = resolveConfig()
    expect(config.apiKey).toBe('sk-env')
    expect(config.source.credential).toBe('env')
  })

  it('lets a flag beat the environment', () => {
    // A forgotten export in someone's shell must not override what they just typed.
    process.env['JARVISCLAW_API_KEY'] = 'sk-env'
    const config = resolveConfig({ apiKey: 'sk-flag' })
    expect(config.apiKey).toBe('sk-flag')
    expect(config.source.credential).toBe('flag')
  })

  it('lets the environment beat the config file', () => {
    writeConfig({ apiKey: 'sk-file' })
    process.env['JARVISCLAW_API_KEY'] = 'sk-env'
    const config = resolveConfig()
    expect(config.apiKey).toBe('sk-env')
    expect(config.source.credential).toBe('env')
  })

  it('falls back to the config file when nothing else is set', () => {
    writeConfig({ apiKey: 'sk-file', model: 'gpt-5' })
    const config = resolveConfig()
    expect(config.apiKey).toBe('sk-file')
    expect(config.model).toBe('gpt-5')
    expect(config.source.credential).toBe('file')
  })

  it('strips a trailing slash from the gateway URL', () => {
    const config = resolveConfig({ baseUrl: 'https://gw.test/' })
    expect(config.baseUrl).toBe('https://gw.test')
  })

  it('treats an empty config file as a first run rather than an error', () => {
    const config = resolveConfig()
    expect(config.source.credential).toBe('none')
  })
})

describe('writeConfig', () => {
  it('stores the file with owner-only permissions', () => {
    // A wallet key in a 644 file is readable by every other account on a shared
    // machine.
    const path = writeConfig({ walletKey: '0xabc' })
    const mode = statSync(path).mode & 0o777
    // Windows does not implement POSIX modes; the assertion is meaningful on POSIX
    // and vacuous elsewhere rather than a spurious failure.
    if (process.platform !== 'win32') expect(mode).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ walletKey: '0xabc' })
  })
})

describe('usdToBaseUnits', () => {
  it('converts USD to 6-decimal USDC base units', () => {
    expect(usdToBaseUnits(1)).toBe(1_000_000n)
    expect(usdToBaseUnits(0.0115)).toBe(11_500n)
  })

  it('rounds rather than truncating a sub-unit amount', () => {
    // Truncating 0.0000005 to zero would reject every payment instead of
    // permitting a very small one — the opposite of what the user asked for.
    expect(usdToBaseUnits(0.0000005)).toBe(1n)
  })
})

describe('maskSecret', () => {
  it('never returns the full secret', () => {
    const secret = 'sk-1234567890abcdef'
    const masked = maskSecret(secret)
    expect(masked).not.toBe(secret)
    expect(masked).not.toContain('7890abc')
  })

  it('fully masks a short secret rather than revealing most of it', () => {
    expect(maskSecret('short')).toBe('•••••')
  })
})

describe('parseArgs', () => {
  it('treats a bare quoted task as a run', () => {
    const args = parseArgs(['find a weather api'])
    expect(args.command).toBe('run')
    expect(args.rest).toEqual(['find a weather api'])
  })

  it('starts an interactive session with no arguments', () => {
    expect(parseArgs([]).command).toBe('chat')
  })

  it('recognises the named commands', () => {
    for (const cmd of ['login', 'logout', 'search', 'models', 'agents', 'balance', 'config']) {
      expect(parseArgs([cmd]).command).toBe(cmd)
    }
  })

  it('accepts --flag value and --flag=value alike', () => {
    expect(parseArgs(['--model', 'gpt-5', 'x']).flags.model).toBe('gpt-5')
    expect(parseArgs(['--model=gpt-5', 'x']).flags.model).toBe('gpt-5')
    expect(parseArgs(['-m', 'gpt-5', 'x']).flags.model).toBe('gpt-5')
  })

  it('parses a spend ceiling', () => {
    expect(parseArgs(['--max-call', '0.05', 'x']).flags.maxCallUsd).toBe(0.05)
  })

  it('rejects an unparseable spend ceiling instead of ignoring it', () => {
    // Silently dropping it would leave the user believing a limit is in force.
    const args = parseArgs(['--max-call', 'cheap', 'x'])
    expect(args.error).toMatch(/--max-call needs a positive number/)
    expect(args.flags.maxCallUsd).toBeUndefined()
  })

  it('rejects a zero or negative ceiling', () => {
    expect(parseArgs(['--max-call', '0', 'x']).error).toBeTruthy()
    expect(parseArgs(['--max-call', '-1', 'x']).error).toBeTruthy()
  })

  it('reports a flag whose value is missing', () => {
    expect(parseArgs(['--model']).error).toMatch(/--model needs a value/)
    expect(parseArgs(['--model', '--help']).error).toMatch(/--model needs a value/)
  })

  it('reports an unknown flag rather than treating it as a task', () => {
    expect(parseArgs(['--turbo', 'x']).error).toMatch(/unknown flag --turbo/)
  })

  it('handles help and version', () => {
    expect(parseArgs(['--help']).flags.help).toBe(true)
    expect(parseArgs(['-h']).flags.help).toBe(true)
    expect(parseArgs(['--version']).flags.version).toBe(true)
    expect(parseArgs(['-v']).flags.version).toBe(true)
  })

  it('keeps command arguments separate from flags', () => {
    const args = parseArgs(['search', 'weather', 'api', '--category', 'geo'])
    expect(args.command).toBe('search')
    expect(args.rest).toEqual(['weather', 'api'])
    expect(args.flags.category).toBe('geo')
  })
})
