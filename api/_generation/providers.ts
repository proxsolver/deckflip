// Provider abstraction for deck generation — Anthropic Opus primary, OpenAI
// fallback. Holds the low-level model-call machinery (request shaping, web-search
// tool wiring, retry/backoff, fallback chaining, response parsing) so the
// orchestration in ./generate stays readable. Reused by ./scene for 3D scene
// regeneration. The big static system prompt is the cached prefix shared by every
// pass (token lever even though quality is the goal).

import { SYSTEM_PROMPT } from "./prompt";

// --- env + small infra ------------------------------------------------------

export function env(name: string): string | undefined {
  return (typeof process !== "undefined" && process.env ? process.env[name] : undefined)?.trim() || undefined;
}

function timeoutMs(): number {
  // Generous: the web-search plan pass on a reasoning model can run well past the
  // old 300s and was aborting into the single-call fallback.
  return Number(env("HTML_PPT_GEN_TIMEOUT") || "600") * 1000;
}

// Live web research toggle (default on). Applied to the plan/research pass only.
export function webSearchEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test(env("HTML_PPT_WEB_SEARCH") || "1");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Run an async fn over items with bounded concurrency, preserving order.
export async function pMap<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

// --- types ------------------------------------------------------------------

type Provider = "anthropic" | "openai";

interface AnthropicContentBlock {
  type: string;
  [k: string]: unknown;
}

interface ProviderConfig {
  provider: Provider;
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

export interface Providers {
  primary?: ProviderConfig;
  fallback?: ProviderConfig;
}

export interface ModelCall {
  maxTokens: number;
  images: string[]; // data URLs (plan, foundation, single-call; empty for slides/QA)
  userText: string;
  schema: unknown;
  toolName: string;
  toolDescription: string;
  /** Enable the provider's live web-search tool for this call (research passes). */
  webSearch?: boolean;
  /** Override the cached system prompt (single-pass uses the sample-recipe one). */
  system?: string;
}

export type ModelResult = { input: unknown; usage: unknown; stopReason: string; webSearchCount: number };

// Free-text (no forced tool) call — used by single-pass delimited generation so a
// truncated response is salvageable (partial files) rather than unparseable JSON.
export interface RawCall {
  maxTokens: number;
  images: string[]; // data URLs (reference/style cues)
  system: string;
  userText: string;
  /** Partial assistant output to resume from — Anthropic continues this turn. */
  assistantPrefix?: string;
  webSearch?: boolean;
}

export type RawResult = { text: string; usage: unknown; stopReason: string; webSearchCount: number };

// --- provider resolution ----------------------------------------------------

function buildConfig(provider: Provider): ProviderConfig | null {
  if (provider === "anthropic") {
    const apiKey = env("ANTHROPIC_API_KEY");
    if (!apiKey) return null;
    // Pin Opus by default (quality lever); HTML_PPT_ANTHROPIC_MODEL overrides.
    const model = env("HTML_PPT_ANTHROPIC_MODEL") || "claude-opus-4-8";
    const baseUrl = (env("ANTHROPIC_BASE_URL") || "https://api.anthropic.com").replace(/\/+$/, "");
    return { provider, apiKey, model, baseUrl, timeoutMs: timeoutMs() };
  }
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) return null;
  const model = env("HTML_PPT_GEN_OPENAI_MODEL") || env("OPENAI_MODEL") || "gpt-5.5";
  const baseUrl = (env("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
  return { provider, apiKey, model, baseUrl, timeoutMs: timeoutMs() };
}

// Prefer Anthropic (Opus); fall back to OpenAI. HTML_PPT_GEN_PROVIDER flips the
// preference order. Whichever keys are present become primary/fallback.
export function resolveProviders(log: Record<string, unknown>): Providers {
  const explicit = (env("HTML_PPT_GEN_PROVIDER") || "").toLowerCase();
  const anthropic = buildConfig("anthropic");
  const openai = buildConfig("openai");
  const order = explicit === "openai" ? [openai, anthropic] : [anthropic, openai];
  const filtered = order.filter((c): c is ProviderConfig => !!c);
  const res: Providers = { primary: filtered[0], fallback: filtered[1] };
  log.provider = res.primary?.provider;
  log.model = res.primary?.model;
  if (res.fallback) {
    log.fallbackProvider = res.fallback.provider;
    log.fallbackModel = res.fallback.model;
  }
  return res;
}

// Try the primary provider; on ANY error retry the identical call on the fallback
// (e.g. empty Anthropic balance → OpenAI). Generic over the per-provider call so the
// structured (callWithFallback) and free-text (callRawWithFallback) paths share the
// exact same retry/fallback/logging. Logs which provider served each pass.
async function fallbackOver<R>(
  providers: Providers,
  log: Record<string, unknown>,
  label: string,
  run: (cfg: ProviderConfig) => Promise<R>
): Promise<R> {
  const chain = [providers.primary, providers.fallback].filter((c): c is ProviderConfig => !!c);
  if (!chain.length) throw new Error("No AI provider configured.");
  let lastErr: unknown;
  for (let i = 0; i < chain.length; i++) {
    const cfg = chain[i];
    try {
      const result = await retryOver(cfg, log, label, run);
      log[`${label}Provider`] = cfg.provider;
      log[`${label}Model`] = cfg.model;
      if (i > 0) log[`${label}Fallback`] = true;
      return result;
    } catch (err) {
      lastErr = err;
      log[`${label}Error_${cfg.provider}`] = String((err as Error)?.message ?? err);
      console.error(`[generate] ${label} on ${cfg.provider} failed:`, log[`${label}Error_${cfg.provider}`]);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Retry a single provider on transient errors (429 rate-limit / 5xx / overloaded),
// honoring the "try again in Xs" hint when present. A 400 (e.g. empty balance) is
// NOT transient — it throws immediately so fallbackOver moves to the next provider.
// Default 5 attempts; tune with HTML_PPT_MAX_RETRIES.
async function retryOver<R>(
  cfg: ProviderConfig,
  log: Record<string, unknown>,
  label: string,
  run: (cfg: ProviderConfig) => Promise<R>
): Promise<R> {
  const maxRetries = Math.max(0, Number(env("HTML_PPT_MAX_RETRIES") || "5"));
  let backoff = 2000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(cfg);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      // Includes flaky network drops (undici "fetch failed"/"terminated", ECONNRESET)
      // common on long web-search calls, so we retry before degrading.
      const transient = /\b(429|500|502|503|529)\b|rate.?limit|overloaded|timeout|temporar|fetch failed|terminated|econnreset|socket|network/i.test(msg);
      if (!transient || attempt >= maxRetries) throw err;
      const wait = (parseRetryAfterMs(msg) ?? backoff) + 400; // small buffer past the hint
      log[`${label}Retry_${cfg.provider}_${attempt}`] = `transient, wait ${wait}ms`;
      await sleep(wait);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

// Structured (forced-tool) call with fallback — unchanged public signature.
export function callWithFallback(
  providers: Providers,
  call: ModelCall,
  log: Record<string, unknown>,
  label: string
): Promise<ModelResult> {
  return fallbackOver(providers, log, label, (cfg) => callModel(cfg, call));
}

// Free-text call with fallback (single-pass delimited generation). Returns raw text
// + stopReason so the caller can detect truncation and continue the assistant turn.
export function callRawWithFallback(
  providers: Providers,
  call: RawCall,
  log: Record<string, unknown>,
  label: string
): Promise<RawResult> {
  return fallbackOver(providers, log, label, (cfg) => callRawModel(cfg, call));
}

// Extract "try again in 1.402s" / "in 850ms" from a provider error → ms.
function parseRetryAfterMs(msg: string): number | null {
  const s = /try again in\s+([\d.]+)\s*s/i.exec(msg);
  if (s) return Math.ceil(parseFloat(s[1]) * 1000);
  const ms = /try again in\s+(\d+)\s*ms/i.exec(msg);
  if (ms) return parseInt(ms[1], 10);
  return null;
}

// --- per-provider calls -----------------------------------------------------

function callModel(cfg: ProviderConfig, call: ModelCall): Promise<ModelResult> {
  return cfg.provider === "openai" ? callOpenAi(cfg, call) : callAnthropic(cfg, call);
}

function callRawModel(cfg: ProviderConfig, call: RawCall): Promise<RawResult> {
  return cfg.provider === "openai" ? callOpenAiRaw(cfg, call) : callAnthropicRaw(cfg, call);
}

// Anthropic request headers, optionally carrying a beta flag. Set HTML_PPT_ANTHROPIC_BETA
// to the extended-output beta (e.g. "output-128k-2025-02-19") to let single-pass request
// a 64K+ output budget where the account/model supports it. Off by default so an
// unsupported value can never 400 an otherwise-working call.
function anthropicHeaders(cfg: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "x-api-key": cfg.apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  const beta = env("HTML_PPT_ANTHROPIC_BETA");
  if (beta) headers["anthropic-beta"] = beta;
  return headers;
}

async function callAnthropic(cfg: ProviderConfig, call: ModelCall): Promise<ModelResult> {
  const blocks: AnthropicContentBlock[] = [];
  for (const dataUrl of call.images) {
    const parsed = parseDataUrl(dataUrl);
    if (parsed) blocks.push({ type: "image", source: { type: "base64", media_type: parsed.mime, data: parsed.base64 } });
  }
  blocks.push({ type: "text", text: call.userText });

  // Tools: the structured-output tool always; the web-search server tool when this
  // pass does research. Web search needs tool_choice:auto (forcing the output tool
  // would skip the search), so the model searches first, then calls the output tool.
  const tools: Record<string, unknown>[] = [{ name: call.toolName, description: call.toolDescription, input_schema: call.schema }];
  if (call.webSearch) tools.push({ type: "web_search_20250305", name: "web_search", max_uses: Number(env("HTML_PPT_WEB_SEARCH_MAX") || "6") });

  const payload = {
    model: cfg.model,
    max_tokens: call.maxTokens,
    // The big static prompt is the cached prefix — keep it byte-stable and first.
    system: [{ type: "text", text: call.system ?? SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: blocks }],
    tools,
    tool_choice: call.webSearch ? { type: "auto" } : { type: "tool", name: call.toolName },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(cfg),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Anthropic API connection failed: ${String((err as Error)?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Anthropic API error ${resp.status}: ${detail.slice(0, 1200)}`);
  }

  const json = (await resp.json()) as { content?: AnthropicContentBlock[]; usage?: unknown; stop_reason?: string };
  const content = json.content ?? [];
  const block = content.find((b) => b.type === "tool_use" && b.name === call.toolName);
  if (!block) {
    throw new Error(`Anthropic returned no ${call.toolName} tool call (stop_reason: ${json.stop_reason ?? "?"}).`);
  }
  const webSearchCount = content.filter((b) => b.type === "server_tool_use" && (b as { name?: string }).name === "web_search").length;
  // The tool_use block's `input` is ALREADY a parsed object — no JSON.parse.
  return { input: (block as { input?: unknown }).input, usage: json.usage, stopReason: json.stop_reason ?? "", webSearchCount };
}

async function callOpenAi(cfg: ProviderConfig, call: ModelCall): Promise<ModelResult> {
  // OpenAI models cap output well below Anthropic (~16-32K); clamp so we never
  // request an invalid max_output_tokens. The big system prompt auto-caches.
  const maxOut = Math.min(call.maxTokens, 32000);
  const userParts: unknown[] = call.images.map((url) => ({ type: "input_image", image_url: url }));
  userParts.push({ type: "input_text", text: call.userText });

  const payload: Record<string, unknown> = {
    model: cfg.model,
    max_output_tokens: maxOut,
    input: [
      { role: "system", content: call.system ?? SYSTEM_PROMPT },
      { role: "user", content: userParts },
    ],
    // strict:false — schemas use optional fields that predate OpenAI strict mode.
    text: { format: { type: "json_schema", name: call.toolName, schema: call.schema, strict: false } },
  };
  // Built-in web-search tool for research passes; the model searches then emits
  // the structured output. Default tool_choice (auto) lets it decide.
  if (call.webSearch) payload.tools = [{ type: env("HTML_PPT_OPENAI_WEBSEARCH_TOOL") || "web_search" }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${cfg.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`OpenAI API connection failed: ${String((err as Error)?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`OpenAI API error ${resp.status}: ${detail.slice(0, 1200)}`);
  }

  const response = (await resp.json()) as Record<string, unknown>;
  const text = extractOpenAiText(response);
  if (!text) throw new Error("OpenAI response contained no output text (possibly truncated or refused).");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error(`OpenAI output was not valid JSON: ${text.slice(0, 1000)}`);
  }
  const incomplete =
    response.status === "incomplete"
      ? String((response.incomplete_details as Record<string, unknown>)?.reason ?? "incomplete")
      : String(response.status ?? "");
  const output = Array.isArray(response.output) ? response.output : [];
  const webSearchCount = output.filter(
    (it) => it && typeof it === "object" && /web_search/.test(String((it as Record<string, unknown>).type ?? ""))
  ).length;
  return { input, usage: response.usage, stopReason: incomplete, webSearchCount };
}

// --- free-text (delimited single-pass) calls --------------------------------

// Anthropic free-text call, streamed by default so a long (64K-token) deck doesn't
// hit a request timeout and so partial output is captured if the stream drops. No
// forced output tool → the response is raw text we parse with the delimited parser.
// `assistantPrefix` resumes a truncated turn (continuation): the partial is sent back
// as the assistant message and the model keeps writing from exactly where it stopped.
async function callAnthropicRaw(cfg: ProviderConfig, call: RawCall): Promise<RawResult> {
  const userBlocks: AnthropicContentBlock[] = [];
  for (const dataUrl of call.images) {
    const parsed = parseDataUrl(dataUrl);
    if (parsed) userBlocks.push({ type: "image", source: { type: "base64", media_type: parsed.mime, data: parsed.base64 } });
  }
  userBlocks.push({ type: "text", text: call.userText });

  const messages: Record<string, unknown>[] = [{ role: "user", content: userBlocks }];
  if (call.assistantPrefix && call.assistantPrefix.trim()) {
    // Anthropic rejects an assistant prefill that ends in whitespace; trim the tail.
    messages.push({ role: "assistant", content: [{ type: "text", text: call.assistantPrefix.replace(/\s+$/, "") }] });
  }

  const tools: Record<string, unknown>[] = [];
  if (call.webSearch) tools.push({ type: "web_search_20250305", name: "web_search", max_uses: Number(env("HTML_PPT_WEB_SEARCH_MAX") || "6") });

  const stream = !/^(0|false|off|no)$/i.test(env("HTML_PPT_GEN_STREAM") || "1");
  const payload: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: call.maxTokens,
    // Same cached prefix as every pass — keep it first and byte-stable.
    system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
    messages,
    stream,
  };
  if (tools.length) payload.tools = tools;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(cfg),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Anthropic API connection failed: ${String((err as Error)?.message ?? err)}`);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    clearTimeout(timer);
    throw new Error(`Anthropic API error ${resp.status}: ${detail.slice(0, 1200)}`);
  }

  try {
    if (!stream) {
      const json = (await resp.json()) as { content?: AnthropicContentBlock[]; usage?: unknown; stop_reason?: string };
      const content = json.content ?? [];
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => String((b as { text?: string }).text ?? ""))
        .join("");
      const webSearchCount = content.filter((b) => b.type === "server_tool_use" && (b as { name?: string }).name === "web_search").length;
      return { text, usage: json.usage, stopReason: json.stop_reason ?? "", webSearchCount };
    }
    return await readAnthropicStream(resp);
  } finally {
    clearTimeout(timer);
  }
}

// Parse the Anthropic SSE stream into accumulated text + stop_reason + usage.
async function readAnthropicStream(resp: Response): Promise<RawResult> {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("Anthropic stream had no readable body.");
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let stopReason = "";
  let webSearchCount = 0;
  let usage: Record<string, unknown> = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = String(evt.type ?? "");
      if (type === "content_block_delta") {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta && (delta.type === "text_delta" || typeof delta.text === "string")) text += String(delta.text ?? "");
      } else if (type === "content_block_start") {
        const cb = evt.content_block as Record<string, unknown> | undefined;
        if (cb && cb.type === "server_tool_use" && (cb as { name?: string }).name === "web_search") webSearchCount++;
      } else if (type === "message_start") {
        const m = evt.message as Record<string, unknown> | undefined;
        if (m && m.usage) usage = { ...(m.usage as Record<string, unknown>) };
      } else if (type === "message_delta") {
        const d = evt.delta as Record<string, unknown> | undefined;
        if (d && typeof d.stop_reason === "string") stopReason = d.stop_reason;
        if (evt.usage) usage = { ...usage, ...(evt.usage as Record<string, unknown>) };
      } else if (type === "error") {
        const e = evt.error as Record<string, unknown> | undefined;
        throw new Error(`Anthropic stream error: ${String(e?.message ?? "unknown")}`);
      }
    }
  }
  return { text, usage, stopReason, webSearchCount };
}

// OpenAI free-text fallback (non-streamed; OpenAI caps output ~32K and is only the
// fallback). Continuation is best-effort via a prior assistant turn.
async function callOpenAiRaw(cfg: ProviderConfig, call: RawCall): Promise<RawResult> {
  const maxOut = Math.min(call.maxTokens, 32000);
  const userParts: unknown[] = call.images.map((url) => ({ type: "input_image", image_url: url }));
  userParts.push({ type: "input_text", text: call.userText });
  const input: Record<string, unknown>[] = [
    { role: "system", content: call.system },
    { role: "user", content: userParts },
  ];
  if (call.assistantPrefix && call.assistantPrefix.trim()) input.push({ role: "assistant", content: call.assistantPrefix });

  const payload: Record<string, unknown> = { model: cfg.model, max_output_tokens: maxOut, input };
  if (call.webSearch) payload.tools = [{ type: env("HTML_PPT_OPENAI_WEBSEARCH_TOOL") || "web_search" }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${cfg.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`OpenAI API connection failed: ${String((err as Error)?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`OpenAI API error ${resp.status}: ${detail.slice(0, 1200)}`);
  }
  const response = (await resp.json()) as Record<string, unknown>;
  const text = extractOpenAiText(response);
  if (!text) throw new Error("OpenAI raw response contained no output text (possibly truncated or refused).");
  const incomplete =
    response.status === "incomplete"
      ? String((response.incomplete_details as Record<string, unknown>)?.reason ?? "incomplete")
      : String(response.status ?? "");
  const output = Array.isArray(response.output) ? response.output : [];
  const webSearchCount = output.filter(
    (it) => it && typeof it === "object" && /web_search/.test(String((it as Record<string, unknown>).type ?? ""))
  ).length;
  return { text, usage: response.usage, stopReason: incomplete, webSearchCount };
}

// Tolerant to the Responses API output shapes (mirrors the editing handler).
function extractOpenAiText(response: Record<string, unknown>): string {
  if (typeof response.output_text === "string") return response.output_text;
  const chunks: string[] = [];
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (Array.isArray(obj.content)) {
      for (const part of obj.content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        const t = p.text ?? p.output_text;
        if (typeof t === "string") chunks.push(t);
      }
    }
    if (typeof obj.text === "string") chunks.push(obj.text);
  }
  return chunks.join("").trim();
}

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || "image/png";
  if (!/^image\//i.test(mime)) return null;
  const base64 = m[2] ? m[3] : btoa(decodeURIComponent(m[3]));
  return { mime, base64 };
}
