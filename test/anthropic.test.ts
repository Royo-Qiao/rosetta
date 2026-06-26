import { describe, expect, it } from "vitest";
import {
  anthropicMessageFromWorkersAI,
  convertAnthropicToWorkersAI,
  estimateTokensFromMessages,
  validateMessagesRequest
} from "../src/anthropic";
import { anthropicStreamFromWorkersAI } from "../src/streaming";

describe("Anthropic compatibility conversion", () => {
  it("converts a basic Anthropic request to Workers AI chat input", () => {
    const request = validateMessagesRequest({
      model: "claude-sonnet-4-5",
      system: "Be brief.",
      max_tokens: 128,
      messages: [{ role: "user", content: "Hello" }]
    });

    const converted = convertAnthropicToWorkersAI(request);

    expect(converted.model).toBe("@cf/moonshotai/kimi-k2.7-code");
    expect(converted.input).toMatchObject({
      max_completion_tokens: 128,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hello" }
      ]
    });
  });

  it("maps Anthropic tools and tool results to OpenAI-style chat messages", () => {
    const request = validateMessagesRequest({
      model: "claude-sonnet-4-5",
      max_tokens: 256,
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } }
        }
      ],
      messages: [
        { role: "user", content: "Read package.json" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "read_file",
              input: { path: "package.json" }
            }
          ]
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]
        }
      ]
    });

    const converted = convertAnthropicToWorkersAI(request);

    expect(converted.input.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } }
        }
      }
    ]);
    expect(converted.input.messages).toEqual([
      { role: "user", content: "Read package.json" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"package.json\"}" }
          }
        ]
      },
      { role: "tool", tool_call_id: "toolu_1", content: "ok" }
    ]);
  });

  it("maps Workers AI text responses to Anthropic messages", () => {
    const response = anthropicMessageFromWorkersAI({ response: "Hello from CF", usage: { prompt_tokens: 3, completion_tokens: 4 } }, "claude-sonnet-4-5");

    expect(response).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "Hello from CF" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 4 }
    });
  });

  it("maps OpenAI Responses API output arrays to Anthropic text blocks", () => {
    const response = anthropicMessageFromWorkersAI(
      {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "OK" }]
          }
        ],
        usage: { input_tokens: 9, output_tokens: 1 }
      },
      "claude-sonnet-4-5"
    );

    expect(response).toMatchObject({
      content: [{ type: "text", text: "OK" }],
      usage: { input_tokens: 9, output_tokens: 1 }
    });
  });

  it("maps Workers AI tool calls to Anthropic tool_use blocks", () => {
    const response = anthropicMessageFromWorkersAI(
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
                }
              ]
            }
          }
        ]
      },
      "claude-sonnet-4-5"
    );

    expect(response.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "read_file",
        input: { path: "README.md" }
      }
    ]);
    expect(response.stop_reason).toBe("tool_use");
  });

  it("estimates tokens instead of failing count_tokens", () => {
    const request = validateMessagesRequest({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "12345678" }]
    });

    expect(estimateTokensFromMessages(request)).toBe(2);
  });

  it("converts OpenAI-style streaming chunks to Anthropic SSE", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    const response = anthropicStreamFromWorkersAI(upstream, "claude-sonnet-4-5");
    const text = await response.text();

    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_start");
    expect(text).toContain('"text":"Hel"');
    expect(text).toContain('"text":"lo"');
    expect(text).toContain("event: message_delta");
    expect(text).toContain("event: message_stop");
  });

  it("converts Responses API streaming deltas to Anthropic SSE", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"O"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"K"}\n\n'));
        controller.close();
      }
    });

    const response = anthropicStreamFromWorkersAI(upstream, "claude-sonnet-4-5");
    const text = await response.text();

    expect(text).toContain('"text":"O"');
    expect(text).toContain('"text":"K"');
    expect(text).toContain("event: message_stop");
  });

  it("starts Anthropic SSE before a delayed Workers AI stream resolves", async () => {
    let resolveUpstream: (stream: ReadableStream<Uint8Array>) => void = () => {};
    const upstream = new Promise<ReadableStream<Uint8Array>>((resolve) => {
      resolveUpstream = resolve;
    });

    const response = anthropicStreamFromWorkersAI(upstream, "claude-sonnet-4-5");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let initial = "";
    while (!initial.includes("event: content_block_start")) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      initial += decoder.decode(chunk.value, { stream: true });
    }

    expect(initial).toContain("event: message_start");
    expect(initial).toContain("event: content_block_start");

    resolveUpstream(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n'));
          controller.close();
        }
      })
    );

    while (!(await reader.read()).done) {
      // drain stream to avoid leaving the pump with a cancelled writer
    }
  });
});
