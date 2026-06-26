import {
  AnthropicHttpError,
  anthropicError,
  anthropicMessageFromWorkersAI,
  convertAnthropicToWorkersAI,
  estimateTokensFromMessages,
  json,
  validateMessagesRequest
} from "./anthropic";
import { resolveModelCapabilities, catalogModels } from "./models";
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
        capabilities: resolved.capabilities
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
      metadata: {
        family: resolved.capabilities.family,
        tools: resolved.capabilities.tools,
        vision: resolved.capabilities.vision,
        reasoning: resolved.capabilities.reasoning,
        context_window: resolved.entry?.contextWindow,
        configured: true
      }
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
      metadata: {
        family: entry.family,
        tools: entry.tools,
        vision: entry.vision,
        reasoning: entry.reasoning,
        context_window: entry.contextWindow
      }
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

  return { object: "list", data };
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

  if (app.importKind === "ccswitch") {
    return Response.redirect(ccswitchUrl(app, endpoint, apiKey), 302);
  }

  const apiKeyEnv = env.GATEWAY_AUTH_TOKEN?.trim() ? "GATEWAY_AUTH_TOKEN" : "fake-key";
  const modelAlias = resolveModelCapabilities(undefined, env.CF_AI_MODEL).alias ?? "claude-sonnet-4-5";
  const snippet = appSnippet(app, endpoint, apiKey, apiKeyEnv, modelAlias);
  return snippetPage(app, snippet);
}

function homePage(request: Request, env: Env): Response {
  const endpoint = publicBaseUrl(request, env);
  const apiKey = env.GATEWAY_AUTH_TOKEN?.trim() || "fake-key";
  const resolved = resolveModelCapabilities(undefined, env.CF_AI_MODEL);

  const cards = APPS.map((app) => {
    const href = `/ccswitch?app=${app.id}`;
    const verb = app.importKind === "ccswitch" ? "Import into" : "Copy config for";
    return `<p><a href="${escapeHtml(href)}">${verb} ${escapeHtml(app.label)}</a> <small>(${app.format})</small></p>`;
  }).join("\n  ");

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
  </style>
</head>
<body>
  <h1>Rosetta</h1>
  <p>Anthropic-compatible gateway fronting Cloudflare Workers AI. Configure one model; import into Claude Code, opencode, Hermes, OpenClaw, or TRAE.</p>
  <p>Active model: <code>${escapeHtml(resolved.id)}</code> (${resolved.capabilities.family})</p>
  <pre>ANTHROPIC_BASE_URL=${escapeHtml(endpoint)}
ANTHROPIC_API_KEY=${escapeHtml(apiKey)}
ANTHROPIC_AUTH_TOKEN=${escapeHtml(apiKey)}</pre>
  ${cards}
  <p>Health: <a href="/health">/health</a> · Models: <a href="/v1/models">/v1/models</a></p>
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

function snippetPage(app: { label: string }, snippet: string): Response {
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
  </style>
</head>
<body>
  <h1>Rosetta — ${escapeHtml(app.label)}</h1>
  <p>Copy this into your ${escapeHtml(app.label)} configuration:</p>
  <pre>${escapeHtml(snippet)}</pre>
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
