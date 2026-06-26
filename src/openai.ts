import { AnthropicHttpError, json } from "./anthropic";
import { resolveModelCapabilities } from "./models";

export interface OpenAIChatRequest {
  model?: string;
  messages: Array<Record<string, unknown>>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;
}

interface OpenAIStreamState {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  encoder: TextEncoder;
  id: string;
  model: string;
}

export function validateOpenAIChatRequest(value: unknown): OpenAIChatRequest {
  if (!value || typeof value !== "object") {
    throw new AnthropicHttpError(400, "invalid_request_error", "Request body must be a JSON object.");
  }

  const request = value as Partial<OpenAIChatRequest>;
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new AnthropicHttpError(400, "invalid_request_error", "`messages` must be a non-empty array.");
  }

  if (request.max_tokens !== undefined && (!Number.isFinite(request.max_tokens) || request.max_tokens <= 0)) {
    throw new AnthropicHttpError(400, "invalid_request_error", "`max_tokens` must be a positive number.");
  }

  return request as OpenAIChatRequest;
}

export function convertOpenAIToWorkersAI(request: OpenAIChatRequest, configuredModel?: string): { model: string; input: Record<string, unknown> } {
  const resolved = resolveModelCapabilities(request.model, configuredModel);
  const { capabilities } = resolved;
  const input: Record<string, unknown> = {
    messages: request.messages,
    [capabilities.family === "boundless" ? "max_completion_tokens" : "max_tokens"]:
      request.max_tokens ?? 1024
  };

  copyNumber(input, "temperature", request.temperature);
  copyNumber(input, "top_p", request.top_p);

  if (request.stream) {
    input.stream = true;
  }
  if (request.stop) {
    input.stop = request.stop;
  }
  if (request.tools?.length) {
    if (capabilities.tools === "none") {
      // OpenAI clients send tools as the OpenAI shape; for non-tool models, drop them.
      delete input.tools;
    } else if (capabilities.tools === "native") {
      input.tools = (request.tools as Array<Record<string, unknown>>).map((tool) => unwrapOpenAITool(tool));
      input.tool_choice = "auto";
    } else {
      input.tools = request.tools;
    }
  }
  if (capabilities.tools === "openai" && request.tool_choice) {
    input.tool_choice = request.tool_choice;
  }

  return { model: resolved.id, input };
}

/** Convert an OpenAI-wrapped tool `{type:"function",function:{name,description,parameters}}` to native flat shape. */
function unwrapOpenAITool(tool: Record<string, unknown>): Record<string, unknown> {
  const fn = (tool.function && typeof tool.function === "object" ? tool.function : tool) as Record<string, unknown>;
  return {
    name: fn.name,
    description: fn.description ?? "",
    parameters: fn.parameters ?? { type: "object", properties: {} }
  };
}

export function openAIChatCompletionFromWorkersAI(upstream: unknown, requestedModel: string): Response {
  const message = extractAssistantMessage(upstream);
  const text = extractText(upstream, message);
  const toolCalls = extractToolCalls(upstream, message);
  const finishReason = toolCalls.length ? "tool_calls" : "stop";

  return json({
    id: `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        },
        finish_reason: finishReason
      }
    ],
    usage: normalizeUsage(upstream, text)
  });
}

export function openAIChatCompletionStreamFromWorkersAI(upstream: unknown, requestedModel: string): Response {
  const body = new TransformStream();
  const state: OpenAIStreamState = {
    writer: body.writable.getWriter(),
    encoder: new TextEncoder(),
    id: `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`,
    model: requestedModel
  };

  void pumpOpenAIStream(upstream, state);

  return new Response(body.readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}

async function pumpOpenAIStream(upstream: unknown, state: OpenAIStreamState): Promise<void> {
  try {
    await writeChunk(state, { role: "assistant", content: "" }, null);
    const resolved = await upstream;
    const stream = toReadableStream(resolved);
    if (!stream) {
      const text = extractText(resolved);
      if (text) {
        await writeChunk(state, { content: text }, null);
      }
      await finishOpenAIStream(state, "stop");
      return;
    }

    let buffer = "";
    let finishReason = "stop";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const next = processBufferedSse(buffer);
      buffer = next.remainder;
      for (const event of next.events) {
        const reason = await handleUpstreamEvent(state, event);
        if (reason) {
          finishReason = reason;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const reason = await handleUpstreamEvent(state, buffer.trim());
      if (reason) {
        finishReason = reason;
      }
    }
    await finishOpenAIStream(state, finishReason);
  } catch (error) {
    await writeSse(state, {
      id: state.id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [{ index: 0, delta: { content: error instanceof Error ? error.message : "Workers AI stream failed." }, finish_reason: "stop" }]
    });
    await finishOpenAIStream(state, "stop");
  }
}

async function handleUpstreamEvent(state: OpenAIStreamState, data: string): Promise<string | undefined> {
  if (!data || data === "[DONE]") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    await writeChunk(state, { content: data }, null);
    return undefined;
  }

  const text = extractTextDelta(parsed);
  if (text) {
    await writeChunk(state, { content: text }, null);
  }

  for (const toolCall of extractToolCallDeltas(parsed)) {
    await writeChunk(state, { tool_calls: [toolCall] }, null);
  }

  const finishReason = extractFinishReason(parsed);
  if (finishReason === "tool_calls" || finishReason === "function_call") {
    return "tool_calls";
  }
  if (finishReason === "length") {
    return "length";
  }
  if (finishReason === "stop") {
    return "stop";
  }
  return undefined;
}

async function writeChunk(state: OpenAIStreamState, delta: Record<string, unknown>, finishReason: string | null): Promise<void> {
  await writeSse(state, {
    id: state.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  });
}

async function finishOpenAIStream(state: OpenAIStreamState, finishReason: string): Promise<void> {
  await writeChunk(state, {}, finishReason);
  await state.writer.write(state.encoder.encode("data: [DONE]\n\n"));
  await state.writer.close();
}

async function writeSse(state: OpenAIStreamState, value: unknown): Promise<void> {
  await state.writer.write(state.encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
}

function processBufferedSse(buffer: string): { events: string[]; remainder: string } {
  const events: string[] = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = parts.pop() ?? "";
  for (const part of parts) {
    const dataLines = part
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length) {
      events.push(dataLines.join("\n"));
    } else if (part.trim()) {
      events.push(part.trim());
    }
  }
  return { events, remainder };
}

function toReadableStream(value: unknown): ReadableStream<Uint8Array> | undefined {
  if (value instanceof ReadableStream) {
    return value as ReadableStream<Uint8Array>;
  }
  if (value instanceof Response && value.body) {
    return value.body;
  }
  if (value && typeof value === "object" && "body" in value && value.body instanceof ReadableStream) {
    return value.body as ReadableStream<Uint8Array>;
  }
  return undefined;
}

function extractAssistantMessage(upstream: unknown): Record<string, unknown> | undefined {
  if (!upstream || typeof upstream !== "object") {
    return undefined;
  }
  const value = upstream as Record<string, unknown>;
  const choices = value.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    if (first.message && typeof first.message === "object") {
      return first.message as Record<string, unknown>;
    }
  }
  if (value.message && typeof value.message === "object") {
    return value.message as Record<string, unknown>;
  }
  return undefined;
}

function extractText(upstream: unknown, message?: Record<string, unknown>): string {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (typeof upstream === "string") {
    return upstream;
  }
  if (!upstream || typeof upstream !== "object") {
    return "";
  }
  const value = upstream as Record<string, unknown>;
  for (const key of ["response", "text", "generated_text", "output_text", "result"]) {
    if (typeof value[key] === "string") {
      return value[key] as string;
    }
  }
  return "";
}

function extractTextDelta(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  for (const key of ["response", "text", "generated_text", "output_text"]) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }
  // Responses-API streaming delta.
  if (record.type === "response.output_text.delta" && typeof record.delta === "string") {
    return record.delta;
  }
  const content = record.content;
  if (Array.isArray(content)) {
    return content.map(extractTextDelta).filter(Boolean).join("");
  }
  const output = record.output;
  if (Array.isArray(output)) {
    return output.map(extractTextDelta).filter(Boolean).join("");
  }
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const delta = first.delta as Record<string, unknown> | undefined;
    if (typeof delta?.content === "string") {
      return delta.content;
    }
    const message = first.message as Record<string, unknown> | undefined;
    if (typeof message?.content === "string") {
      return message.content;
    }
  }
  return "";
}

function extractToolCalls(upstream: unknown, message?: Record<string, unknown>): unknown[] {
  const candidates = [message?.tool_calls, objectValue(upstream, "tool_calls")];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function extractToolCallDeltas(value: unknown): unknown[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const calls: unknown[] = [];

  // Top-level tool_calls (native / Responses-API streaming).
  if (Array.isArray(record.tool_calls)) {
    calls.push(...record.tool_calls);
  }

  const choices = record.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") {
        continue;
      }
      const delta = (choice as Record<string, unknown>).delta as Record<string, unknown> | undefined;
      if (Array.isArray(delta?.tool_calls)) {
        calls.push(...delta.tool_calls);
      }
    }
  }
  return calls;
}

function extractFinishReason(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const choices = (value as Record<string, unknown>).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    return typeof first.finish_reason === "string" ? first.finish_reason : undefined;
  }
  return undefined;
}

function normalizeUsage(upstream: unknown, text: string): Record<string, number> {
  const usage = objectValue(upstream, "usage");
  if (usage && typeof usage === "object") {
    const record = usage as Record<string, unknown>;
    const prompt = numberOr(record.prompt_tokens, numberOr(record.input_tokens, 0));
    const completion = numberOr(record.completion_tokens, numberOr(record.output_tokens, estimateTokens(text)));
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  }
  const completion = estimateTokens(text);
  return { prompt_tokens: 0, completion_tokens: completion, total_tokens: completion };
}

function objectValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function copyNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}
