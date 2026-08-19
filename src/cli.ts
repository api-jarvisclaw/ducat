/**
 * The `ducat` executable.
 *
 * Nothing but the invocation: `main` lives in main.ts so tests and library
 * consumers can import it without starting a session or calling process.exit.
 */
import { main } from './main.js'
import { say, style } from './ui.js'

// This module is the bin entry, so it runs on import. Tests import `main` from
// `./index.js`, which re-exports it without this side effect.
main(process.argv.slice(2))
  .then(finish)
  .catch((err: unknown) => {
    say(`${style.red('✗')} ${String(err)}`)
    finish(1)
  })

/**
 * Set the exit code and let the loop drain, rather than calling process.exit.
 *
 * `process.exit()` immediately after a failed request aborted the process with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` on Windows — libuv
 * tearing down while an undici socket was still closing. It printed after the
 * error message, so a plain 401 looked like a crash in the tool.
 *
 * Setting exitCode alone can leave the process hanging on undici's keep-alive
 * sockets, so the handles are unreferenced first: that lets Node exit once the
 * real work is done without cutting a closing handle short.
 */
function finish(code: number): void {
  process.exitCode = code
  const active = (
    process as unknown as { _getActiveHandles?: () => Array<{ unref?: () => void }> }
  )._getActiveHandles?.()
  for (const handle of active ?? []) handle.unref?.()
}
