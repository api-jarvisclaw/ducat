/**
 * Argument parsing.
 *
 * Hand-rolled rather than a dependency: the grammar is small, and `npx jarvisclaw`
 * on a cold cache is the first impression this tool makes.
 */

export interface ParsedArgs {
  command: string
  /** Positional arguments after the command. */
  rest: string[]
  flags: {
    apiKey?: string
    walletKey?: string
    baseUrl?: string
    model?: string
    maxCallUsd?: number
    category?: string
    help: boolean
    version: boolean
  }
  /** A flag that was given wrongly, e.g. a value missing or unparseable. */
  error?: string
}

const KNOWN_COMMANDS = new Set([
  'run',
  'chat',
  'login',
  'logout',
  'search',
  'models',
  'agents',
  'balance',
  'config',
  'help',
])

/** Flags that take a value. */
const VALUE_FLAGS: Record<string, keyof ParsedArgs['flags']> = {
  '--api-key': 'apiKey',
  '--wallet-key': 'walletKey',
  '--base-url': 'baseUrl',
  '--model': 'model',
  '-m': 'model',
  '--max-call': 'maxCallUsd',
  '--category': 'category',
  '-c': 'category',
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: ParsedArgs['flags'] = { help: false, version: false }
  const positional: string[] = []
  let error: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!

    if (arg === '--help' || arg === '-h') {
      flags.help = true
      continue
    }
    if (arg === '--version' || arg === '-v') {
      flags.version = true
      continue
    }

    // --flag=value as well as --flag value, since both are habitual.
    const eq = arg.indexOf('=')
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg
    const key = VALUE_FLAGS[name]

    if (key) {
      const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : undefined
      const value = inline ?? argv[++i]
      if (value === undefined || (inline === undefined && value.startsWith('-'))) {
        error ??= `${name} needs a value`
        continue
      }
      if (key === 'maxCallUsd') {
        const parsed = Number(value)
        // Rejected rather than ignored: silently dropping a spend ceiling the user
        // asked for would leave them believing a limit is in force when it is not.
        if (!Number.isFinite(parsed) || parsed <= 0) {
          error ??= `--max-call needs a positive number of USD, got ${JSON.stringify(value)}`
          continue
        }
        flags.maxCallUsd = parsed
      } else {
        flags[key] = value as never
      }
      continue
    }

    if (arg.startsWith('-') && arg !== '-') {
      error ??= `unknown flag ${arg}`
      continue
    }

    positional.push(arg)
  }

  // `jarvisclaw "do a thing"` has to work, so a first positional that is not a
  // known command is treated as the task rather than rejected.
  const first = positional[0]
  const isCommand = first !== undefined && KNOWN_COMMANDS.has(first)
  const command = isCommand ? first : first === undefined ? 'chat' : 'run'
  const rest = isCommand ? positional.slice(1) : positional

  return { command, rest, flags, ...(error ? { error } : {}) }
}

export const HELP = `jarvisclaw — a terminal agent that calls things, not just chats

USAGE
  jarvisclaw "<task>"          do something, then exit
  jarvisclaw                   interactive session
  jarvisclaw <command> [args]

COMMANDS
  login                        store an API key or wallet key
  logout                       remove the stored credential
  search <query>               browse the API catalogue (no login needed)
  models                       list the models this gateway serves
  agents [query]               other agents on the platform
  balance                      what is spendable
  config                       settings in effect, and where they came from

OPTIONS
  -m, --model <id>             model or virtual route (default: auto/free)
  -c, --category <name>        narrow a search
      --max-call <usd>         refuse any single call above this
      --api-key <key>          use this key for one invocation
      --wallet-key <key>       use this wallet for one invocation
      --base-url <url>         a different gateway
  -h, --help                   this text
  -v, --version                version

ENVIRONMENT
  JARVISCLAW_API_KEY           api key
  JARVISCLAW_WALLET_KEY        wallet private key (EVM hex or Solana base58)
  JARVISCLAW_BASE_URL          gateway url
  JARVISCLAW_MODEL             default model
  NO_COLOR                     disable colour

EXAMPLES
  jarvisclaw "what can you do?"
  jarvisclaw "find a weather api and check the forecast for Tokyo"
  jarvisclaw search blockchain
  jarvisclaw -m auto/premium "summarise this repo's architecture"

Paid calls are always confirmed before they run. Searching and browsing are free.
`
