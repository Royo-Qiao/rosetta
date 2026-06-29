import { describe, expect, it } from "vitest";
import { convertAnthropicToWorkersAI, anthropicMessageFromWorkersAI, validateMessagesRequest } from "../src/anthropic";
import { resolveModelCapabilities, capabilitiesFor } from "../src/models";
import { costTierOf, WORKERS_AI_FREE_ALLOWANCE } from "../src/models";
import { APPS, getApp, ccswitchUrl, hermesSnippet, traeSnippet, claudeSnippet } from "../src/apps";
import type { Env } from "../src/types";
import worker from "../src/index";

function memoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const value = store.get(key) ?? null;
      return type === "json" && value ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    }
  } as unknown as KVNamespace;
}

/** Minimal stub Env with a Workers AI binding. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: { run: async () => ({ response: "ok", usage: { prompt_tokens: 1, completion_tokens: 1 } }) },
    CF_AI_MODEL: "@cf/moonshotai/kimi-k2.7-code",
    GATEWAY_AUTH_TOKEN: "",
    MAX_BODY_BYTES: "2000000",
    ...overrides
  };
}

function callWorker(method: string, path: string, env: Env, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const init: RequestInit<RequestInitCfProperties> = {
    method,
    headers: { "content-type": "application/json", ...headers }
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return worker.fetch(new Request(`https://rosetta.test${path}`, init), env);
}

describe("model resolution", () => {
  it("configured model always wins", () => {
    const resolved = resolveModelCapabilities("claude-sonnet-4-5", "@cf/zai-org/glm-5.2");
    expect(resolved.id).toBe("@cf/zai-org/glm-5.2");
    expect(resolved.capabilities.family).toBe("boundless");
    expect(resolved.capabilities.tools).toBe("openai");
  });

  it("honours a bare @cf id from the client", () => {
    const resolved = resolveModelCapabilities("@cf/meta/llama-3.3-70b-instruct-fp8-fast", undefined);
    expect(resolved.id).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(resolved.capabilities.family).toBe("native");
    expect(resolved.capabilities.tools).toBe("native");
  });

  it("maps a claude-* alias to the default model when nothing is configured", () => {
    const resolved = resolveModelCapabilities("claude-opus-4-7", undefined);
    expect(resolved.id).toBe("@cf/moonshotai/kimi-k2.7-code");
    expect(resolved.alias).toBe("claude-opus-4-7");
    expect(resolved.capabilities.family).toBe("boundless");
  });

  it("defaults an unknown @cf id to boundless capabilities with a warning", () => {
    const resolved = resolveModelCapabilities("@cf/fictional/new-model", undefined);
    expect(resolved.id).toBe("@cf/fictional/new-model");
    expect(resolved.capabilities.family).toBe("boundless");
    expect(resolved.warnings.length).toBeGreaterThan(0);
  });

  it("capabilitiesFor returns boundless defaults for an unknown id", () => {
    expect(capabilitiesFor("@cf/unknown/x").family).toBe("boundless");
  });

  it("classifies cost tiers from Neuron rates", () => {
    expect(costTierOf({ neuronsPerMIn: 1542, neuronsPerMOut: 10158 })).toBe("cheap"); // granite
    expect(costTierOf({ neuronsPerMIn: 26668, neuronsPerMOut: 204805 })).toBe("standard"); // llama-3.3-70b
    expect(costTierOf({ neuronsPerMIn: 127273, neuronsPerMOut: 400000 })).toBe("expensive"); // glm-5.2
    expect(costTierOf(undefined)).toBeUndefined();
  });

  it("exposes a shared free allowance", () => {
    expect(WORKERS_AI_FREE_ALLOWANCE.neuronsPerDay).toBe(10_000);
    expect(WORKERS_AI_FREE_ALLOWANCE.overagePer1000Neurons).toBe(0.011);
  });
});

describe("per-family request shaping", () => {
  it("kimi (boundless) uses max_completion_tokens and chat_template_kwargs with thinking on by default", () => {
    const request = validateMessagesRequest({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] });
    const converted = convertAnthropicToWorkersAI(request, "@cf/moonshotai/kimi-k2.7-code");
    expect(converted.input.max_completion_tokens).toBe(1024);
    expect(converted.input.max_tokens).toBeUndefined();
    expect((converted.input.chat_template_kwargs as { thinking: boolean }).thinking).toBe(true);
    expect((converted.input.chat_template_kwargs as { clear_thinking: boolean }).clear_thinking).toBe(false);
  });

  it("respects an explicit thinking.type=disabled for kimi", () => {
    const request = validateMessagesRequest({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" }
    });
    const converted = convertAnthropicToWorkersAI(request, "@cf/moonshotai/kimi-k2.7-code");
    expect((converted.input.chat_template_kwargs as { thinking: boolean }).thinking).toBe(false);
  });

  it("non-kimi boundless model omits chat_template_kwargs", () => {
    const request = validateMessagesRequest({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] });
    const converted = convertAnthropicToWorkersAI(request, "@cf/zai-org/glm-5.2");
    expect(converted.input.chat_template_kwargs).toBeUndefined();
    expect(converted.input.max_completion_tokens).toBe(1024);
  });

  it("native model uses max_tokens and flat tool shape", () => {
    const request = validateMessagesRequest({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      max_tokens: 64,
      tools: [{ name: "read", description: "d", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "x" }]
    });
    const converted = convertAnthropicToWorkersAI(request);
    expect(converted.input.max_tokens).toBe(64);
    expect(converted.input.max_completion_tokens).toBeUndefined();
    const tools = converted.input.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: "read", parameters: { type: "object", properties: {} } });
    expect(tools[0]).not.toHaveProperty("type");
    expect(tools[0]).not.toHaveProperty("function");
  });

  it("native model passes top_k through without a warning", () => {
    const request = validateMessagesRequest({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      top_k: 40,
      messages: [{ role: "user", content: "x" }]
    });
    const converted = convertAnthropicToWorkersAI(request);
    expect(converted.input.top_k).toBe(40);
    expect(converted.warnings.find((w) => w.field === "top_k")).toBeUndefined();
  });

  it("boundless model drops top_k with a warning", () => {
    const request = validateMessagesRequest({
      model: "claude-sonnet-4-5",
      top_k: 40,
      messages: [{ role: "user", content: "x" }]
    });
    const converted = convertAnthropicToWorkersAI(request);
    expect(converted.input.top_k).toBeUndefined();
    expect(converted.warnings.find((w) => w.field === "top_k")).toBeDefined();
  });

  it("tool-less native model strips tools and warns", () => {
    const request = validateMessagesRequest({
      model: "@cf/qwen/qwq-32b",
      tools: [{ name: "read", description: "d", input_schema: {} }],
      messages: [{ role: "user", content: "x" }]
    });
    const converted = convertAnthropicToWorkersAI(request);
    expect(converted.input.tools).toBeUndefined();
    expect(converted.warnings.find((w) => w.field === "tools")).toBeDefined();
  });

  it("still extracts flat native tool_calls from a native response", () => {
    const response = anthropicMessageFromWorkersAI(
      { response: "", usage: { prompt_tokens: 1, completion_tokens: 1 }, tool_calls: [{ name: "read", arguments: { path: "a" } }] },
      "claude-sonnet-4-5"
    );
    expect(response.content).toEqual([{ type: "tool_use", id: expect.any(String), name: "read", input: { path: "a" } }]);
    expect(response.stop_reason).toBe("tool_use");
  });
});

describe("apps table", () => {
  it("covers all five clients", () => {
    expect(APPS.map((a) => a.id).sort()).toEqual(["claude", "hermes", "openclaw", "opencode", "trae"]);
  });

  it("ccswitch opencode endpoint gets /v1 suffix, anthropic apps do not", () => {
    const opencode = getApp("opencode")!;
    const claude = getApp("claude")!;
    expect(ccswitchUrl(opencode, "https://x.workers.dev", "k")).toContain("endpoint=https%3A%2F%2Fx.workers.dev%2Fv1");
    expect(ccswitchUrl(claude, "https://x.workers.dev", "k")).toContain("endpoint=https%3A%2F%2Fx.workers.dev&");
  });

  it("hermes snippet uses anthropic_messages and the bare endpoint", () => {
    const snippet = hermesSnippet("https://x.workers.dev", "GATEWAY_AUTH_TOKEN", "claude-sonnet-4-5");
    expect(snippet).toContain("api_mode: anthropic_messages");
    expect(snippet).toContain("base_url: https://x.workers.dev");
    expect(snippet).toContain("key_env: GATEWAY_AUTH_TOKEN");
  });

  it("trae snippet gives Anthropic-format UI steps", () => {
    const snippet = traeSnippet("https://x.workers.dev", "fake-key", "claude-sonnet-4-5");
    expect(snippet).toContain("Anthropic");
    expect(snippet).toContain("claude-sonnet-4-5");
  });

  it("claude snippet puts BASE_URL first and fills all model tiers", () => {
    const snippet = claudeSnippet("https://x.workers.dev", "fake-key", "glm-5.2");
    expect(snippet.indexOf("ANTHROPIC_BASE_URL")).toBeLessThan(snippet.indexOf("ANTHROPIC_AUTH_TOKEN"));
    for (const tier of ["HAIKU", "OPUS", "SONNET"]) {
      expect(snippet).toContain(`ANTHROPIC_DEFAULT_${tier}_MODEL`);
      expect(snippet).toContain(`ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`);
    }
    expect(snippet).toContain('"glm-5.2"');
  });

  it("ccswitch claude deep link carries model defaults", () => {
    const claude = getApp("claude")!;
    const url = ccswitchUrl(claude, "https://x.workers.dev", "k", "glm-5.2");
    expect(url).toContain("haikuModel=glm-5.2");
    expect(url).toContain("sonnetModel=glm-5.2");
    expect(url).toContain("opusModel=glm-5.2");
  });
});

describe("routing", () => {
  it("/health reports the configured model, family, and cost tier", async () => {
    const res = await callWorker("GET", "/health", makeEnv({ CF_AI_MODEL: "@cf/zai-org/glm-5.2" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, service: "rosetta", model: "@cf/zai-org/glm-5.2", family: "boundless", cost_tier: "expensive" });
    expect(body.free_allowance_neurons_per_day).toBe(10_000);
  });

  it("/v1/models lists the configured model, the catalog, claude aliases, and pricing", async () => {
    const res = await callWorker("GET", "/v1/models", makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; metadata: { cost_tier?: string } }>; pricing: { free_allowance_neurons_per_day: number } };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("@cf/moonshotai/kimi-k2.7-code");
    expect(ids).toContain("@cf/zai-org/glm-5.2");
    expect(ids).toContain("claude-sonnet-4-5");
    // the configured kimi model is 'expensive' (>60k neurons/M in)
    expect(body.data[0].metadata.cost_tier).toBe("expensive");
    expect(body.pricing.free_allowance_neurons_per_day).toBe(10_000);
  });

  it("/ccswitch redirects for opencode/openclaw (ccswitch deep links)", async () => {
    for (const id of ["opencode", "openclaw"] as const) {
      const res = await callWorker("GET", `/ccswitch?app=${id}`, makeEnv());
      expect(res.status).toBe(302);
      expect(res.headers.get("location") ?? "").toContain("ccswitch://v1/import");
    }
  });

  it("/ccswitch?app=claude renders an env snippet with BASE_URL first + model defaults", async () => {
    const res = await callWorker("GET", "/ccswitch?app=claude&model=@cf/zai-org/glm-5.2", makeEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    // BASE_URL before auth token / model keys
    const baseUrlPos = body.indexOf("ANTHROPIC_BASE_URL");
    const authPos = body.indexOf("ANTHROPIC_AUTH_TOKEN");
    const modelPos = body.indexOf("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(baseUrlPos).toBeLessThan(authPos);
    expect(authPos).toBeLessThan(modelPos);
    expect(body).toContain("@cf/zai-org/glm-5.2");
    expect(body).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL");
    expect(body).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL");
    // one-click import button present
    expect(body).toContain("One-click import into");
  });

  it("/ccswitch renders a snippet page for hermes and trae", async () => {
    for (const id of ["hermes", "trae"] as const) {
      const res = await callWorker("GET", `/ccswitch?app=${id}`, makeEnv());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("Rosetta");
    }
  });

  it("/ccswitch rejects an unknown app with 400", async () => {
    const res = await callWorker("GET", "/ccswitch?app=bogus", makeEnv());
    expect(res.status).toBe(400);
  });

  it("/ccswitch?app=hermes&model=<id> bakes the chosen model into the snippet", async () => {
    const res = await callWorker("GET", "/ccswitch?app=hermes&model=@cf/ibm-granite/granite-4.0-h-micro", makeEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("@cf/ibm-granite/granite-4.0-h-micro");
    expect(body).toContain("anthropic_messages");
  });

  it("/home renders the configurator with all five apps", async () => {
    const res = await callWorker("GET", "/", makeEnv());
    const body = await res.text();
    expect(body).toContain("One-click configuration");
    // apps are embedded in the client-side JS data
    for (const app of APPS) {
      expect(body).toContain(app.label);
    }
  });

  it("authorizes with a configured token", async () => {
    const env = makeEnv({ GATEWAY_AUTH_TOKEN: "secret" });
    const unauth = await callWorker("POST", "/v1/messages", env, { model: "claude-sonnet-4-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
    expect(unauth.status).toBe(401);

    const withKey = await callWorker(
      "POST",
      "/v1/messages",
      env,
      { model: "claude-sonnet-4-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
      { "x-api-key": "secret" }
    );
    expect(withKey.status).toBe(200);
  });

  it("stream responses carry CORS headers", async () => {
    const res = await callWorker(
      "POST",
      "/v1/messages",
      makeEnv(),
      { model: "claude-sonnet-4-5", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] }
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    await res.text();
  });

  it("tracks local neuron usage for Rosetta-routed requests", async () => {
    const env = makeEnv({ USAGE_KV: memoryKv() });
    const before = (await (await callWorker("GET", "/usage", env)).json()) as Record<string, unknown>;
    expect(before.requests).toBe(0);

    const completion = await callWorker(
      "POST",
      "/v1/messages",
      env,
      { model: "claude-sonnet-4-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }
    );
    expect(completion.status).toBe(200);

    const after = (await (await callWorker("GET", "/usage", env)).json()) as Record<string, unknown>;
    expect(after.requests).toBe(1);
    expect(after.neurons_used as number).toBeGreaterThan(0);
    expect(after.remaining_neurons_estimate as number).toBeLessThan(10_000);
  });

  it("/oauth/login renders setup instructions when OAuth is not configured", async () => {
    const res = await callWorker("GET", "/oauth/login", makeEnv());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Cloudflare OAuth is not configured");
    expect(body).toContain("CF_OAUTH_CLIENT_ID");
  });
});
