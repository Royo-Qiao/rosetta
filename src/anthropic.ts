import { resolveModelCapabilities } from "./models";
import type { ModelCapabilities } from "./models";
import type {
  AnthropicContentBlock,
  AnthropicMessagesRequest,
  AnthropicTool,
  AnthropicToolUseBlock,
  ConversionWarning,
  ConvertedRequest,
  OpenAIMessage,
  OpenAIToolCall,
  Usage
} from "./types";

export function validateMessagesRequest(value: unknown): AnthropicMessagesRequest {
  if (!value || typeof value !== "object") {
    throw new AnthropicHttpError(400, "invalid_request_error", "Request body must be a JSON object.");
  }

  const request = value as Partial<AnthropicMessagesRequest>;
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new AnthropicHttpError(400, "invalid_request_error", "`messages` must be a non-empty array.");
  }

  for (const [index, message] of request.messages.entries()) {
    if (!message || typeof message !== "object") {
      throw new AnthropicHttpError(400, "invalid_request_error", `messages[${index}] must be an object.`);
    }
    if (message.role !== "user" && message.role !== "assistant") {
      throw new AnthropicHttpError(400, "invalid_request_error", `messages[${index}].role must be user or assistant.`);
    }
    if (typeof message.content !== "string" && !Array.isArray(message.content)) {
      throw new AnthropicHttpError(400, "invalid_request_error", `messages[${index}].content must be a string or content block array.`);
    }
  }

  if (request.max_tokens !== undefined && (!Number.isFinite(request.max_tokens) || request.max_tokens <= 0)) {
    throw new AnthropicHttpError(400, "invalid_request_error", "`max_tokens` must be a positive number.");
  }

  return request as AnthropicMessagesRequest;
}

export function convertAnthropicToWorkersAI(request: AnthropicMessagesRequest, configuredModel?: string): ConvertedRequest {
  const warnings: ConversionWarning[] = [];
  const messages: OpenAIMessage[] = [];
  const systemText = contentToText(request.system);
  const resolved = resolveModelCapabilities(request.model, configuredModel);
  const { capabilities } = resolved;
  const resolvedModel = resolved.id;

  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }

  for (const message of request.messages) {
    messages.push(...convertMessage(message.role, message.content, warnings));
  }

  const input: Record<string, unknown> = {
    messages,
    // Boundless models prefer max_completion_tokens; native models use max_tokens.
    [capabilities.family === "boundless" ? "max_completion_tokens" : "max_tokens"]:
      request.max_tokens ?? 1024
  };

  copyNumber(input, "temperature", request.temperature);
  copyNumber(input, "top_p", request.top_p);

  if (request.stream) {
    input.stream = true;
  }

  if (request.stop_sequences?.length) {
    input.stop = request.stop_sequences;
  }

  applyTools(input, request, capabilities, warnings);
  applyReasoning(input, request, capabilities, warnings);

  // top_k is a native-only sampling param; boundless models do not accept it.
  if (request.top_k !== undefined) {
    if (capabilities.family === "native") {
      copyNumber(input, "top_k", request.top_k);
    } else {
      warnings.push({ field: "top_k", reason: "This model does not accept top_k; ignored." });
    }
  }

  for (const warning of resolved.warnings) {
    warnings.push(warning);
  }

  return {
    model: resolvedModel,
    modelAlias: resolved.alias ?? request.model,
    input,
    warnings
  };
}

/** Attach tool definitions in the shape the model family expects. */
function applyTools(
  input: Record<string, unknown>,
  request: AnthropicMessagesRequest,
  capabilities: ModelCapabilities,
  warnings: ConversionWarning[]
): void {
  if (!request.tools?.length) {
    return;
  }

  if (capabilities.tools === "none") {
    warnings.push({ field: "tools", reason: "This model does not accept tool definitions; tools were dropped." });
    if (request.tool_choice && request.tool_choice !== "auto") {
      warnings.push({ field: "tool_choice", reason: "tool_choice ignored because the model does not accept tools." });
    }
    return;
  }

  input.tools = request.tools.map((tool) =>
    capabilities.tools === "native" ? convertToolNative(tool) : convertTool(tool)
  );

  if (capabilities.tools === "native") {
    // Native tool_choice is undocumented; only forward the harmless "auto".
    if (request.tool_choice && request.tool_choice !== "auto") {
      warnings.push({ field: "tool_choice", reason: "Native tool_choice is undocumented; downgraded to auto." });
    }
    input.tool_choice = "auto";
    return;
  }

  input.tool_choice = convertToolChoice(request.tool_choice, warnings);
}

/** Map Anthropic reasoning (thinking) settings onto the model's mechanism. */
function applyReasoning(
  input: Record<string, unknown>,
  request: AnthropicMessagesRequest,
  capabilities: ModelCapabilities,
  warnings: ConversionWarning[]
): void {
  if (capabilities.reasoning === "none") {
    if (request.thinking !== undefined) {
      warnings.push({ field: "thinking", reason: "This model does not expose a reasoning control; thinking settings were ignored." });
    }
    return;
  }

  if (capabilities.reasoning === "kimi-thinking") {
    // Kimi defaults: thinking=true (on), clear_thinking=false (preserve reasoning across turns).
    // Honour an explicit Anthropic `thinking.type:"disabled"`; otherwise leave reasoning on.
    const thinkingDisabled =
      typeof request.thinking === "object" && request.thinking !== null &&
      (request.thinking as { type?: string }).type === "disabled";
    input.chat_template_kwargs = {
      thinking: !thinkingDisabled,
      clear_thinking: false
    };
    if (!thinkingDisabled && request.thinking !== undefined) {
      warnings.push({ field: "thinking", reason: "Anthropic thinking approximated for Kimi via chat_template_kwargs.thinking." });
    }
    return;
  }

  // reasoning-effort family: map a budget to low/medium/high when present.
  if (request.thinking !== undefined) {
    const effort = thinkingToEffort(request.thinking);
    if (effort) {
      input.reasoning_effort = effort;
    } else {
      warnings.push({ field: "thinking", reason: "Anthropic thinking was approximated as reasoning_effort for this model." });
    }
  }
}

function thinkingToEffort(thinking: unknown): "low" | "medium" | "high" | undefined {
  if (typeof thinking !== "object" || thinking === null) {
    return undefined;
  }
  const record = thinking as { type?: string; budget_tokens?: unknown };
  if (record.type === "disabled") {
    return undefined;
  }
  const budget = typeof record.budget_tokens === "number" ? record.budget_tokens : undefined;
  if (budget === undefined) {
    return "medium";
  }
  if (budget <= 4096) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

export function anthropicMessageFromWorkersAI(
  upstream: unknown,
  modelAlias: string,
  warnings: ConversionWarning[] = []
): Record<string, unknown> {
  const message = extractAssistantMessage(upstream);
  const text = extractText(upstream, message);
  const toolCalls = extractToolCalls(upstream, message);
  const content: unknown[] = [];

  if (text) {
    content.push({ type: "text", text });
  }

  for (const call of toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: parseJsonObject(call.function.arguments)
    });
  }

  const usage = normalizeUsage(upstream, text);
  return {
    id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: modelAlias,
    content,
    stop_reason: toolCalls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage,
    metadata: warnings.length ? { compatibility_warnings: warnings } : undefined
  };
}

export function estimateTokensFromMessages(request: AnthropicMessagesRequest): number {
  const text = [
    contentToText(request.system),
    ...request.messages.map((message) => contentToText(message.content)),
    ...(request.tools ?? []).map((tool) => JSON.stringify(tool))
  ]
    .filter(Boolean)
    .join("\n");

  return estimateTokens(text);
}

export function anthropicError(status: number, type: string, message: string, detail?: unknown): Response {
  return json(
    {
      type: "error",
      error: {
        type,
        message,
        ...(detail === undefined ? {} : { detail })
      }
    },
    status
  );
}

export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

export class AnthropicHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string,
    message: string,
    public readonly detail?: unknown
  ) {
    super(message);
  }
}

function convertMessage(
  role: "user" | "assistant",
  content: string | AnthropicContentBlock[],
  warnings: ConversionWarning[]
): OpenAIMessage[] {
  if (typeof content === "string") {
    return [{ role, content }];
  }

  if (role === "assistant") {
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];

    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (isToolUseBlock(block)) {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: stringifyToolInput(block.input)
          }
        });
      } else {
        warnings.push({ field: `assistant.content.${block.type}`, reason: "Unsupported assistant content block was ignored." });
      }
    }

    return [
      {
        role: "assistant",
        content: textParts.join("\n") || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      }
    ];
  }

  const userMessages: OpenAIMessage[] = [];
  const textParts: string[] = [];

  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      if (textParts.length) {
        userMessages.push({ role: "user", content: textParts.splice(0).join("\n") });
      }
      userMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: contentToText(block.content) || (block.is_error ? "Tool returned an error." : "")
      });
    } else {
      warnings.push({ field: `user.content.${block.type}`, reason: "Unsupported user content block was converted to text if possible." });
      const fallback = contentToText(block);
      if (fallback) {
        textParts.push(fallback);
      }
    }
  }

  if (textParts.length || userMessages.length === 0) {
    userMessages.push({ role: "user", content: textParts.join("\n") });
  }

  return userMessages;
}

function convertTool(tool: AnthropicTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.input_schema ?? { type: "object", properties: {} }
    }
  };
}

/** Native Workers AI tool shape: flat `{name, description, parameters}` (no OpenAI wrapper). */
function convertToolNative(tool: AnthropicTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.input_schema ?? { type: "object", properties: {} }
  };
}

function convertToolChoice(toolChoice: unknown, warnings: ConversionWarning[]): unknown {
  if (!toolChoice || toolChoice === "auto") {
    return "auto";
  }
  if (typeof toolChoice === "object" && "type" in toolChoice) {
    const choice = toolChoice as { type?: unknown; name?: unknown };
    if (choice.type === "any" || choice.type === "auto") {
      return "auto";
    }
    if (choice.type === "tool" && typeof choice.name === "string") {
      return { type: "function", function: { name: choice.name } };
    }
  }
  warnings.push({ field: "tool_choice", reason: "Unsupported tool_choice was downgraded to auto." });
  return "auto";
}

function copyNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}

export function contentToText(content: unknown): string {
  if (content === undefined || content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(contentToText).filter(Boolean).join("\n");
  }
  if (typeof content !== "object") {
    return String(content);
  }

  const block = content as Record<string, unknown>;
  if (block.type === "text" && typeof block.text === "string") {
    return block.text;
  }
  if (block.type === "tool_result") {
    return contentToText(block.content);
  }
  if (typeof block.text === "string") {
    return block.text;
  }
  return "";
}

function isToolUseBlock(block: AnthropicContentBlock): block is AnthropicToolUseBlock {
  return block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string";
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
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
  const fromMessage = message?.content;
  if (typeof fromMessage === "string") {
    return fromMessage;
  }

  if (!upstream || typeof upstream !== "object") {
    return typeof upstream === "string" ? upstream : "";
  }

  const value = upstream as Record<string, unknown>;
  for (const key of ["response", "text", "generated_text", "output_text", "result"]) {
    if (typeof value[key] === "string") {
      return value[key] as string;
    }
  }

  const content = value.content;
  if (Array.isArray(content)) {
    return content.map((item) => extractText(item)).filter(Boolean).join("");
  }

  const output = value.output;
  if (Array.isArray(output)) {
    return output.map((item) => extractText(item)).filter(Boolean).join("");
  }

  return "";
}

function extractToolCalls(upstream: unknown, message?: Record<string, unknown>): OpenAIToolCall[] {
  const candidates = [message?.tool_calls, objectValue(upstream, "tool_calls")];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    return candidate
      .map((call, index) => normalizeToolCall(call, index))
      .filter((call): call is OpenAIToolCall => Boolean(call));
  }
  return [];
}

function normalizeToolCall(call: unknown, index: number): OpenAIToolCall | undefined {
  if (!call || typeof call !== "object") {
    return undefined;
  }
  const value = call as Record<string, unknown>;
  const fn = value.function && typeof value.function === "object" ? (value.function as Record<string, unknown>) : value;
  const name = typeof fn.name === "string" ? fn.name : undefined;
  if (!name) {
    return undefined;
  }
  const args = fn.arguments ?? value.arguments ?? {};
  return {
    id: typeof value.id === "string" ? value.id : `toolu_${index}_${crypto.randomUUID().slice(0, 8)}`,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : stringifyToolInput(args)
    }
  };
}

function normalizeUsage(upstream: unknown, text: string): Usage {
  const usage = objectValue(upstream, "usage");
  if (usage && typeof usage === "object") {
    const record = usage as Record<string, unknown>;
    return {
      input_tokens: numberOr(record.input_tokens, numberOr(record.prompt_tokens, 0)),
      output_tokens: numberOr(record.output_tokens, numberOr(record.completion_tokens, estimateTokens(text)))
    };
  }
  return {
    input_tokens: 0,
    output_tokens: estimateTokens(text)
  };
}

function objectValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseJsonObject(value: string): unknown {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}
