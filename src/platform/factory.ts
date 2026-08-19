/** Builds a PlatformClient from resolved config. */
import { JarvisClawError } from '@jarvisclaw-ai/sdk'
import { FREE_MODEL, usdToBaseUnits, type ResolvedConfig } from '../config.js'
import { PlatformClient } from './client.js'

/**
 * Build a client from a real credential, or explain that there is none.
 *
 * The SDK's own "no credential" error names environment variables; a first-time CLI
 * user needs to be pointed at `ducat setup` instead.
 */
export async function buildClient(config: ResolvedConfig): Promise<PlatformClient> {
  if (!config.apiKey && !config.walletKey) {
    throw new JarvisClawError(
      'No credential yet. Run `ducat setup` to add an API key or a wallet key.',
    )
  }

  return PlatformClient.create({
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.walletKey ? { privateKey: config.walletKey } : {}),
    baseUrl: config.baseUrl,
    ...(config.maxCallUsd === undefined
      ? {}
      : { maxAmountBaseUnits: usdToBaseUnits(config.maxCallUsd) }),
  })
}

/**
 * A client for the parts of the gateway that need no credential.
 *
 * The catalogue and the model list are both public, so `ducat search` works
 * before login.
 *
 * `allowAnonymous` sends no auth header at all, which is the only thing that works:
 * the gateway 401s any credential it does not recognise, so a placeholder key would
 * fail precisely for the first-time user this path exists to serve.
 */
export async function buildAnonymousClient(config: ResolvedConfig): Promise<PlatformClient> {
  if (config.apiKey || config.walletKey) return buildClient(config)
  return PlatformClient.create({ baseUrl: config.baseUrl, allowAnonymous: true })
}

/**
 * The client a task runs on: the real credential if there is one, otherwise
 * anonymous on a free model.
 *
 * A first run must not be a dead end. The gateway serves a free tier to requests
 * carrying no credential, so `ducat "hello"` works before login — which is the
 * point, since a novice who must obtain an API key before seeing anything work is a
 * novice who leaves.
 *
 * The model is forced to a free route in that mode: an anonymous request for a paid
 * model answers 402, and reporting "payment required" to someone who never asked to
 * pay is its own dead end.
 *
 * A credentialed user gets whatever they asked for, including a specific paid model.
 * The default is `auto` — smart routing — rather than a pinned name, because the
 * gateway classifies each prompt and the CLI has no better information. `downgraded`
 * says whether the requested model was replaced, so the caller can explain the
 * substitution instead of silently answering on something else.
 */
export async function buildRunClient(config: ResolvedConfig): Promise<{
  client: PlatformClient
  model: string
  anonymous: boolean
  downgraded: boolean
}> {
  if (config.apiKey || config.walletKey) {
    return {
      client: await buildClient(config),
      model: config.model,
      anonymous: false,
      downgraded: false,
    }
  }

  const client = await PlatformClient.create({
    baseUrl: config.baseUrl,
    allowAnonymous: true,
  })
  // Only the free route survives without a credential. Note this compares against
  // FREE_MODEL exactly rather than by prefix: `auto/free` is the one free route, and
  // a prefix test would pass `auto/freewheeling` straight through to a 402.
  const model = config.model === FREE_MODEL ? config.model : FREE_MODEL
  return { client, model, anonymous: true, downgraded: model !== config.model }
}
