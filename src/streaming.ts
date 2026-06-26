import { anthropicError } from "./anthropic";
import type { ConversionWarning, OpenAIToolCall } from "./types";

interface StreamState {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  encoder: TextEncoder;
  modelAlias: string;
  textStarted: boolean;
  toolBlocks: Map<number, { blockIndex: number; id: string; name: string }>;
  nextBlockIndex: number;
  outputText: string;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
}

export function anthropicStreamFromWorkersAI(
  upstream: unknown,
  modelAlias: string,
  warnings: ConversionWarning[] = []
): Response {
  const body = new TransformStream();
  const writer = body.writable.getWriter();
  const encoder = new TextEncoder();
  const state: StreamState = {
    writer,
    encoder,
    modelAlias,
    textStarted: false,
    toolBlocks: new Map(),
    nextBlockIndex: 0,
    outputText: "",
    stopReason: "end_turn"
  };

  void pumpStream(upstream, state, warnings);

  return new Response(body.readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}

async function pumpStream(upstream: unknown, state: StreamState, warnings: ConversionWarning[]): Promise<void> {
  try {
    await writeEvent(state, "message_start", {
      type: "message_start",
      message: {
        id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "message",
        role: "assistant",
        model: state.modelAlias,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        metadata: warnings.length ? { compatibility_warnings: warnings } : undefined
      }
    });

    await writeTextDelta(state, "");

    const resolvedUpstream = await upstream;
    const stream = toReadableStream(resolvedUpstream);
    if (!stream) {
      const text = extractTextDelta(resolvedUpstream);
      if (text) {
        await writeTextDelta(state, text);
      }
      await finishStream(state);
      return;
    }

    let buffer = "";
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
        await handleUpstreamEvent(state, event);
      }
    }
    buffer += decoder.decode();

    const trimmed = buffer.trim();
    if (trimmed) {
      await handleUpstreamEvent(state, trimmed);
    }

    await finishStream(state);
  } catch (error) {
    await writeEvent(state, "error", {
      type: "error",
      error: {
        type: "api_error",
        message: error instanceof Error ? error.message : "Streaming failed."
      }
    });
    await state.writer.close();
  }
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

async function handleUpstreamEvent(state: StreamState, data: string): Promise<void> {
  if (!data || data === "[DONE]") {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    await writeTextDelta(state, data);
    return;
  }

  const text = extractTextDelta(parsed);
  const toolCalls = extractToolCallDeltas(parsed);
  if (!text && toolCalls.length === 0 && shouldPrimeTextStream(parsed) && !state.textStarted) {
    await writeTextDelta(state, "");
  }
  if (text) {
    await writeTextDelta(state, text);
  }

  for (const call of toolCalls) {
    await writeToolDelta(state, call);
  }

  const finishReason = extractFinishReason(parsed);
  if (finishReason === "tool_calls" || finishReason === "function_call") {
    state.stopReason = "tool_use";
  } else if (finishReason === "length") {
    state.stopReason = "max_tokens";
  } else if (finishReason === "stop") {
    state.stopReason = state.stopReason === "tool_use" ? "tool_use" : "end_turn";
  }
}

function shouldPrimeTextStream(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return false;
  }
  const first = choices[0] as Record<string, unknown>;
  const delta = first.delta;
  if (!delta || typeof delta !== "object") {
    return false;
  }
  const chunk = delta as Record<string, unknown>;
  return (
    chunk.role === "assistant" ||
    chunk.content === "" ||
    typeof chunk.reasoning_content === "string" ||
    typeof chunk.reasoning === "string"
  );
}

async function writeTextDelta(state: StreamState, text: string): Promise<void> {
  if (!state.textStarted) {
    await writeEvent(state, "content_block_start", {
      type: "content_block_start",
      index: state.nextBlockIndex,
      content_block: { type: "text", text: "" }
    });
    state.nextBlockIndex += 1;
    state.textStarted = true;
  }

  state.outputText += text;
  await writeEvent(state, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text }
  });
}

async function writeToolDelta(state: StreamState, call: Partial<OpenAIToolCall> & { index: number }): Promise<void> {
  let block = state.toolBlocks.get(call.index);
  const name = call.function?.name;
  const id = call.id;

  if (!block) {
    if (!name && !id) {
      return;
    }
    block = {
      blockIndex: state.nextBlockIndex,
      id: id ?? `toolu_${crypto.randomUUID().slice(0, 12)}`,
      name: name ?? "tool"
    };
    state.toolBlocks.set(call.index, block);
    state.nextBlockIndex += 1;
    state.stopReason = "tool_use";
    await writeEvent(state, "content_block_start", {
      type: "content_block_start",
      index: block.blockIndex,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
    });
  }

  const partialJson = call.function?.arguments ?? "";
  if (partialJson) {
    await writeEvent(state, "content_block_delta", {
      type: "content_block_delta",
      index: block.blockIndex,
      delta: { type: "input_json_delta", partial_json: partialJson }
    });
  }
}

async function finishStream(state: StreamState): Promise<void> {
  if (state.textStarted) {
    await writeEvent(state, "content_block_stop", { type: "content_block_stop", index: 0 });
  }

  for (const block of state.toolBlocks.values()) {
    await writeEvent(state, "content_block_stop", { type: "content_block_stop", index: block.blockIndex });
  }

  await writeEvent(state, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: state.stopReason, stop_sequence: null },
    usage: { output_tokens: Math.max(0, Math.ceil(state.outputText.length / 4)) }
  });
  await writeEvent(state, "message_stop", { type: "message_stop" });
  await state.writer.close();
}

async function writeEvent(state: StreamState, event: string, data: unknown): Promise<void> {
  await state.writer.write(state.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
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

function extractToolCallDeltas(value: unknown): Array<Partial<OpenAIToolCall> & { index: number }> {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const delta = first.delta as Record<string, unknown> | undefined;
    const toolCalls = delta?.tool_calls;
    if (Array.isArray(toolCalls)) {
      return toolCalls
        .map((call, fallbackIndex) => normalizeToolCallDelta(call, fallbackIndex))
        .filter((call): call is Partial<OpenAIToolCall> & { index: number } => Boolean(call));
    }
  }

  const toolCalls = record.tool_calls;
  if (Array.isArray(toolCalls)) {
    return toolCalls
      .map((call, fallbackIndex) => normalizeToolCallDelta(call, fallbackIndex))
      .filter((call): call is Partial<OpenAIToolCall> & { index: number } => Boolean(call));
  }

  return [];
}

function normalizeToolCallDelta(call: unknown, fallbackIndex: number): (Partial<OpenAIToolCall> & { index: number }) | undefined {
  if (!call || typeof call !== "object") {
    return undefined;
  }
  const record = call as Record<string, unknown>;
  const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : {};
  return {
    index: typeof record.index === "number" ? record.index : fallbackIndex,
    id: typeof record.id === "string" ? record.id : undefined,
    type: "function",
    function: {
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof fn.arguments === "string" ? fn.arguments : ""
    }
  };
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

export function streamErrorResponse(status: number, type: string, message: string): Response {
  if (!isSseStatus(status)) {
    return anthropicError(status, type, message);
  }
  const payload = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message } })}\n\n`;
  return new Response(payload, {
    status,
    headers: { "content-type": "text/event-stream; charset=utf-8" }
  });
}

function isSseStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
