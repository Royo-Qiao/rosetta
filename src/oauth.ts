import type { Env } from "./types";

const AUTH_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const SESSION_COOKIE = "rosetta_cf_login";
const STATE_COOKIE = "rosetta_oauth_state";

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function oauthConfigured(env: Env): boolean {
  return Boolean(env.CF_OAUTH_CLIENT_ID?.trim() && env.CF_OAUTH_CLIENT_SECRET?.trim());
}

function redirectUri(request: Request, env: Env): string {
  const configured = env.CF_OAUTH_REDIRECT_URI?.trim();
  if (configured) return configured;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/oauth/callback`;
}

export function isCloudflareLoggedIn(request: Request): boolean {
  return (request.headers.get("cookie") ?? "").includes(`${SESSION_COOKIE}=1`);
}

export function oauthStatus(request: Request, env: Env): Record<string, unknown> {
  return {
    configured: oauthConfigured(env),
    logged_in: isCloudflareLoggedIn(request),
    note: "Cloudflare OAuth is only used to confirm account login. Remaining neurons are estimated locally from Rosetta-routed requests because Cloudflare exposes no documented remaining-neurons API."
  };
}

export function oauthLogin(request: Request, env: Env): Response {
  if (!oauthConfigured(env)) {
    return oauthSetupPage(request, env);
  }

  const state = randomToken();
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.CF_OAUTH_CLIENT_ID!.trim());
  url.searchParams.set("redirect_uri", redirectUri(request, env));
  url.searchParams.set("scope", env.CF_OAUTH_SCOPES?.trim() || "openid email profile");
  url.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "set-cookie": `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    }
  });
}

export async function oauthCallback(request: Request, env: Env): Promise<Response> {
  if (!oauthConfigured(env)) {
    return oauthSetupPage(request, env);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = request.headers.get("cookie") ?? "";
  const expectedState = cookies.match(new RegExp(`${STATE_COOKIE}=([^;]+)`))?.[1];

  if (!code || !state || !expectedState || state !== expectedState) {
    return new Response("Invalid Cloudflare OAuth callback state.", { status: 400 });
  }

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", env.CF_OAUTH_CLIENT_ID!.trim());
  body.set("client_secret", env.CF_OAUTH_CLIENT_SECRET!.trim());
  body.set("redirect_uri", redirectUri(request, env));
  body.set("code", code);

  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text();
    return new Response(`Cloudflare OAuth token exchange failed: ${detail}`, { status: 502 });
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: "/",
      "set-cookie": `${SESSION_COOKIE}=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
    }
  });
}

function oauthSetupPage(request: Request, env: Env): Response {
  const callback = redirectUri(request, env);
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rosetta — Cloudflare OAuth setup</title>
<style>body{font-family:ui-sans-serif,system-ui;margin:40px;max-width:920px;line-height:1.5;color:#111827}pre{background:#f3f4f6;padding:16px;border-radius:8px;overflow:auto}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}a{color:#075985}</style></head>
<body>
<h1>Cloudflare OAuth is not configured</h1>
<p>Create a self-managed Cloudflare OAuth client, set this redirect URI, then add the client id/secret as Worker secrets.</p>
<pre>Redirect URI: ${callback}

npx wrangler secret put CF_OAUTH_CLIENT_ID
npx wrangler secret put CF_OAUTH_CLIENT_SECRET
# optional; defaults to openid email profile
npx wrangler secret put CF_OAUTH_SCOPES</pre>
<p>Cloudflare docs: <a href="https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/">Create an OAuth client</a>.</p>
<p><a href="/">← back</a></p>
</body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
