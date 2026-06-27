import {
  AnthropicHttpError,
  anthropicError,
  anthropicMessageFromWorkersAI,
  convertAnthropicToWorkersAI,
  estimateTokensFromMessages,
  json,
  validateMessagesRequest
} from "./anthropic";
import { resolveModelCapabilities, catalogModels, costTierOf, WORKERS_AI_FREE_ALLOWANCE, MODEL_REGISTRY } from "./models";
import { APPS, getApp, ccswitchUrl, appSnippet } from "./apps";
import { anthropicStreamFromWorkersAI } from "./streaming";
import {
  convertOpenAIToWorkersAI,
  openAIChatCompletionFromWorkersAI,
  openAIChatCompletionStreamFromWorkersAI,
  validateOpenAIChatRequest
} from "./openai";
import type { AnthropicMessagesRequest, Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof AnthropicHttpError) {
        return anthropicError(error.status, error.type, error.message, error.detail);
      }
      return anthropicError(500, "api_error", error instanceof Error ? error.message : "Unexpected gateway error.");
    }
  }
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    const resolved = resolveModelCapabilities(undefined, env.CF_AI_MODEL);
    return json(
      {
        ok: true,
        service: "rosetta",
        model: resolved.id,
        family: resolved.capabilities.family,
        capabilities: resolved.capabilities,
        cost: resolved.entry?.cost,
        cost_tier: costTierOf(resolved.entry?.cost),
        free_allowance_neurons_per_day: WORKERS_AI_FREE_ALLOWANCE.neuronsPerDay
      },
      200,
      corsHeaders()
    );
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    return json(modelsResponse(env), 200, corsHeaders());
  }

  if (request.method === "GET" && url.pathname === "/ccswitch") {
    return ccswitchRedirect(request, env);
  }

  if (request.method === "GET" && url.pathname === "/") {
    return homePage(request, env);
  }

  if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    await authorize(request, env);
    const payload = await readJson(request, env);
    const anthropicRequest = validateMessagesRequest(payload);
    return json({ input_tokens: estimateTokensFromMessages(anthropicRequest) }, 200, corsHeaders());
  }

  if (request.method === "POST" && url.pathname === "/v1/messages") {
    await authorize(request, env);
    const payload = await readJson(request, env);
    const anthropicRequest = validateMessagesRequest(payload);
    return createMessage(anthropicRequest, env);
  }

  if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
    await authorize(request, env);
    const payload = await readJson(request, env);
    const openAIRequest = validateOpenAIChatRequest(payload);
    return createOpenAIChatCompletion(openAIRequest, env);
  }

  return anthropicError(404, "not_found_error", `No route for ${request.method} ${url.pathname}.`);
}

async function createOpenAIChatCompletion(openAIRequest: ReturnType<typeof validateOpenAIChatRequest>, env: Env): Promise<Response> {
  const converted = convertOpenAIToWorkersAI(openAIRequest, env.CF_AI_MODEL);

  try {
    if (openAIRequest.stream) {
      const upstream = env.AI.run(converted.model, converted.input);
      return withCors(openAIChatCompletionStreamFromWorkersAI(upstream, openAIRequest.model ?? converted.model));
    }

    const upstream = await env.AI.run(converted.model, converted.input);
    return withCors(openAIChatCompletionFromWorkersAI(upstream, openAIRequest.model ?? converted.model));
  } catch (error) {
    const status = inferStatus(error);
    return json(
      {
        error: {
          message: error instanceof Error ? error.message : "Workers AI request failed.",
          type: inferErrorType(status),
          code: null
        }
      },
      status,
      corsHeaders()
    );
  }
}

async function createMessage(anthropicRequest: AnthropicMessagesRequest, env: Env): Promise<Response> {
  const converted = convertAnthropicToWorkersAI(anthropicRequest, env.CF_AI_MODEL);

  try {
    if (anthropicRequest.stream) {
      const upstream = env.AI.run(converted.model, converted.input);
      return withCors(anthropicStreamFromWorkersAI(upstream, converted.modelAlias, converted.warnings));
    }

    const upstream = await env.AI.run(converted.model, converted.input);
    return json(anthropicMessageFromWorkersAI(upstream, converted.modelAlias, converted.warnings), 200, corsHeaders());
  } catch (error) {
    const status = inferStatus(error);
    return anthropicError(status, inferErrorType(status), error instanceof Error ? error.message : "Workers AI request failed.");
  }
}

async function readJson(request: Request, env: Env): Promise<unknown> {
  const maxBytes = Number.parseInt(env.MAX_BODY_BYTES || "2000000", 10);
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
    throw new AnthropicHttpError(413, "request_too_large", `Request body exceeds ${maxBytes} bytes.`);
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new AnthropicHttpError(400, "invalid_request_error", "Unable to read request body.");
  }

  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new AnthropicHttpError(413, "request_too_large", `Request body exceeds ${maxBytes} bytes.`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new AnthropicHttpError(400, "invalid_request_error", "Request body must be valid JSON.");
  }
}

async function authorize(request: Request, env: Env): Promise<void> {
  const expected = env.GATEWAY_AUTH_TOKEN?.trim();
  if (!expected) {
    return;
  }

  const authorization = request.headers.get("authorization") ?? "";
  const apiKey = request.headers.get("x-api-key") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim() || apiKey.trim();
  if (token !== expected) {
    throw new AnthropicHttpError(401, "authentication_error", "Invalid API key.");
  }
}

const CREATED_AT = "2026-05-01T00:00:00Z";

// Familiar Anthropic names clients may filter on; all route to the configured model.
const CLAUDE_ALIASES = [
  "claude-sonnet-4-5",
  "claude-opus-4-7",
  "claude-3-7-sonnet-latest",
  "claude-3-5-sonnet-latest",
  "claude-3-5-haiku-latest"
];

function modelsResponse(env: Env): Record<string, unknown> {
  const resolved = resolveModelCapabilities(undefined, env.CF_AI_MODEL);

  const data: Array<Record<string, unknown>> = [
    {
      id: resolved.id,
      type: "model",
      display_name: `${resolved.entry?.displayName ?? resolved.id} (configured)`,
      created_at: CREATED_AT,
      metadata: modelMetadata(resolved.entry, resolved.capabilities, true)
    }
  ];

  // Full catalogue of GA models so clients can pick a real Workers AI model.
  for (const entry of catalogModels()) {
    if (entry.id === resolved.id) {
      continue;
    }
    data.push({
      id: entry.id,
      type: "model",
      display_name: `${entry.displayName} via Rosetta`,
      created_at: CREATED_AT,
      metadata: modelMetadata(entry, entry, false)
    });
  }

  // Claude aliases route to the configured model (kept for client compatibility).
  for (const alias of CLAUDE_ALIASES) {
    data.push({
      id: alias,
      type: "model",
      display_name: `${alias} (→ ${resolved.id})`,
      created_at: CREATED_AT,
      metadata: { workers_ai_model: resolved.id, alias: true }
    });
  }

  return {
    object: "list",
    data,
    // Shared across every model; see WORKERS_AI_FREE_ALLOWANCE.
    pricing: {
      free_allowance_neurons_per_day: WORKERS_AI_FREE_ALLOWANCE.neuronsPerDay,
      overage_per_1000_neurons: WORKERS_AI_FREE_ALLOWANCE.overagePer1000Neurons,
      paid_plan_required_for_overage: WORKERS_AI_FREE_ALLOWANCE.paidPlanRequiredForOverage,
      note: "All models share one daily free allowance; no model is free-only or paid-only."
    }
  };
}

function modelMetadata(
  entry: { contextWindow?: number; cost?: Parameters<typeof costTierOf>[0] } | undefined,
  capabilities: { family: string; tools: string; vision: boolean; reasoning: string },
  configured: boolean
): Record<string, unknown> {
  return {
    family: capabilities.family,
    tools: capabilities.tools,
    vision: capabilities.vision,
    reasoning: capabilities.reasoning,
    context_window: entry?.contextWindow,
    cost: entry?.cost,
    cost_tier: costTierOf(entry?.cost),
    ...(configured ? { configured: true } : {})
  };
}

function ccswitchRedirect(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const appId = url.searchParams.get("app");
  const app = getApp(appId);
  if (!app) {
    return anthropicError(
      400,
      "invalid_request_error",
      `Unknown app "${appId ?? ""}". Supported: ${APPS.map((a) => a.id).join(", ")}.`
    );
  }

  const endpoint = publicBaseUrl(request, env);
  const apiKey = env.GATEWAY_AUTH_TOKEN?.trim() || "fake-key";

  // Optional ?model= lets the home-page configurator generate config for any model,
  // not just the configured one. Falls back to the configured model.
  const requestedModel = url.searchParams.get("model") || undefined;
  const resolved = resolveModelCapabilities(requestedModel, env.CF_AI_MODEL);

  if (app.importKind === "ccswitch") {
    return Response.redirect(ccswitchUrl(app, endpoint, apiKey), 302);
  }

  const apiKeyEnv = env.GATEWAY_AUTH_TOKEN?.trim() ? "GATEWAY_AUTH_TOKEN" : "fake-key";
  const modelAlias = resolved.alias ?? resolved.id;
  const snippet = appSnippet(app, endpoint, apiKey, apiKeyEnv, modelAlias);
  return snippetPage(app, snippet, resolved);
}

function homePage(request: Request, env: Env): Response {
  const endpoint = publicBaseUrl(request, env);
  const apiKey = env.GATEWAY_AUTH_TOKEN?.trim() || "fake-key";
  const resolved = resolveModelCapabilities(undefined, env.CF_AI_MODEL);
  const apiKeyEnv = env.GATEWAY_AUTH_TOKEN?.trim() ? "GATEWAY_AUTH_TOKEN" : "fake-key";

  // Catalog for the client-side configurator: id, name, family, cost tier, configured flag.
  const catalog = MODEL_REGISTRY.map((entry) => ({
    id: entry.id,
    name: entry.displayName,
    family: entry.family,
    tier: costTierOf(entry.cost),
    configured: entry.id === resolved.id,
    status: entry.status
  }));
  const configuredId = resolved.id;
  const catalogJson = JSON.stringify(catalog).replaceAll("</", "<\\/");

  const appsJson = JSON.stringify(
    APPS.map((app) => ({ id: app.id, label: app.label, format: app.format, importKind: app.importKind }))
  ).replaceAll("</", "<\\/");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rosetta</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; max-width: 920px; line-height: 1.5; color: #111827; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { background: #f3f4f6; padding: 16px; border-radius: 8px; overflow-x: auto; }
    a { color: #075985; }
    small { color: #6b7280; }
    select, button, input { font: inherit; padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px; }
    button.primary { background: #075985; color: #fff; border-color: #075985; font-weight: 600; }
    button.primary:hover { background: #0a6da3; }
    .tier { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 10px; margin-left: 6px; vertical-align: middle; }
    .tier-cheap { background: #dcfce7; color: #166534; }
    .tier-standard { background: #fef9c3; color: #854d0e; }
    .tier-expensive { background: #fee2e2; color: #991b1b; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    #config-result { margin-top: 20px; }
  </style>
</head>
<body>
  <h1>Rosetta</h1>
  <p>Anthropic-compatible gateway fronting Cloudflare Workers AI. Pick a model and a client below, then one-click generate the config.</p>
  <p>Active model: <code>${escapeHtml(resolved.id)}</code> (${resolved.capabilities.family}, ${escapeHtml(costTierOf(resolved.entry?.cost) ?? "unknown")} cost) · API key: <code>${escapeHtml(apiKey)}</code></p>

  <h2>One-click configuration</h2>
  <div class="row">
    <label>Model <select id="model"></select></label>
    <label>Client <select id="app"></select></label>
    <button class="primary" id="generate" onclick="generate()">Generate config</button>
  </div>
  <p><small id="model-info"></small></p>
  <div id="config-result"></div>

  <h2>Plain env vars</h2>
  <pre>ANTHROPIC_BASE_URL=${escapeHtml(endpoint)}
ANTHROPIC_API_KEY=${escapeHtml(apiKey)}
ANTHROPIC_AUTH_TOKEN=${escapeHtml(apiKey)}</pre>

  <h2>Cost tiers</h2>
  <p><small>All models share one 10,000 Neurons/day free allowance. The tier shows how fast a model burns it (Neurons/M input).</small></p>
  <p><span class="tier tier-cheap">cheap</span> &lt;10k · <span class="tier tier-standard">standard</span> 10k–60k · <span class="tier tier-expensive">expensive</span> &gt;60k</p>

  <p>Health: <a href="/health">/health</a> · Models: <a href="/v1/models">/v1/models</a></p>

  <script>
    const CATALOG = ${catalogJson};
    const APPS = ${appsJson};
    const CONFIGURED = ${JSON.stringify(configuredId)};
    const ENDPOINT = ${JSON.stringify(endpoint)};
    const API_KEY = ${JSON.stringify(apiKey)};
    const API_KEY_ENV = ${JSON.stringify(apiKeyEnv)};

    const modelSel = document.getElementById('model');
    const appSel = document.getElementById('app');
    const info = document.getElementById('model-info');
    const result = document.getElementById('config-result');

    // Group models by family, configured first, deprecated last.
    const families = { boundless: 'Boundless (OpenAI-compatible, tools)', native: 'Native (Workers AI)' };
    for (const family of ['boundless', 'native']) {
      const og = document.createElement('optgroup');
      og.label = families[family];
      for (const m of CATALOG.filter(m => m.family === family)) {
        const opt = document.createElement('option');
        opt.value = m.id;
        const tier = m.tier ? ' [' + m.tier + ']' : '';
        const cfg = m.configured ? ' ★' : '';
        const dep = m.status === 'deprecated' ? ' (deprecated)' : '';
        opt.textContent = m.name + tier + cfg + dep;
        if (m.id === CONFIGURED) opt.selected = true;
        og.appendChild(opt);
      }
      modelSel.appendChild(og);
    }
    for (const app of APPS) {
      const opt = document.createElement('option');
      opt.value = app.id;
      opt.textContent = app.label + ' (' + app.format + ')';
      appSel.appendChild(opt);
    }

    function updateInfo() {
      const m = CATALOG.find(x => x.id === modelSel.value);
      if (m) info.textContent = m.name + ' · ' + m.family + (m.tier ? ' · ' + m.tier + ' cost' : '') + (m.configured ? ' · configured' : '');
    }
    modelSel.onchange = updateInfo;
    updateInfo();

    function generate() {
      const modelId = modelSel.value;
      const app = APPS.find(a => a.id === appSel.value);
      const url = '/ccswitch?app=' + encodeURIComponent(app.id) + '&model=' + encodeURIComponent(modelId);
      const verb = app.importKind === 'ccswitch' ? 'Open in CC Switch' : 'View config snippet';
      result.innerHTML = '<p><a href="' + url + '"><button class="primary">' + verb + ' →</button></a></p>' +
        '<p><small>Endpoint: <code>' + ENDPOINT + '</code> · API key: <code>' + API_KEY + '</code>' +
        (app.importKind === 'snippet' ? ' · key env: <code>' + API_KEY_ENV + '</code>' : '') + '</small></p>';
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...corsHeaders()
    }
  });
}

function snippetPage(app: { label: string }, snippet: string, resolved?: { id: string; capabilities: { family: string } }): Response {
  const modelLine = resolved ? `<p>Model: <code>${escapeHtml(resolved.id)}</code> (${resolved.capabilities.family})</p>` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rosetta — ${escapeHtml(app.label)} config</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; max-width: 920px; line-height: 1.5; color: #111827; }
    pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f3f4f6; padding: 16px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; }
    a { color: #075985; }
    button { font: inherit; padding: 6px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; cursor: pointer; }
    button:hover { background: #f3f4f6; }
  </style>
</head>
<body>
  <h1>Rosetta — ${escapeHtml(app.label)}</h1>
  ${modelLine}
  <p>Copy this into your ${escapeHtml(app.label)} configuration:</p>
  <pre id="snippet">${escapeHtml(snippet)}</pre>
  <p><button onclick="navigator.clipboard.writeText(document.getElementById('snippet').textContent).then(()=>this.textContent='Copied ✓').catch(()=>{})">Copy</button></p>
  <p><a href="/">← back to Rosetta</a></p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...corsHeaders()
    }
  });
}

function publicBaseUrl(request: Request, env: Env): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function inferStatus(error: unknown): number {
  if (!error || typeof error !== "object") {
    return 502;
  }
  const record = error as Record<string, unknown>;
  const status = record.status ?? record.statusCode;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 502;
}

function inferErrorType(status: number): string {
  if (status === 401 || status === 403) {
    return "authentication_error";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  if (status === 413) {
    return "request_too_large";
  }
  if (status >= 500) {
    return "api_error";
  }
  return "invalid_request_error";
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-api-key,anthropic-version,anthropic-beta,openai-organization,openai-project"
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
