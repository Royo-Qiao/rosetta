import { costTierOf, WORKERS_AI_FREE_ALLOWANCE, MODEL_REGISTRY } from "./models";
import type { Env } from "./types";

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface DailyUsage {
  day: string;
  neurons_used: number;
  free_allowance_neurons: number;
  remaining_neurons_estimate: number;
  requests: number;
  by_model: Record<
    string,
    {
      requests: number;
      input_tokens: number;
      output_tokens: number;
      neurons_used: number;
      cost_tier?: string;
    }
  >;
  note: string;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function usageKey(day = utcDay()): string {
  return `usage:${day}`;
}

function modelCost(model: string) {
  return MODEL_REGISTRY.find((entry) => entry.id === model)?.cost;
}

export function estimateNeurons(model: string, usage: TokenUsage): number {
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const cost = modelCost(model);
  if (!cost) {
    return 0;
  }
  return (inputTokens / 1_000_000) * cost.neuronsPerMIn + (outputTokens / 1_000_000) * cost.neuronsPerMOut;
}

export async function recordUsage(env: Env, model: string, usage: TokenUsage): Promise<void> {
  if (!env.USAGE_KV) {
    return;
  }

  const day = utcDay();
  const key = usageKey(day);
  const existing = await readUsage(env, day);
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const neurons = estimateNeurons(model, usage);
  const entry = MODEL_REGISTRY.find((item) => item.id === model);

  const byModel = existing.by_model[model] ?? {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    neurons_used: 0,
    cost_tier: costTierOf(entry?.cost)
  };
  byModel.requests += 1;
  byModel.input_tokens += inputTokens;
  byModel.output_tokens += outputTokens;
  byModel.neurons_used += neurons;
  byModel.cost_tier = costTierOf(entry?.cost) ?? byModel.cost_tier;

  existing.requests += 1;
  existing.neurons_used += neurons;
  existing.remaining_neurons_estimate = Math.max(0, WORKERS_AI_FREE_ALLOWANCE.neuronsPerDay - existing.neurons_used);
  existing.by_model[model] = byModel;

  await env.USAGE_KV.put(key, JSON.stringify(existing));
}

export async function readUsage(env: Env, day = utcDay()): Promise<DailyUsage> {
  const fallback: DailyUsage = {
    day,
    neurons_used: 0,
    free_allowance_neurons: WORKERS_AI_FREE_ALLOWANCE.neuronsPerDay,
    remaining_neurons_estimate: WORKERS_AI_FREE_ALLOWANCE.neuronsPerDay,
    requests: 0,
    by_model: {},
    note: "Estimated from Rosetta-routed requests only. Cloudflare exposes no documented remaining-neurons API. Usage outside Rosetta is not included. KV writes are approximate under concurrency."
  };

  if (!env.USAGE_KV) {
    return { ...fallback, note: `${fallback.note} USAGE_KV is not configured, so nothing is persisted.` };
  }

  const stored = await env.USAGE_KV.get(usageKey(day), "json");
  if (!stored || typeof stored !== "object") {
    return fallback;
  }

  return { ...fallback, ...(stored as Partial<DailyUsage>) };
}
