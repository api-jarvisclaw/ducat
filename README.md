# ducat

A terminal AI agent with its own wallet. It calls things instead of describing them.

```bash
npx ducat "what's the weather in Tokyo right now?"
```

One sentence. It works out that it needs an API, searches a catalogue of a few
thousand, reads the real spec, and reports back:

```
I can get Tokyo's current weather using the Weather Current City API
for $0.011500 per call. Would you like me to proceed?

used: search_apis → search_apis → get_api_detail
```

You never look up an endpoint, a schema or a price yourself.

## Install

```bash
npx ducat            # no install
npm install -g ducat
```

Node 20 or newer.

## Try it with no setup at all

Free models and browsing need no account, no key, no wallet:

```bash
ducat "explain what x402 is"      # runs on a free model
ducat search weather
ducat models                       # marks which models are free
ducat agents
```

## Then pick how paid calls get paid

```bash
ducat setup
```

Two ways, and it asks which:

**A wallet on this machine.** ducat generates one. You send USDC to it from your
own wallet, and that transfer is the only approval that matters — signed in your
wallet, for an amount you chose. No account, no signup, keys stay here.

**A jarvisclaw.ai account.** Your account balance pays. Top up on the website,
where the history and receipts live.

Note what ducat never does: ask for a private key you already have. That prompt is
what phishing imitates, and such a key would grant far more than a per-call budget
needs.

## Funding the wallet

```bash
ducat wallet     # shows your address
ducat balance    # on-chain USDC, once it lands
```

Send **USDC on Base**. You do not need ETH — the gateway pays the gas. Start with a
couple of dollars; most calls cost a fraction of a cent.

It is a hot wallet in `~/.ducat/wallet.json`, mode `0600`. Anything in it can be
spent by this machine, and if the file is lost the funds are gone — no recovery, no
support desk. Keep only what you are willing to spend.

## Spending

Small calls just run. You are told, not asked:

```
  paying $0.001380 — City Weather (federation/456) POST
```

Two ceilings decide when a question is warranted:

| | default | behaviour |
| --- | --- | --- |
| `--max-call <usd>` | 0.05 | above this, one call gets confirmed |
| `--max-spend <usd>` | 1 | the session stops here — refused, not prompted |

```bash
ducat --max-spend 0.20 "compare three image apis on price"
ducat --confirm-all "spend carefully"        # ask about everything
```

A price that cannot be read is always confirmed. The session limit denies rather
than prompting, because a limit a tired user can click past is not a limit. And the
real ceiling is the wallet: it holds only what you put in it.

Piped or non-interactive runs decline anything needing confirmation rather than
spending unattended.

## What it can actually do

| tool | cost | what it does |
| --- | --- | --- |
| `search_apis` | free | search thousands of callable endpoints |
| `get_api_detail` | free | one API's real spec, price and method |
| `list_models` | free | what the gateway serves, free ones marked |
| `discover_agents` | free | other agents, for delegating work |
| `resolve_intent` | setup | given an intent type, which providers serve it |
| `check_balance` | setup | what is spendable |
| `call_api` | **paid** | invoke an API, within the ceilings above |

The agent picks among these itself. None of it is a snapshot: model ids, categories,
prices and specs are read from the gateway at call time, so it cannot act on a stale
catalogue.

The three cost tiers were checked against the gateway rather than assumed. **free**
works with nothing configured. **setup** costs nothing but the gateway answers 402
without a credential, so those tools are withheld from a session that has none —
offering them would produce a payment error for something you never asked to buy.

## Where settings live

Precedence: flag, then environment, then `~/.ducat/config.json`, then the generated
wallet. An explicit flag always wins, so a forgotten `export` cannot quietly
override what you typed. `ducat config` prints what is in effect and where each
value came from.

| variable | meaning |
| --- | --- |
| `DUCAT_API_KEY` | api key |
| `DUCAT_WALLET_KEY` | wallet private key, for one run |
| `DUCAT_BASE_URL` | a different gateway |
| `DUCAT_MODEL` | default model |
| `NO_COLOR` | disable colour |

## As a library

```ts
import { PlatformClient, run, SpendPolicy } from 'ducat'

const client = await PlatformClient.create({ apiKey: 'sk-...' })
const policy = new SpendPolicy({ sessionLimitUsd: 0.5 })

const result = await run('find a weather api for Tokyo', {
  client,
  model: 'auto/free',
  confirm: async ({ priceUsd }) => policy.evaluate(priceUsd).decision === 'allow',
  log: console.log,
})
```

`confirm` is where the spending policy lives, so an embedding application sets its
own rather than inheriting the CLI's prompts.

Payments and transport come from
[`@jarvisclaw-ai/sdk`](https://github.com/api-jarvisclaw/ts-sdk), usable on its own.

## Development

```bash
npm install
npm run dev -- "a task"
npm test
npm run typecheck
```

The gateway is stubbed by path rather than by call order, since the agent varies how
many free lookups it makes before a paid one and a reordering is not a regression.

The parts that touch money are checked by mutation — the suite has to fail when they
break. Marking `call_api` free, dropping the approval guard, trusting a remembered
price instead of re-reading it, generating a fixed key instead of a random one,
regenerating over a funded wallet, and turning the session limit into a prompt all
fail tests.

Some bugs only a live gateway found: `/v1/models` needs a credential where
`/api/discovery/models` does not; a placeholder API key is rejected where sending no
header succeeds; and reasoning models spend their whole output budget thinking
unless given a larger one, returning prose instead of the tool call. Those are the
reason the verification chain ends at a real request.

## License

MIT
