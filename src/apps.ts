/**
 * Rosetta client import descriptors.
 *
 * Not every client shares one import mechanism, so each app declares how it ingests
 * a provider definition:
 *  - ccswitch: a `ccswitch://v1/import` deep link handled by the CC Switch desktop
 *    tool (covers claude, opencode, openclaw).
 *  - snippet:  Rosetta renders a copy-paste config snippet the user pastes by hand
 *    (hermes config.yaml; trae is UI-instructions-only).
 *
 * API format / endpoint path per client:
 *  - Claude Code, OpenClaw, Hermes, TRAE speak the Anthropic Messages API against
 *    the bare worker URL (their SDK appends /v1/messages).
 *  - opencode's custom-provider path is OpenAI Chat Completions, wanting baseURL
 *    ending in /v1 (gateway /v1/chat/completions).
 */

export type AppKind = "claude" | "opencode" | "openclaw" | "hermes" | "trae";
export type ImportKind = "ccswitch" | "snippet";
export type ApiFormat = "anthropic" | "openai";

export interface AppDescriptor {
  id: AppKind;
  label: string;
  format: ApiFormat;
  importKind: ImportKind;
  /** Appended to the worker base URL when building the endpoint (e.g. "/v1" for opencode). */
  endpointSuffix: string;
}

export const APPS: AppDescriptor[] = [
  { id: "claude", label: "Claude Code", format: "anthropic", importKind: "ccswitch", endpointSuffix: "" },
  { id: "opencode", label: "opencode", format: "openai", importKind: "ccswitch", endpointSuffix: "/v1" },
  { id: "openclaw", label: "OpenClaw", format: "anthropic", importKind: "ccswitch", endpointSuffix: "" },
  { id: "hermes", label: "Hermes Agent", format: "anthropic", importKind: "snippet", endpointSuffix: "" },
  { id: "trae", label: "TRAE", format: "anthropic", importKind: "snippet", endpointSuffix: "" }
];

export function getApp(id: string | null): AppDescriptor | undefined {
  return APPS.find((app) => app.id === id);
}

/** Build a ccswitch:// provider-import deep link. For Claude Code, model defaults are attached. */
export function ccswitchUrl(app: AppDescriptor, endpoint: string, apiKey: string, modelAlias?: string): string {
  const deepLink = new URL("ccswitch://v1/import");
  deepLink.searchParams.set("resource", "provider");
  deepLink.searchParams.set("app", app.id);
  deepLink.searchParams.set("name", "Rosetta");
  deepLink.searchParams.set("endpoint", `${endpoint}${app.endpointSuffix}`);
  deepLink.searchParams.set("apiKey", apiKey);
  // CC Switch passes these as Claude Code's haiku/sonnet/opus model defaults.
  if (app.id === "claude" && modelAlias) {
    deepLink.searchParams.set("haikuModel", modelAlias);
    deepLink.searchParams.set("sonnetModel", modelAlias);
    deepLink.searchParams.set("opusModel", modelAlias);
  }
  return deepLink.toString();
}

/**
 * Claude Code env block. BASE_URL first, then model defaults so Claude Code routes
 * every tier (haiku/sonnet/opus) to the chosen Rosetta model. Paste into
 * ~/.claude/settings.json `env` or your shell.
 */
export function claudeSnippet(endpoint: string, apiKey: string, modelAlias: string): string {
  return [
    "{",
    `  "env": {`,
    `    "ANTHROPIC_BASE_URL": "${endpoint}",`,
    `    "ANTHROPIC_AUTH_TOKEN": "${apiKey}",`,
    `    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${modelAlias}",`,
    `    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "${modelAlias}",`,
    `    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${modelAlias}",`,
    `    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "${modelAlias}",`,
    `    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${modelAlias}",`,
    `    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "${modelAlias}"`,
    `  }`,
    `}`
  ].join("\n");
}

/**
 * Hermes Agent (Nous Research) custom provider — config.yaml snippet.
 * api_mode: anthropic_messages; bare base_url; key read from the named env var.
 */
export function hermesSnippet(endpoint: string, apiKeyEnv: string, modelAlias: string): string {
  return [
    "# ~/.hermes/config.yaml — Rosetta custom provider",
    "custom_providers:",
    "  - name: rosetta",
    `    base_url: ${endpoint}`,
    `    key_env: ${apiKeyEnv}`,
    "    api_mode: anthropic_messages",
    "",
    "model:",
    "  provider: rosetta",
    `  default: ${modelAlias}`,
    "",
    `# export ${apiKeyEnv}=<your-api-key>`
  ].join("\n");
}

/**
 * TRAE has no import link or config file — the user adds the model in the TRAE
 * Settings UI. Return step-by-step instructions + the field values to enter.
 */
export function traeSnippet(endpoint: string, apiKey: string, modelAlias: string): string {
  return [
    "TRAE — add a custom model (Settings → Models → Add Model → Custom):",
    "",
    `  1. API Format          = Anthropic`,
    `  2. Custom Request URL  = ${endpoint}   (toggle 完整URL/Full URL OFF; TRAE appends /v1/messages)`,
    `  3. Model ID            = ${modelAlias}`,
    `  4. API Key             = ${apiKey}`
  ].join("\n");
}

/** Render the config snippet for a snippet-kind app (hermes/trae/claude). */
export function appSnippet(app: AppDescriptor, endpoint: string, apiKey: string, apiKeyEnv: string, modelAlias: string): string {
  switch (app.id) {
    case "claude":
      return claudeSnippet(endpoint, apiKey, modelAlias);
    case "hermes":
      return hermesSnippet(endpoint, apiKeyEnv, modelAlias);
    case "trae":
      return traeSnippet(endpoint, apiKey, modelAlias);
    default:
      return "";
  }
}
