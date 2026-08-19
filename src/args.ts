/**
 * Argument parsing.
 *
 * Hand-rolled rather than a dependency: the grammar is small, and `npx ducat`
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
    maxSpendUsd?: number
    category?: string
    help: boolean
    version: boolean
    confirmAll: boolean
    all: boolean
  }
  /** A flag that was given wrongly, e.g. a value missing or unparseable. */
  error?: string
}

const KNOWN_COMMANDS = new Set([
  'run',
  'chat',
  'setup',
  'wallet',
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
  '--max-spend': 'maxSpendUsd',
  '--category': 'category',
  '-c': 'category',
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: ParsedArgs['flags'] = {
    help: false,
    version: false,
    confirmAll: false,
    all: false,
  }
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
    if (arg === '--confirm-all') {
      flags.confirmAll = true
      continue
    }
    if (arg === '--all') {
      flags.all = true
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
      if (key === 'maxCallUsd' || key === 'maxSpendUsd') {
        const parsed = Number(value)
        // Rejected rather than ignored: silently dropping a spend ceiling the user
        // asked for would leave them believing a limit is in force when it is not.
        if (!Number.isFinite(parsed) || parsed <= 0) {
          error ??= `${name} needs a positive number of USD, got ${JSON.stringify(value)}`
          continue
        }
        flags[key] = parsed
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

  // `ducat "do a thing"` has to work, so a first positional that is not a
  // known command is treated as the task rather than rejected.
  const first = positional[0]
  const isCommand = first !== undefined && KNOWN_COMMANDS.has(first)
  const command = isCommand ? first : first === undefined ? 'chat' : 'run'
  const rest = isCommand ? positional.slice(1) : positional

  return { command, rest, flags, ...(error ? { error } : {}) }
}

export const HELP = `ducat — a terminal agent with its own wallet

USAGE
  ducat "<task>"               do something, then exit
  ducat                        interactive session
  ducat <command> [args]

COMMANDS
  setup                        create a wallet, or use a jarvisclaw.ai key
  wallet                       your address, and how to fund it
  balance                      what is spendable
  search <query>               browse the API catalogue (no setup needed)
  models                       routes and models, cheapest first
  agents [query]               other agents on the platform
  config                       settings in effect, and where they came from
  config set <key> <value>     change a default (model, max-call, max-spend)
  logout                       remove a stored credential

MODELS
  Smart routing picks a model per request, reading the prompt first:
    auto                       balanced — the default once you have a credential
    auto/free                  free models only — the default before setup
    auto/eco                   cheapest paid models
    auto/premium               strongest models, highest cost
  Or name one yourself: ducat -m anthropic/claude-sonnet-4.6 "<task>"
  See what is available with \`ducat models\`.

OPTIONS
  -m, --model <id>             model or smart route (default: auto, or auto/free
                               before setup)
  -c, --category <name>        narrow a search
      --all                    with \`models\`, list every paid model
      --max-call <usd>         confirm any single call above this (default 0.05)
      --max-spend <usd>        stop the session at this total (default 1)
      --confirm-all            confirm every paid call, however small
      --api-key <key>          use this key for one invocation
      --wallet-key <key>       use this wallet for one invocation
      --base-url <url>         a different gateway
  -h, --help                   this text
  -v, --version                version

ENVIRONMENT
  DUCAT_API_KEY                api key
  DUCAT_WALLET_KEY             wallet private key
  DUCAT_BASE_URL               gateway url
  DUCAT_MODEL                  default model
  NO_COLOR                     disable colour

EXAMPLES
  ducat "what's the weather in Tokyo right now?"
  ducat "find a cheap web search api and look up x402"
  ducat search blockchain
  ducat --max-spend 0.20 "compare three image apis on price"
  ducat -m auto/premium "review this architecture and name the weak points"
  ducat config set model auto/eco

Free models and browsing need no setup at all. Paid calls come out of a wallet
ducat creates for you — it holds only what you send it.
`
