/**
 * A rename to `ducat` once left `Run \`jarvisclaw --help\` for usage.` behind in the
 * unknown-flag handler, along with 14 other stale references. A user following that
 * line types a command that does not exist. Only `--help` had been updated, so
 * nothing caught it — the help text is what gets read during a rename, and every
 * other string is what gets forgotten.
 *
 * The name then had to change again: npm refused `ducat` with "Package name too
 * similar to existing package uyat", so the published name is `jarvisclaw`. Two
 * renames in one day is the argument for this file existing.
 *
 * It asserts on the strings themselves rather than on rendered output, because the
 * failure mode is a literal that no test happens to print.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HELP } from '../src/index.js'
import pkg from '../package.json' with { type: 'json' }

/** The name the shell resolves — the only name a user can actually type. */
const BIN = Object.keys(pkg.bin)[0]!

/**
 * Every name this CLI has been called or considered. Listed explicitly because "a
 * word that looks like a command" is not detectable, and because the check has to
 * work in both directions: whichever of these is the bin, the others are stale.
 */
const KNOWN_NAMES = ['jarvisclaw', 'ducat', 'ducat-cli', 'jarvisclaw-cli', 'ducatcli', 'jclaw']

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
    expect(BIN).toBe('jarvisclaw')
    expect(pkg.name).toBe(BIN)
    expect(KNOWN_NAMES).toContain(BIN)
  })

  it('is the name the help text tells people to type', () => {
    expect(HELP).toContain(`${BIN} "<task>"`)
    expect(HELP.split('\n')[0]).toMatch(new RegExp(`^${BIN}\\b`))
  })

  it('is the only command name in any user-facing string under src/', () => {
    const stale = KNOWN_NAMES.filter((n) => n !== BIN)
    const offenders: string[] = []

    for (const file of sourceFiles('src')) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const name of stale) {
          // Word boundary so a name does not match inside an unrelated identifier,
          // and case-insensitive because prose capitalises the start of a sentence.
          if (new RegExp(`\\b${name}\\b`, 'i').test(line)) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`)
          }
        }
      })
    }

    expect(offenders, `stale command name; the bin is \`${BIN}\``).toEqual([])
  })

  it('is the name of the dotdir holding config and the wallet', () => {
    // The dotdir carries the command name too, and it is the one place a stale name
    // stays invisible until someone loses access to a funded wallet: a rename that
    // misses it keeps writing to ~/.ducat while every message says jarvisclaw.
    for (const file of ['src/config.ts', 'src/wallet.ts']) {
      const text = readFileSync(file, 'utf8')
      const dotdirs = text.match(/'\.[a-z][a-z0-9-]*'/gi) ?? []
      expect(dotdirs.length, `${file} names no dotdir; this check went blind`).toBeGreaterThan(0)
      for (const dir of dotdirs) {
        expect(dir, `${file} uses ${dir}, not '.${BIN}'`).toBe(`'.${BIN}'`)
      }
    }
  })

  it('is the prefix of every environment variable', () => {
    // A rename that leaves DUCAT_API_KEY behind means a documented variable silently
    // does nothing — the credential is simply not found and the user sees "no
    // credential" while believing they exported one.
    const prefix = `${BIN.toUpperCase()}_`
    for (const file of sourceFiles('src')) {
      const vars = readFileSync(file, 'utf8').match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g) ?? []
      for (const name of vars) {
        // Only names that look like this CLI's own variables; NO_COLOR and the like
        // belong to the environment, not to us.
        if (!KNOWN_NAMES.some((n) => name.startsWith(`${n.toUpperCase()}_`))) continue
        expect(name, `${file} references ${name}, not ${prefix}*`).toMatch(
          new RegExp(`^${prefix}`),
        )
      }
    }
  })

  it('appears in the unknown-flag hint, since that hint is a command to run', () => {
    const main = readFileSync(join('src', 'main.ts'), 'utf8')
    const hint = main.split('\n').find((l) => l.includes('--help') && l.includes('usage'))
    expect(hint, 'the unknown-flag hint went missing').toBeDefined()
    expect(hint).toContain(`${BIN} --help`)
  })
})
