# jarvisclaw

A terminal agent that calls things instead of describing them.

```bash
npx jarvisclaw "find a weather api and check the forecast for Tokyo"
```

It searches the live catalogue, reads the API's real spec, shows you the price,
and — once you say yes — calls it and reports what came back.

**No account, no key, no signup to start.** The gateway serves a free tier to
requests with no credential, so the command above works on a machine that has never
heard of JarvisClaw. Paid APIs need a credential; browsing and free models do not.

## Install

```bash
npx jarvisclaw           # no install
npm install -g jarvisclaw
```

Node 20 or newer.

## Try it before signing up

These need no credential at all:

```bash
jarvisclaw "explain what x402 is"       # runs on a free model
jarvisclaw search weather
jarvisclaw search blockchain --category blockchain
jarvisclaw models                        # marks which models are free
jarvisclaw agents
```

Without a credential the model is forced to `auto/free` and paid APIs are refused,
which the CLI says out loud rather than failing obscurely.

## Then log in, for paid models and APIs

```bash
jarvisclaw login
```

Two ways in:

- **API key** — an account on the gateway pays for calls. Get one at
  [jarvisclaw.ai](https://jarvisclaw.ai).
- **Wallet key** — your own USDC pays per call over x402, no account at all. An
  EVM (Base) key or a Solana one in base58.

Login checks the credential and reports your balance, so a bad key is a one-line
fix rather than a confusing failure halfway through a task.

## Use it

```bash
jarvisclaw "what can you do?"                 # one task, then exit
jarvisclaw                                     # interactive session
jarvisclaw -m auto/premium "explain x402"     # pick a model
```

The default model is `auto/free`, so a first run costs nothing. `auto`, `auto/eco`
and `auto/premium` let the gateway choose; `jarvisclaw models` lists the specific
ids.

## What it can actually do

| tool | cost | what it does |
| --- | --- | --- |
| `search_apis` | free | search thousands of callable endpoints |
| `get_api_detail` | free | one API's real spec, price and method |
| `list_models` | free | what the gateway serves right now |
| `discover_agents` | free | other agents, for delegating work |
| `resolve_intent` | login | given an intent type, which providers serve it |
| `check_balance` | login | what is spendable |
| `call_api` | **paid** | invoke an API, after you approve the price |

The agent chooses among these itself. Nothing in that list is hardcoded from a
snapshot: model ids, categories, prices and specs are read from the gateway at call
time, so the agent cannot act on a stale catalogue.

The three columns are a real distinction, checked against the gateway rather than
assumed. **free** works with no credential. **login** costs nothing but the gateway
answers 402 without a credential, so those tools are withheld from an anonymous
session entirely — offering them would send the agent into a payment error for
something the user never asked to buy. **paid** spends money and is always
confirmed.

## Spending

Every paid call is confirmed first, with the price read from the catalogue at that
moment rather than whatever the model remembered:

```
$ City Weather (federation/456) POST
  cost $0.0115
  Run it? [y/N]
```

The default is no. Declining is not an error — the agent is told and carries on.

A per-call ceiling is available, and refuses anything above it before signing:

```bash
jarvisclaw --max-call 0.05 "call the cheapest search api you can find"
```

Piped or non-interactive invocations decline automatically rather than spending
unattended. A run that would cost money needs a terminal.

## Where settings live

Precedence: flag, then environment, then `~/.jarvisclaw/config.json`. An explicit
flag always wins, so a forgotten `export` cannot quietly override what you typed.
`jarvisclaw config` prints what is in effect and where each value came from.

| variable | meaning |
| --- | --- |
| `JARVISCLAW_API_KEY` | api key |
| `JARVISCLAW_WALLET_KEY` | wallet private key |
| `JARVISCLAW_BASE_URL` | a different gateway |
| `JARVISCLAW_MODEL` | default model |
| `NO_COLOR` | disable colour |

The config file is written `0600`. It can hold a wallet key, which is a key that
spends money — treat it accordingly, and prefer the environment variable on a
shared machine.

## As a library

```ts
import { PlatformClient, run, tools } from 'jarvisclaw'

const client = await PlatformClient.create({ apiKey: 'sk-...' })
const result = await run('find a weather api for Tokyo', {
  client,
  model: 'auto/free',
  confirm: async ({ priceUsd }) => (priceUsd ?? 0) < 0.05,  // your own policy
  log: console.log,
})
```

`confirm` is where the spending policy lives, so an embedding application decides
for itself rather than inheriting the CLI's prompt.

Payments and transport come from
[`@jarvisclaw/sdk`](https://github.com/api-jarvisclaw/ts-sdk), which is usable on
its own.

## Development

```bash
npm install
npm run dev -- "a task"
npm test
npm run typecheck
```

The tests stub the gateway by path rather than by call order, since the agent
legitimately varies how many free lookups it makes before a paid call and a
reordering is not a regression. The spend-consent path is the part most worth
trusting, so it is checked by mutation: marking `call_api` free, dropping the
`if (!approved)` guard, trusting the model's remembered price, and removing the
round cap each fail tests.

## License

MIT
