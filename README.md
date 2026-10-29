# Rosetta — Cloudflare Workers AI gateway for Anthropic and OpenAI clients

An Anthropic-compatible gateway that fronts **Cloudflare Workers AI**. Set one model in config; import the provider into Claude Code, opencode, Hermes, OpenClaw, or TRAE. Rosetta translates the Anthropic Messages API (and an OpenAI Chat Completions route) onto each Workers AI model family's native contract.

A practical compatibility layer, not a full Anthropic API implementation.

Use it when a client expects the Anthropic Messages or OpenAI Chat Completions
format but inference should run on your Cloudflare Workers AI configuration.
`claude-*` compatibility aliases route to that configured Workers AI model; they
do not select Anthropic-hosted Claude models.

[Quickstart](#quickstart) · [Client configuration](#import-into-clients) ·
[Supported API routes](#endpoints) · [Compatibility limits](#compatibility-notes)

## Quickstart

The repository uses Node/npm and Wrangler. Start from your own Cloudflare account
with Workers AI access. Before deploying a personal instance, edit `wrangler.toml`:
replace the checked-in `USAGE_KV` namespace ID, `PUBLIC_BASE_URL`, and optional
custom-domain `[[routes]]` entry with resources you control. Choose `CF_AI_MODEL`
and configure `GATEWAY_AUTH_TOKEN` as described below.

```sh
git clone https://github.com/Royo-Qiao/rosetta.git
cd rosetta
npm install
npm test
npm run typecheck
npm run dev
```

When your configuration is ready, the deployment command is:

```sh
npm run deploy
```

These commands are defined in [package.json](package.json). After deployment,
open your Worker URL to generate the client configuration. To inspect the
configured model and service metadata:

```sh
curl https://your-worker.workers.dev/health
```

Expected fields include `"ok": true` and `"service": "rosetta"`. This route reports
configuration metadata; it does not perform an inference request or prove a
client's end-to-end tool-use compatibility.

## Endpoints

- `POST /v1/messages` — Anthropic Messages API
- `POST /v1/messages/count_tokens`
- `POST /v1/chat/completions` (and `/chat/completions`) — OpenAI Chat Completions
- `GET /v1/models`
- `GET /health`
- `GET /ccswitch?app=<claude|opencode|openclaw|hermes|trae>`
- `GET /` — config + import links

## Configure

`wrangler.toml` binds Workers AI as `env.AI`. Configure these variables for your deployment:

```toml
[vars]
CF_AI_MODEL = "@cf/moonshotai/kimi-k2.7-code"
PUBLIC_BASE_URL = ""
GATEWAY_AUTH_TOKEN = ""
MAX_BODY_BYTES = "2000000"
```

- **`CF_AI_MODEL`** — any Cloudflare Workers AI text model. See `/v1/models` for the full list (Llama, Qwen, Mistral, DeepSeek, GLM, Gemma, Nemotron, GPT-OSS, Granite, Kimi, …). One model is configured; Anthropic `claude-*` names map to it.
- **`GATEWAY_AUTH_TOKEN`** — leave empty to accept any Bearer token (including `fake-key`); set it to require `Authorization: Bearer <token>` or `x-api-key: <token>`.

## Models — two families

Workers AI exposes two model families with different I/O contracts; Rosetta adapts to whichever model you configure:

| Family | Models | Output | Tool shape |
|---|---|---|---|
| **Boundless** (OpenAI-compatible) | Kimi K2.x, GLM 5.2 / 4.7-flash, Gemma-4, Nemotron-3 | OpenAI `{choices}` | `{type:"function",function:{...}}` |
| **Native** | Llama 3.x/4, Qwen, Mistral, DeepSeek-R1, GPT-OSS, Granite | `{response, usage, tool_calls}` | flat `{name,description,parameters}` |

Rosetta emits the matching tool shape, token field (`max_completion_tokens` vs `max_tokens`), and reasoning control per model. **Boundless models are recommended for tool-heavy clients** (Claude Code) — the default `kimi-k2.7-code` is Boundless. Native function-calling input is best-effort (undocumented outside Cloudflare's function-calling guide).

### Reasoning

- Kimi → `chat_template_kwargs.thinking` (on by default; respects an explicit `thinking.type:"disabled"`).
- Other Boundless reasoning models → `reasoning_effort` (`low`/`medium`/`high`), mapped from Anthropic `thinking.budget_tokens`.
- Native reasoning models (QwQ, DeepSeek-R1, Qwen3) → inherent, no control forwarded.

### Not supported yet

- **Vision input**: image blocks are dropped with a warning. Vision-capable models (Kimi, Gemma-4, Llama-3.2-11B-Vision, Llama-4-Scout, Mistral-Small-3.1) will not receive images in this release.
- Prompt caching, extended thinking beyond the approximation above, and complex agentic tool-use behavior can differ materially from real Anthropic models.

## Import into clients

After deploy, open the Worker root page (`/`) — a one-click configurator lets you pick a model and a client, then generates the matching config or import link. Each is also reachable directly at `/ccswitch?app=<id>&model=<id>`.

| Client | `app=` | Mechanism | API format |
|---|---|---|---|
| Claude Code | `claude` | ccswitch deep link | Anthropic |
| opencode | `opencode` | ccswitch deep link | OpenAI (`/v1`) |
| OpenClaw | `openclaw` | ccswitch deep link | Anthropic |
| Hermes Agent | `hermes` | `config.yaml` snippet | Anthropic |
| TRAE | `trae` | Settings-UI instructions | Anthropic |

Claude Code / OpenClaw / Hermes / TRAE speak the Anthropic Messages API against the bare worker URL; opencode's custom-provider path is OpenAI Chat Completions, so its endpoint gets a `/v1` suffix. [CC Switch](https://github.com/farion1231/cc-switch) handles the `ccswitch://` deep links for the first three.

```sh
ANTHROPIC_BASE_URL=https://your-worker.workers.dev
ANTHROPIC_API_KEY=fake-key
ANTHROPIC_AUTH_TOKEN=fake-key
```

## Cost tiers

The values in this section describe the repository's model registry in
[`src/models.ts`](src/models.ts), whose catalog notes were checked on 2026-06-26.
They are not a live pricing or billing query. Check the current
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
for your account before making a cost estimate.

The registry encodes a shared **10,000 Neurons/day** free allowance, a Workers Paid plan amount of **$5/mo**, and **$0.011 per 1,000 Neurons** overage. Model cost metadata is expressed in Neurons per million tokens; these checked-in values can become stale.

Rosetta tags each model with a `cost_tier` (surfaced in `/v1/models` and `/health`, and shown as a badge in the home-page configurator):

| Tier | Neurons / M input | Examples |
|---|---|---|
| **cheap** (<10k) | burns the allowance slowly | IBM Granite 4.0 (1.5k), Llama 3.2 1B (2.5k), GLM 4.7 Flash (5.5k), Gemma 4 (9k) |
| **standard** (10k–60k) | moderate | Llama 3.3 70B (27k), GPT-OSS 120B (32k), Llama 4 Scout (25k) |
| **expensive** (>60k) | exhausts the allowance fastest | GLM 5.2 (127k), Kimi K2.6/K2.7 (86k), Qwen2.5 Coder (60k) |

Pick a **cheap** model for experimentation and high-volume free-tier usage; pick **expensive** models (Kimi, GLM) only when you need their tool/vision/reasoning capability and are on the Paid plan. The default `kimi-k2.7-code` is `expensive` — best for tool-heavy clients like Claude Code, but switch to a cheaper model if you're just trying things out on the free tier.

## Local quota tracking and Cloudflare login

Cloudflare exposes **no documented API** for remaining Workers AI Neurons. Rosetta therefore tracks usage locally for requests routed through Rosetta:

- `GET /usage` returns today's estimated Neurons used, estimated remaining free allowance, request count, and per-model breakdown.
- The home page shows this `/usage` data.
- The estimate only includes Rosetta-routed requests; usage from the Cloudflare dashboard, other Workers, or AI Gateway is not included.
- KV writes are approximate under concurrent traffic. Good enough for a dashboard; not enough for accounting. Accountants ruin everything.

Setup requires a KV namespace:

```toml
[[kv_namespaces]]
binding = "USAGE_KV"
id = "<your-kv-namespace-id>"
```

The "Log in with Cloudflare" button uses Cloudflare self-managed OAuth when configured. It is **not** `wrangler login` — Wrangler's login callback is localhost-only (`localhost:8976`), which cannot work from a deployed Worker.

Required secrets for OAuth:

```sh
npx wrangler secret put CF_OAUTH_CLIENT_ID
npx wrangler secret put CF_OAUTH_CLIENT_SECRET
# optional, defaults to: openid email profile
npx wrangler secret put CF_OAUTH_SCOPES
```

Set the OAuth client redirect URI to:

```text
https://your-worker-domain/oauth/callback
```

OAuth currently confirms account login for the UI. The quota number remains Rosetta's local estimate because Cloudflare does not publish a remaining-Neurons API.

## Compatibility notes

- Anthropic `system` and `messages` are converted to Workers AI chat messages.
- Anthropic tools are converted to the model family's tool shape; `tool_use`/`tool_result` round-trip as OpenAI `tool_calls` / `tool` messages.
- Streaming responses are converted to Anthropic SSE events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.
- `count_tokens` returns a conservative local estimate so clients do not hard fail.
- Cloudflare quota, model, and rate-limit errors are returned as Anthropic-style error JSON. There is no paid fallback.

## Questions before adopting

**Can a health check prove that Claude Code works with a model?** No. `/health`
returns configured metadata. Exercise a real completion and the client's tool-use
workflow separately; model-family conversion is not complete API equivalence.

**Is `/usage` my account's remaining Cloudflare quota?** No. It estimates requests
that pass through this gateway and cannot account for other Workers or dashboard
requests. See [local quota tracking](#local-quota-tracking-and-cloudflare-login).

**Can this release forward image input?** No. The current compatibility section
explains the dropped image blocks and other differences from Anthropic behavior.

## License

MIT.
