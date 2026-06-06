// Token-usage normalization + cost estimation, shared by the server generators
// (api/_generation/generate.ts, api/_generation/scene.ts) and surfaced to the
// client so the user can see roughly how many tokens a generation spent and what
// it cost.
//
// IMPORTANT: the rates below are ESTIMATES (USD per 1,000,000 tokens). They are
// NOT pulled from a live billing API — update them here to match your account's
// actual pricing. An unknown model yields a null cost (tokens are still shown).

export interface ModelRate {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cached (prompt-cache read) input tokens. Defaults to `input`. */
  cachedInput?: number;
}

// Keyed by model id. Matching is tolerant (lowercased, longest-prefix), so
// "claude-opus-4-8[1m]" or "gpt-5.5-2025-xx" still resolve to the base rate.
export const MODEL_PRICING: Record<string, ModelRate> = {
  // Opus 4.5–4.8 are $5/$25 per 1M (cache read ~0.1x = $0.50). Longest-prefix
  // match means these win over the generic "claude-opus-4" base below.
  "claude-opus-4-8": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cachedInput: 0.5 },
  // Opus 4.0 / 4.1 were the older $15/$75 tier; keep them on the base entry.
  "claude-opus-4": { input: 15, output: 75, cachedInput: 1.5 },
  "claude-sonnet-4": { input: 3, output: 15, cachedInput: 0.3 },
  "claude-haiku-4": { input: 1, output: 5, cachedInput: 0.1 },
  "gpt-5.5": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gpt-5.1": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gpt-5": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1 },
  "gpt-4.1": { input: 2, output: 8, cachedInput: 0.5 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
};

// Aggregated, client-facing usage for one generation (summed across passes).
export interface GenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cached (prompt-cache read) input tokens, a subset of inputTokens. */
  cachedTokens: number;
  totalTokens: number;
  /** Estimated USD cost, or null when the model's rate is unknown. */
  costUsd: number | null;
  /** "anthropic" | "openai" | "mock" — whichever served the bulk of the work. */
  provider: string;
  model: string;
}

export interface NormalizedTokens {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Flatten a provider's raw `usage` object into a common token shape. The two
// providers report caching differently:
//   - OpenAI: input_tokens INCLUDES cached; cached = input_tokens_details.cached_tokens.
//   - Anthropic: input_tokens is the UNCACHED portion; cache_read/creation are separate.
// We normalize both so inputTokens is the full input and cachedTokens ⊆ inputTokens.
export function normalizeUsage(raw: unknown, provider: string): NormalizedTokens {
  const u = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (provider === "anthropic") {
    const cached = num(u.cache_read_input_tokens);
    const created = num(u.cache_creation_input_tokens);
    return {
      inputTokens: num(u.input_tokens) + cached + created,
      outputTokens: num(u.output_tokens),
      cachedTokens: cached,
    };
  }
  // openai (Responses API) + any other provider that mirrors its shape
  const details = (u.input_tokens_details && typeof u.input_tokens_details === "object"
    ? u.input_tokens_details
    : {}) as Record<string, unknown>;
  return {
    inputTokens: num(u.input_tokens) + num(u.prompt_tokens),
    outputTokens: num(u.output_tokens) + num(u.completion_tokens),
    cachedTokens: num(details.cached_tokens),
  };
}

function lookupRate(model: string): ModelRate | null {
  const m = (model || "").toLowerCase();
  if (MODEL_PRICING[m]) return MODEL_PRICING[m];
  // Longest matching known prefix wins (so "claude-opus-4-8" beats "claude-opus-4").
  let best: { key: string; rate: ModelRate } | null = null;
  for (const [key, rate] of Object.entries(MODEL_PRICING)) {
    if (m.startsWith(key) && (!best || key.length > best.key.length)) best = { key, rate };
  }
  return best?.rate ?? null;
}

// Estimate USD cost for one normalized token bundle on a given model.
export function estimateCost(t: NormalizedTokens, model: string): number | null {
  const rate = lookupRate(model);
  if (!rate) return null;
  const uncachedInput = Math.max(0, t.inputTokens - t.cachedTokens);
  const cachedRate = rate.cachedInput ?? rate.input;
  return (
    (uncachedInput / 1e6) * rate.input +
    (t.cachedTokens / 1e6) * cachedRate +
    (t.outputTokens / 1e6) * rate.output
  );
}

// A small accumulator the generators feed each pass's usage into, then summarize.
export interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  /** true once any pass had a known rate (so costUsd is meaningful). */
  costKnown: boolean;
}

export function newUsageAcc(): UsageAccumulator {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, costKnown: false };
}

// Add one pass's raw usage (from the provider that actually served it).
export function recordUsage(acc: UsageAccumulator, raw: unknown, provider: string, model: string): void {
  const t = normalizeUsage(raw, provider);
  acc.inputTokens += t.inputTokens;
  acc.outputTokens += t.outputTokens;
  acc.cachedTokens += t.cachedTokens;
  const cost = estimateCost(t, model);
  if (cost != null) {
    acc.costUsd += cost;
    acc.costKnown = true;
  }
}

export function summarizeUsage(acc: UsageAccumulator, provider: string, model: string): GenUsage {
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cachedTokens: acc.cachedTokens,
    totalTokens: acc.inputTokens + acc.outputTokens,
    costUsd: acc.costKnown ? Math.round(acc.costUsd * 1e6) / 1e6 : null,
    provider,
    model,
  };
}

// Format a usage summary for compact display, e.g. "24.1k tokens · ~$0.183".
export function formatUsage(u: GenUsage | null | undefined): string {
  if (!u) return "";
  const tok = u.totalTokens >= 1000 ? `${(u.totalTokens / 1000).toFixed(1)}k` : String(u.totalTokens);
  const cost = u.costUsd == null ? "" : u.costUsd < 0.01 ? ` · ~$${u.costUsd.toFixed(4)}` : ` · ~$${u.costUsd.toFixed(2)}`;
  return `${tok} tokens${cost}`;
}
