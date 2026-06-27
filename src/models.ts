/**
 * Rosetta model registry.
 *
 * Cloudflare Workers AI exposes two model families with different I/O contracts:
 *
 *  - boundless: OpenAI-compatible. Output is `{choices:[{message:{content,tool_calls}}], usage}`.
 *    Streaming is OpenAI `chat.completion.chunk`. Accepts the OpenAI tool shape
 *    `{type:"function",function:{...}}`, `max_completion_tokens`, `reasoning_effort`,
 *    `chat_template_kwargs` (Kimi-only sub-keys).
 *  - native:   output is `{response, usage, tool_calls}`. Streaming emits per-token
 *    `data: {"response":"<tok>"}`. Accepts `max_tokens`, `top_k`, `repetition_penalty`, etc.
 *    Native function-calling tools use the flat shape `{name,description,parameters}`.
 *
 * The registry is the single source of truth for which fields to emit per model.
 */

export type ModelFamily = "boundless" | "native";

/** Input tool shape the gateway must emit for a given model. */
export type ToolShape = "openai" | "native" | "none";

export type ReasoningKind = "kimi-thinking" | "reasoning-effort" | "none";

export type ModelStatus = "ga" | "deprecated";

/** Coarse cost bucket derived from Neurons/M input. */
export type CostTier = "cheap" | "standard" | "expensive";

/**
 * Per-model cost in Cloudflare Workers AI Neurons per million tokens. All models
 * share one free allowance (see WORKERS_AI_FREE_ALLOWANCE); the rate is what varies.
 * Source: https://developers.cloudflare.com/workers-ai/platform/pricing/ (2026-06-27).
 */
export interface ModelCost {
  /** Neurons per 1M input tokens. */
  neuronsPerMIn: number;
  /** Neurons per 1M output tokens. */
  neuronsPerMOut: number;
  /** Neurons per 1M cached input tokens (some Boundless models only). */
  neuronsPerMCachedIn?: number;
}

export interface ModelCapabilities {
  family: ModelFamily;
  tools: ToolShape;
  vision: boolean;
  reasoning: ReasoningKind;
}

export interface ModelEntry extends ModelCapabilities {
  id: string;
  displayName: string;
  contextWindow?: number;
  status: ModelStatus;
  cost?: ModelCost;
  notes?: string;
}

export const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.7-code";

/**
 * Shared free allowance — every catalog model draws from this same daily budget
 * on both the Free and Paid plans. Overage ($0.011/1k Neurons) needs Workers Paid.
 * There is no per-model free/paid split.
 */
export const WORKERS_AI_FREE_ALLOWANCE = {
  neuronsPerDay: 10_000,
  overagePer1000Neurons: 0.011,
  paidPlanRequiredForOverage: true
};

/** <10k = cheap, 10k–60k = standard, >60k = expensive (Neurons/M input). */
export function costTierOf(cost: ModelCost | undefined): CostTier | undefined {
  if (!cost) return undefined;
  if (cost.neuronsPerMIn < 10_000) return "cheap";
  if (cost.neuronsPerMIn <= 60_000) return "standard";
  return "expensive";
}

/** Conservative defaults for a model we don't recognise: assume OpenAI-compatible. */
const BOUNDLESS_DEFAULT_CAPABILITIES: ModelCapabilities = {
  family: "boundless",
  tools: "openai",
  vision: false,
  reasoning: "none"
};

const NATIVE_DEFAULT_CAPABILITIES: ModelCapabilities = {
  family: "native",
  tools: "none",
  vision: false,
  reasoning: "none"
};

/**
 * Verified against Cloudflare model detail pages (2026-06-26). A handful of older
 * entries carry the legacy `@hf/` prefix; everything else is `@cf/`.
 */
export const MODEL_REGISTRY: ModelEntry[] = [
  // ── Boundless (OpenAI-compatible) ───────────────────────────────────────
  {
    id: "@cf/moonshotai/kimi-k2.7-code",
    displayName: "Moonshot Kimi K2.7 Code",
    contextWindow: 262144,
    family: "boundless",
    tools: "openai",
    vision: true,
    reasoning: "kimi-thinking",
    status: "ga",
    cost: { neuronsPerMIn: 86364, neuronsPerMOut: 363636, neuronsPerMCachedIn: 17273 },
    notes: "Default. Coding-focused sibling of K2.6."
  },
  {
    id: "@cf/moonshotai/kimi-k2.6",
    displayName: "Moonshot Kimi K2.6",
    contextWindow: 262144,
    family: "boundless",
    tools: "openai",
    vision: true,
    reasoning: "kimi-thinking",
    status: "ga",
    cost: { neuronsPerMIn: 86364, neuronsPerMOut: 363636, neuronsPerMCachedIn: 14545 }
  },
  {
    id: "@cf/moonshotai/kimi-k2.5",
    displayName: "Moonshot Kimi K2.5",
    contextWindow: 256000,
    family: "boundless",
    tools: "openai",
    vision: true,
    reasoning: "kimi-thinking",
    status: "deprecated",
    cost: { neuronsPerMIn: 54545, neuronsPerMOut: 272727, neuronsPerMCachedIn: 9091 }
  },
  {
    id: "@cf/zai-org/glm-5.2",
    displayName: "Zhipu GLM 5.2",
    contextWindow: 262144,
    family: "boundless",
    tools: "openai",
    vision: false,
    reasoning: "reasoning-effort",
    status: "ga",
    cost: { neuronsPerMIn: 127273, neuronsPerMOut: 400000, neuronsPerMCachedIn: 23636 }
  },
  {
    id: "@cf/zai-org/glm-4.7-flash",
    displayName: "Zhipu GLM 4.7 Flash",
    contextWindow: 131072,
    family: "boundless",
    tools: "openai",
    vision: false,
    reasoning: "reasoning-effort",
    status: "ga",
    cost: { neuronsPerMIn: 5500, neuronsPerMOut: 36400 }
  },
  {
    id: "@cf/google/gemma-4-26b-a4b-it",
    displayName: "Google Gemma 4 26B",
    contextWindow: 256000,
    family: "boundless",
    tools: "openai",
    vision: true,
    reasoning: "reasoning-effort",
    status: "ga",
    cost: { neuronsPerMIn: 9091, neuronsPerMOut: 27273 }
  },
  {
    id: "@cf/nvidia/nemotron-3-120b-a12b",
    displayName: "NVIDIA Nemotron 3 120B",
    contextWindow: 256000,
    family: "boundless",
    tools: "openai",
    vision: false,
    reasoning: "reasoning-effort",
    status: "ga",
    cost: { neuronsPerMIn: 45455, neuronsPerMOut: 136364 }
  },

  // ── Native ──────────────────────────────────────────────────────────────
  {
    id: "@cf/meta/llama-4-scout-17b-16e-instruct",
    displayName: "Meta Llama 4 Scout 17B",
    contextWindow: 131000,
    family: "native",
    tools: "native",
    vision: true,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 24545, neuronsPerMOut: 77273 }
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    displayName: "Meta Llama 3.3 70B (fp8, fast)",
    contextWindow: 24000,
    family: "native",
    tools: "native",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 26668, neuronsPerMOut: 204805 }
  },
  {
    id: "@cf/meta/llama-3.2-11b-vision-instruct",
    displayName: "Meta Llama 3.2 11B Vision",
    contextWindow: 128000,
    family: "native",
    tools: "none",
    vision: true,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 4410, neuronsPerMOut: 61493 },
    notes: "Vision via top-level `image` field (not implemented yet). Needs a one-time license agree call."
  },
  {
    id: "@cf/meta/llama-3.2-3b-instruct",
    displayName: "Meta Llama 3.2 3B",
    family: "native",
    tools: "none",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 4625, neuronsPerMOut: 30475 }
  },
  {
    id: "@cf/meta/llama-3.2-1b-instruct",
    displayName: "Meta Llama 3.2 1B",
    family: "native",
    tools: "none",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 2457, neuronsPerMOut: 18252 }
  },
  {
    id: "@cf/meta/llama-3.1-8b-instruct-fast",
    displayName: "Meta Llama 3.1 8B (fast)",
    family: "native",
    tools: "none",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 4119, neuronsPerMOut: 34868 },
    notes: "Cost inferred from llama-3.1-8b-instruct-fp8-fast row (no exact id match in pricing table)."
  },
  {
    id: "@cf/meta/llama-3.1-8b-instruct-fp8",
    displayName: "Meta Llama 3.1 8B (fp8)",
    family: "native",
    tools: "none",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 13778, neuronsPerMOut: 26128 }
  },
  {
    id: "@cf/meta/llama-3.1-8b-instruct",
    displayName: "Meta Llama 3.1 8B",
    family: "native",
    tools: "none",
    vision: false,
    reasoning: "none",
    status: "deprecated"
  },
  {
    id: "@cf/meta/llama-3.1-70b-instruct",
    displayName: "Meta Llama 3.1 70B",
    family: "native",
    tools: "none",
    vision: false,
    reasoning: "none",
    status: "deprecated"
  },
  {
    id: "@cf/meta/llama-guard-3-8b",
    displayName: "Meta Llama Guard 3 8B",
    family: "native",
    tools: "none",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 44003, neuronsPerMOut: 2730 },
    notes: "Content-safety classifier."
  },
  {
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    displayName: "Qwen3 30B A3B (fp8)",
    contextWindow: 32768,
    family: "native",
    tools: "none",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 4625, neuronsPerMOut: 30475 },
    notes: "Hybrid anomaly: OpenAI-style output but native-style input. Tools not accepted."
  },
  {
    id: "@cf/qwen/qwen2.5-coder-32b-instruct",
    displayName: "Qwen2.5 Coder 32B",
    contextWindow: 32768,
    family: "native",
    tools: "none",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 60000, neuronsPerMOut: 90909 },
    notes: "May emit tool_calls; does not accept tools input."
  },
  {
    id: "@cf/qwen/qwq-32b",
    displayName: "Qwen QwQ 32B",
    contextWindow: 24000,
    family: "native",
    tools: "none",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 60000, neuronsPerMOut: 90909 },
    notes: "Reasoning model (inherent)."
  },
  {
    id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    displayName: "Mistral Small 3.1 24B",
    contextWindow: 128000,
    family: "native",
    tools: "native",
    vision: true,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 31876, neuronsPerMOut: 50488 }
  },
  {
    id: "@cf/mistralai/mistral-7b-instruct-v0.2",
    displayName: "Mistral 7B v0.2",
    contextWindow: 32000,
    family: "native",
    tools: "none",
    vision: false,
    reasoning: "none",
    status: "deprecated"
  },
  {
    id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    displayName: "DeepSeek R1 Distill Qwen 32B",
    contextWindow: 80000,
    family: "native",
    tools: "none",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 45170, neuronsPerMOut: 443756 },
    notes: "Reasoning model (inherent)."
  },
  {
    id: "@cf/openai/gpt-oss-120b",
    displayName: "OpenAI GPT-OSS 120B",
    contextWindow: 128000,
    family: "native",
    tools: "native",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 31818, neuronsPerMOut: 68182 }
  },
  {
    id: "@cf/openai/gpt-oss-20b",
    displayName: "OpenAI GPT-OSS 20B",
    family: "native",
    tools: "native",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 18182, neuronsPerMOut: 27273 }
  },
  {
    id: "@cf/ibm-granite/granite-4.0-h-micro",
    displayName: "IBM Granite 4.0 H Micro",
    contextWindow: 131000,
    family: "native",
    tools: "native",
    vision: false,
    reasoning: "none",
    status: "ga",
    cost: { neuronsPerMIn: 1542, neuronsPerMOut: 10158 },
    notes: "Cheapest model in the catalog."
  },
  {
    id: "@hf/nousresearch/hermes-2-pro-mistral-7b",
    displayName: "Nous Hermes 2 Pro Mistral 7B",
    family: "native",
    tools: "native",
    vision: false,
    reasoning: "none",
    status: "deprecated",
    notes: "Legacy @hf/ prefix. Neuron cost undocumented (deprecated Beta)."
  }
];

const REGISTRY_BY_ID = new Map(MODEL_REGISTRY.map((entry) => [entry.id, entry]));

/**
 * Anthropic clients send `claude-*` model names. Rosetta maps every alias to the
 * configured (or default) model rather than lying about per-alias routing.
 */
export function isClaudeAlias(requested?: string): boolean {
  return Boolean(requested && requested.startsWith("claude-"));
}

function lookup(id: string): ModelEntry | undefined {
  return REGISTRY_BY_ID.get(id);
}

/**
 * Rough heuristic: pick capabilities for an unrecognised `@cf/...` id. We cannot
 * know the family from the string alone, so we fall back to boundless defaults,
 * which is the safer translation target for an Anthropic request.
 */
function inferUnknown(id: string): ModelCapabilities {
  return id.startsWith("@hf/") ? NATIVE_DEFAULT_CAPABILITIES : BOUNDLESS_DEFAULT_CAPABILITIES;
}

export interface ResolvedModel {
  id: string;
  alias?: string;
  capabilities: ModelCapabilities;
  entry?: ModelEntry;
  warnings: ModelWarning[];
}

export interface ModelWarning {
  field: string;
  reason: string;
}

/**
 * Resolve the Workers AI model id and its capabilities for a request.
 *
 * Precedence:
 *   1. `configured` (env CF_AI_MODEL) always wins.
 *   2. A bare `@cf/` / `@hf/` id requested by the client is honoured directly.
 *   3. A `claude-*` alias maps to the configured/default model.
 *   4. Anything else falls back to the default model.
 *
 * Unknown models default to boundless capabilities with a warning.
 */
export function resolveModelCapabilities(
  requested: string | undefined,
  configured?: string
): ResolvedModel {
  const warnings: ModelWarning[] = [];
  const configuredId = configured?.trim();
  const requestedId = requested?.trim();

  // 1. Configured wins.
  if (configuredId) {
    const entry = lookup(configuredId);
    if (entry) {
      return { id: entry.id, alias: requestedId && requestedId !== entry.id ? requestedId : undefined, capabilities: entry, entry, warnings };
    }
    warnings.push({ field: "model", reason: `Configured model "${configuredId}" is not in the registry; assuming OpenAI-compatible input.` });
    return { id: configuredId, alias: requestedId && requestedId !== configuredId ? requestedId : undefined, capabilities: inferUnknown(configuredId), warnings };
  }

  // 2. Bare Workers AI id.
  if (requestedId && (requestedId.startsWith("@cf/") || requestedId.startsWith("@hf/"))) {
    const entry = lookup(requestedId);
    if (entry) {
      return { id: entry.id, capabilities: entry, entry, warnings };
    }
    warnings.push({ field: "model", reason: `Model "${requestedId}" is not in the registry; assuming OpenAI-compatible input.` });
    return { id: requestedId, capabilities: inferUnknown(requestedId), warnings };
  }

  // 3. claude-* alias → default model.
  if (requestedId && isClaudeAlias(requestedId)) {
    const entry = lookup(DEFAULT_MODEL)!;
    return { id: entry.id, alias: requestedId, capabilities: entry, entry, warnings };
  }

  // 4. Fallback to default.
  const entry = lookup(DEFAULT_MODEL)!;
  if (requestedId && requestedId !== entry.id) {
    warnings.push({ field: "model", reason: `Unknown model "${requestedId}"; using default ${entry.id}.` });
  }
  return { id: entry.id, alias: requestedId && requestedId !== entry.id ? requestedId : undefined, capabilities: entry, entry, warnings };
}

/** Capabilities-only shorthand for callers that don't need the alias/warnings. */
export function capabilitiesFor(id: string): ModelCapabilities {
  return lookup(id) ?? inferUnknown(id);
}

/** Models advertised by `/v1/models`. Excludes deprecated entries from the headline list. */
export function catalogModels(): ModelEntry[] {
  return MODEL_REGISTRY.filter((entry) => entry.status === "ga");
}
