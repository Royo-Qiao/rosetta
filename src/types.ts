export interface Env {
  AI: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
  CF_AI_MODEL?: string;
  PUBLIC_BASE_URL?: string;
  GATEWAY_AUTH_TOKEN?: string;
  MAX_BODY_BYTES?: string;
}

export type AnthropicRole = "user" | "assistant";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | {
      type: string;
      [key: string]: unknown;
    };

export interface AnthropicMessageInput {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens?: number;
  messages: AnthropicMessageInput[];
  system?: string | AnthropicContentBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  metadata?: unknown;
  stop_sequences?: string[];
  thinking?: unknown;
  [key: string]: unknown;
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ConversionWarning {
  field: string;
  reason: string;
}

export interface ConvertedRequest {
  model: string;
  modelAlias: string;
  input: Record<string, unknown>;
  warnings: ConversionWarning[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
