/** Command dispatch. Importable without side effects; `cli.ts` is the executable. */
import { HELP, parseArgs } from './args.js'
import { agents, balance, models, search, setConfig, showConfig } from './commands/browse.js'
import { logout } from './commands/login.js'
import { setup } from './commands/setup.js'
import { wallet } from './commands/wallet.js'
import { runInteractive, runOnce } from './commands/run.js'
import { resolveConfig } from './config.js'
import { note, say, style } from './ui.js'

const VERSION = '0.1.0'

/** Run one invocation and return the process exit code. Never calls process.exit. */
export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)

  if (args.error) {
    say(`${style.red('✗')} ${args.error}`)
    note('Run `jarvisclaw --help` for usage.')
    return 2
  }
  if (args.flags.version) {
    say(VERSION)
    return 0
  }
  if (args.flags.help || args.command === 'help') {
    say(HELP)
    return 0
  }

  const config = resolveConfig({
    ...(args.flags.apiKey ? { apiKey: args.flags.apiKey } : {}),
    ...(args.flags.walletKey ? { walletKey: args.flags.walletKey } : {}),
    ...(args.flags.baseUrl ? { baseUrl: args.flags.baseUrl } : {}),
    ...(args.flags.model ? { model: args.flags.model } : {}),
    ...(args.flags.maxCallUsd === undefined ? {} : { maxCallUsd: args.flags.maxCallUsd }),
    ...(args.flags.maxSpendUsd === undefined ? {} : { maxSpendUsd: args.flags.maxSpendUsd }),
  })

  switch (args.command) {
    case 'setup':
      return setup(config)
    case 'wallet':
      return wallet()
    // `login` is the word people type; setup is what it does.
    case 'login':
      return setup(config)
    case 'logout':
      return logout()
    case 'search':
      return search(args.rest.join(' '), config, {
        ...(args.flags.category ? { category: args.flags.category } : {}),
      })
    case 'models':
      return models(config, args.flags.all ? { all: true } : {})
    case 'agents':
      return agents(config, args.rest.length > 0 ? { search: args.rest.join(' ') } : {})
    case 'balance':
      return balance(config)
    case 'config':
      // `config` reports, `config set` writes. Subcommand rather than a flag so the
      // reporting form stays the bare word, which is what people reach for first.
      return args.rest[0] === 'set' ? setConfig(args.rest.slice(1)) : showConfig(config)
    case 'chat':
      return runInteractive(config)
    case 'run': {
      const prompt = args.rest.join(' ').trim()
      if (!prompt) {
        say(`${style.red('✗')} No task given.`)
        note('Try: jarvisclaw "find a weather api and check Tokyo"')
        return 2
      }
      return runOnce(prompt, config)
    }
    default:
      say(`${style.red('✗')} Unknown command: ${args.command}`)
      return 2
  }
}
