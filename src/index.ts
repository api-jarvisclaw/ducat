/**
 * `ducat` as a library.
 *
 * The CLI is the product; this surface exists so the agent loop and the platform
 * client can be embedded, and so tests can drive `main` without spawning a process.
 */
export { main } from './main.js'
export { HELP, parseArgs, type ParsedArgs } from './args.js'

export {
  DEFAULT_GATEWAY,
  DEFAULT_MODEL,
  configPath,
  maskSecret,
  readConfig,
  resolveConfig,
  usdToBaseUnits,
  writeConfig,
  type ConfigFlags,
  type ResolvedConfig,
  type StoredConfig,
} from './config.js'

export {
  PlatformClient,
  type AgentInfo,
  type CatalogueEntry,
  type CataloguePage,
  type ChatMessage,
  type ChatTurn,
  type ModelInfo,
  type ToolSchema,
} from './platform/client.js'

export { buildAnonymousClient, buildClient } from './platform/factory.js'

export {
  DEFAULT_MAX_ROUNDS,
  run,
  type RunResult,
  type RunnerOptions,
} from './agent/runner.js'

export {
  toolSchemas,
  tools,
  type ConfirmFn,
  type Tool,
  type ToolContext,
  type ToolCost,
} from './agent/tools.js'
