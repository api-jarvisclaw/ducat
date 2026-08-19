/**
 * The rename from jarvisclaw to ducat left `Run \`jarvisclaw --help\` for usage.`
 * behind in the unknown-flag handler, along with 14 other stale references. A user
 * following that line types a command that does not exist. Only `--help` had been
 * updated, so nothing caught it — the help text is what gets read during a rename,
 * and every other string is what gets forgotten.
 *
 * This asserts on the strings themselves rather than on rendered output, because the
 * failure mode is a literal that no test happens to print.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HELP } from '../src/index.js'
import pkg from '../package.json' with { type: 'json' }

/** The name the shell resolves — the only name a user can actually type. */
const BIN = Object.keys(pkg.bin)[0]!

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (entry.endsWith('.ts')) out.push(path)
  }
  return out
}

describe('the executable name', () => {
  it('is what package.json declares as the bin', () => {
    expect(BIN).toBe('ducat')
    expect(pkg.name).toBe(BIN)
  })

  it('is the name the help text tells people to type', () => {
    expect(HELP).toContain(`${BIN} "<task>"`)
    expect(HELP.split('\n')[0]).toMatch(new RegExp(`^${BIN}\\b`))
  })

  it('is the only command name in any user-facing string under src/', () => {
    // Brand references are the platform, not the command, and must survive — matching
    // those would make this test demand their removal, which project policy forbids.
    // `JarvisClaw gateway`/`platform` counts: capitalised and followed by a noun, it
    // names the service the agent talks to, not something a user types.
    const brand =
      /jarvisclaw\.ai|jarvisclaw-ai|api-jarvisclaw|jarvisclaw-chat|JarvisClaw (?:gateway|platform|account|API)/
    const offenders: string[] = []

    for (const file of sourceFiles('src')) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/\bjarvisclaw\b/i.test(line)) return
        // Strip the allowed forms, then see if a bare `jarvisclaw` is left over.
        if (/\bjarvisclaw\b/i.test(line.replace(new RegExp(brand.source, 'gi'), ''))) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }

    expect(offenders, `stale command name; the bin is \`${BIN}\``).toEqual([])
  })

  it('appears in the unknown-flag hint, since that hint is a command to run', () => {
    const main = readFileSync(join('src', 'main.ts'), 'utf8')
    const hint = main.split('\n').find((l) => l.includes('--help') && l.includes('usage'))
    expect(hint, 'the unknown-flag hint went missing').toBeDefined()
    expect(hint).toContain(`${BIN} --help`)
  })
})
