/**
 * Assert the stored config is owner-only. POSIX runners only.
 *
 * This is a script rather than a vitest case because the guarantee it checks
 * cannot be observed on Windows: `statSync` there reports 666 for every file
 * whatever mode was requested, so the equivalent assertion in config.test.ts is
 * skipped on win32 and a regression would pass unnoticed on a developer machine.
 * Running it as a separate CI step on Linux is what makes the check real.
 *
 *     npx tsx test/check-permissions.ts
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeConfig } from '../src/config.js'

if (process.platform === 'win32') {
  console.log('skipped: Windows does not implement POSIX file modes')
  process.exit(0)
}

const home = mkdtempSync(join(tmpdir(), 'jc-perm-'))
process.env['HOME'] = home

try {
  const path = writeConfig({ walletKey: '0xnot-a-real-key' })
  const mode = statSync(path).mode & 0o777

  if (mode !== 0o600) {
    console.error(
      `${path} has mode 0${mode.toString(8)}, expected 0600.\n` +
        'This file holds a wallet private key. Any other account on the machine ' +
        'can read it at this mode.',
    )
    process.exit(1)
  }
  console.log(`ok: ${path} is 0600`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
