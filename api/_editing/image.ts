// Server-side AI IMAGE logic for the editor: (1) GENERATE a fancier image for the
// selected object with gpt-image-1, and (2) web image SEARCH — find REAL photos
// for one or many selected objects and inline them. Both deliver patches
// ({ src | backgroundImage: data-URL }) so they reuse the whole apply/undo/export
// pipeline, and both fall back to a deterministic placeholder with no key.

import { validatePatch, type PatchOp } from "../../shared/editing";
import { env, extractResponseText, type ContextLike } from "./common";

export interface AiEditResponse {
  patches: PatchOp[];
  message: string;
  /** true when these patches came from the offline demo/mock engine (no real AI). */
  mock: boolean;
}

// ---------------------------------------------------------------------------
// Image generation — "generate a fancier image" replaces the selected object.
// Delivered as a patch ({ src | backgroundImage: data-URL }) so it reuses the
// whole apply/undo/export pipeline. Always returns a self-contained data URL.
// ---------------------------------------------------------------------------

export interface AiImageRequest {
  prompt: string;
  context?: ContextLike & { tag?: string };
  /** Optional data URL of the current selection, used as an img2img reference. */
  image?: string;
}

export async function handleAiImage(req: AiImageRequest): Promise<AiEditResponse> {
  const prompt = (req?.prompt ?? "").trim();
  if (!prompt) throw new Error("Prompt is empty.");
  const ctx = req?.context;
  if (!ctx || typeof ctx.id !== "string" || !ctx.id) {
    throw new Error("No selected object context was provided.");
  }
  // <img> gets its src swapped; any other box gets a background-image.
  const key = String(ctx.tag || "").toLowerCase() === "img" ? "src" : "backgroundImage";

  const apiKey = env("OPENAI_API_KEY");
  const forceMock = /^(1|true|yes|on)$/i.test(env("HTML_PPT_AI_MOCK") || "");

  let dataUrl: string;
  let mock: boolean;
  let message: string;
  if (!apiKey || forceMock) {
    dataUrl = placeholderImage(prompt);
    mock = true;
    message = "Demo mode — inserted a placeholder image (no real AI; set OPENAI_API_KEY to generate with gpt-image-1).";
  } else {
    const baseUrl = (env("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
    const timeoutMs = Number(env("HTML_PPT_IMAGE_TIMEOUT") || "120") * 1000;
    const size = env("HTML_PPT_IMAGE_SIZE") || "1024x1024";
    const reference = typeof req.image === "string" && req.image.startsWith("data:image/") ? req.image : undefined;
    dataUrl = await generateImage({ apiKey, baseUrl, timeoutMs, prompt, reference, size });
    mock = false;
    message = "Generated image.";
  }

  const patch = validatePatch({ [key]: dataUrl });
  if (Object.keys(patch).length === 0) throw new Error("Generated image failed validation.");
  return { patches: [{ id: ctx.id, patch }], message, mock };
}

interface ImageGenArgs {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  prompt: string;
  reference?: string;
  size: string;
}

async function generateImage(args: ImageGenArgs): Promise<string> {
  const model = env("HTML_PPT_IMAGE_MODEL") || "gpt-image-1";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    let resp: Response;
    if (args.reference) {
      // img2img: send the current image to the edits endpoint as multipart.
      const fd = new FormData();
      fd.append("model", model);
      fd.append("prompt", args.prompt);
      fd.append("size", args.size);
      fd.append("image", dataUrlToBlob(args.reference), "image.png");
      resp = await fetch(`${args.baseUrl}/images/edits`, {
        method: "POST",
        headers: { Authorization: `Bearer ${args.apiKey}` },
        body: fd,
        signal: controller.signal,
      });
    } else {
      resp = await fetch(`${args.baseUrl}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: args.prompt, size: args.size, n: 1 }),
        signal: controller.signal,
      });
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`OpenAI image API error ${resp.status}: ${detail.slice(0, 800)}`);
    }
    const json = (await resp.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) throw new Error("Image API returned no image data.");
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    throw new Error(`Image generation failed: ${String((err as Error)?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }
}

// A deterministic, clearly-labeled placeholder so the demo visibly "replaces" the
// object without any AI. Returned as an svg+xml data URL (passes the validator).
// Prompt-driven palettes so the demo "generates" visibly different images for
// different prompts (deterministic — same prompt always yields the same image).
const DEMO_PALETTES: Record<string, [string, string, string]> = {
  gold: ["#241c10", "#6b5320", "#e8c074"],
  blue: ["#0a1830", "#15457a", "#4aa8ff"],
  ocean: ["#021b2e", "#0a6b7a", "#39d0c8"],
  sunset: ["#2a1030", "#a83265", "#ff9e4a"],
  forest: ["#08200f", "#1f6b32", "#9bd07a"],
  red: ["#2a0d10", "#8a1f29", "#ff6b5a"],
  purple: ["#1a0f2e", "#5a3a8a", "#b98aff"],
  mono: ["#0c0c0d", "#3a3a40", "#b9b9c2"],
  warm: ["#2a1810", "#8a4a20", "#e8b06a"],
  cool: ["#0c1a2a", "#2a5a8a", "#7ec8ff"],
};

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickPalette(p: string): [string, string, string] {
  const map: Array<[RegExp, keyof typeof DEMO_PALETTES]> = [
    [/(gold|premium|luxury|fancy|골드|금|고급)/, "gold"],
    [/(ocean|sea|water|wave|바다|물|파도)/, "ocean"],
    [/(sunset|dusk|dawn|노을|석양)/, "sunset"],
    [/(forest|nature|plant|green|숲|자연|초록)/, "forest"],
    [/(red|ruby|빨강|루비)/, "red"],
    [/(purple|violet|보라)/, "purple"],
    [/(sky|blue|블루|파랑)/, "blue"],
    [/(mono|gray|grey|black|white|minimal|흑백|모노|미니멀)/, "mono"],
    [/(warm|cozy|따뜻)/, "warm"],
    [/(cool|ice|차가)/, "cool"],
  ];
  for (const [re, key] of map) if (re.test(p)) return DEMO_PALETTES[key];
  const keys = Object.keys(DEMO_PALETTES) as Array<keyof typeof DEMO_PALETTES>;
  return DEMO_PALETTES[keys[hashString(p) % keys.length]];
}

// A labeled, prompt-styled placeholder. Not real AI — but visibly different per
// prompt so the generate→replace flow demos convincingly with no key.
function placeholderImage(prompt: string): string {
  const text = (prompt || "AI image").slice(0, 56).replace(/[<>&]/g, " ");
  const [c0, c1, c2] = pickPalette(prompt.toLowerCase());
  const minimal = /(minimal|미니멀|flat|clean|simple)/.test(prompt.toLowerCase());
  const h = hashString(prompt);
  // Deterministic motif placement from the hash.
  const cx = 300 + (h % 420);
  const cy = 360 + ((h >> 9) % 240);
  const r = 150 + ((h >> 5) % 130);
  const motif = minimal
    ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c2}" opacity="0.9"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c2}" opacity="0.22"/>` +
      `<circle cx="${1024 - cx}" cy="${cy - 60}" r="${r * 0.6}" fill="#ffffff" opacity="0.10"/>` +
      `<circle cx="${cx + 120}" cy="${cy + 140}" r="${r * 0.4}" fill="${c2}" opacity="0.35"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${c0}"/><stop offset="0.55" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>` +
    `</linearGradient><radialGradient id="v" cx="0.5" cy="0.42" r="0.75">` +
    `<stop offset="0.55" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.45"/>` +
    `</radialGradient></defs>` +
    `<rect width="1024" height="1024" fill="url(#g)"/>` +
    motif +
    `<rect width="1024" height="1024" fill="url(#v)"/>` +
    `<rect x="40" y="40" width="150" height="40" rx="20" fill="rgba(0,0,0,0.35)"/>` +
    `<text x="115" y="67" font-family="Arial, sans-serif" font-size="20" font-weight="700" letter-spacing="2" fill="#fff" text-anchor="middle">AI · DEMO</text>` +
    `<text x="512" y="900" font-family="Arial, sans-serif" font-size="34" fill="#ffffff" text-anchor="middle">${text}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${toBase64(svg)}`;
}

function toBase64(str: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(str, "utf-8").toString("base64");
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = head.match(/data:([^;]+)/)?.[1] || "image/png";
  const bin = typeof atob !== "undefined" ? atob(body) : Buffer.from(body, "base64").toString("binary");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// ---------------------------------------------------------------------------
// Web image SEARCH — find REAL photos on the web for one OR MANY selected
// objects and paste one per object. Unlike handleAiImage (which *generates* an
// image with gpt-image-1 and only handles the primary selection), this uses a
// web-search-capable model to find real image URLs per object, then the server
// fetches + inlines each as a data URL so the deck stays self-contained. Returns
// one patch per object (src for <img>, background-image otherwise).
// ---------------------------------------------------------------------------

export interface AiImageSearchRequest {
  prompt: string;
  contexts?: Array<ContextLike & { tag?: string }>;
  context?: ContextLike & { tag?: string };
  deckBrief?: Record<string, unknown>;
}

const IMAGE_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          query: { type: "string" },
          candidates: { type: "array", items: { type: "string" }, description: "3–5 direct image URLs, best first." },
        },
        required: ["id", "candidates"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

const MAX_IMAGE_BYTES = Number(env("HTML_PPT_IMAGE_MAX_BYTES") || String(5 * 1024 * 1024));

// True when a dedicated stock-photo provider is configured. These return DIRECT
// image URLs in ~1s — far faster and more reliable than asking a web-search
// reasoning model to guess image URLs (which often returned page links).
function hasStockProvider(): boolean {
  return !!(env("UNSPLASH_ACCESS_KEY") || env("PEXELS_API_KEY"));
}

// Build a focused query for one object from the prompt + the object's own label,
// so distinct boxes get distinct photos instead of all sharing one query.
function buildImageQuery(prompt: string, label: string): string {
  const q = `${prompt} ${label}`.replace(/\s+/g, " ").trim();
  return q.slice(0, 100) || prompt || "abstract background";
}

// Query Unsplash then Pexels for direct image URLs. Returns [] (never throws) so
// the caller can fall back. Fast (single REST call per provider, ~10s timeout).
async function searchStockImages(query: string, count: number): Promise<string[]> {
  const timeoutMs = Number(env("HTML_PPT_STOCK_TIMEOUT") || "10") * 1000;
  const unsplashKey = env("UNSPLASH_ACCESS_KEY");
  const pexelsKey = env("PEXELS_API_KEY");

  const get = async (url: string, headers: Record<string, string>): Promise<Record<string, unknown> | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { headers, signal: controller.signal });
      if (!resp.ok) return null;
      return (await resp.json()) as Record<string, unknown>;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  if (unsplashKey) {
    const json = await get(
      `https://api.unsplash.com/search/photos?per_page=${count}&content_filter=high&orientation=landscape&query=${encodeURIComponent(query)}`,
      { Authorization: `Client-ID ${unsplashKey}`, "Accept-Version": "v1" }
    );
    const results = Array.isArray(json?.results) ? (json!.results as unknown[]) : [];
    const urls = results
      .map((r) => ((r as Record<string, unknown>)?.urls as Record<string, unknown> | undefined)?.regular)
      .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
    if (urls.length) return urls;
  }

  if (pexelsKey) {
    const json = await get(
      `https://api.pexels.com/v1/search?per_page=${count}&orientation=landscape&query=${encodeURIComponent(query)}`,
      { Authorization: pexelsKey }
    );
    const photos = Array.isArray(json?.photos) ? (json!.photos as unknown[]) : [];
    const urls = photos
      .map((p) => ((p as Record<string, unknown>)?.src as Record<string, unknown> | undefined)?.large)
      .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
    if (urls.length) return urls;
  }

  return [];
}

export async function handleAiImageSearch(req: AiImageSearchRequest): Promise<AiEditResponse> {
  const prompt = (req?.prompt ?? "").trim();
  const contexts = (Array.isArray(req?.contexts) ? req.contexts : req?.context ? [req.context] : []).filter(
    (c): c is ContextLike & { tag?: string } => !!c && typeof c.id === "string" && !!c.id
  );
  if (!contexts.length) throw new Error("No selected object context was provided.");

  const apiKey = env("OPENAI_API_KEY");
  const stock = hasStockProvider();
  const forceMock = /^(1|true|yes|on)$/i.test(env("HTML_PPT_AI_MOCK") || "");

  const keyFor = (c: ContextLike & { tag?: string }) => (String(c.tag || "").toLowerCase() === "img" ? "src" : "backgroundImage");

  // No provider (no stock key AND no OpenAI key) / mock → a labeled placeholder
  // per object, so the multi-object flow still demonstrably pastes one per box.
  if (forceMock || (!apiKey && !stock)) {
    const patches: PatchOp[] = [];
    for (const c of contexts) {
      const img = placeholderImage(`${prompt} ${String(c.text ?? "")}`.trim() || "image");
      const patch = validatePatch({ [keyFor(c)]: img });
      if (Object.keys(patch).length) patches.push({ id: c.id as string, patch });
    }
    if (!patches.length) throw new Error("Image search produced nothing usable.");
    return { patches, message: `Demo mode — inserted ${patches.length} placeholder image${patches.length === 1 ? "" : "s"} (set UNSPLASH_ACCESS_KEY/PEXELS_API_KEY or OPENAI_API_KEY for real web image search).`, mock: true };
  }

  // 1) Find candidate URLs per object. Prefer a fast stock provider (Unsplash/
  // Pexels) — a direct REST call per object, run in parallel; fall back to the
  // web-search model only if no stock key is set (or stock returns nothing).
  let found: Array<{ id: string; candidates: string[] }>;
  if (stock) {
    found = await Promise.all(
      contexts.map(async (c) => ({
        id: c.id as string,
        candidates: await searchStockImages(buildImageQuery(prompt, String(c.text ?? "")), 5).catch(() => []),
      }))
    );
    // If stock found nothing for ANY object and we still have an OpenAI key,
    // fall back to the web-search model so the request isn't a total miss.
    if (apiKey && found.every((f) => !f.candidates.length)) {
      found = await searchImageCandidates({ apiKey, prompt, contexts, deckBrief: req.deckBrief });
    }
  } else {
    found = await searchImageCandidates({ apiKey: apiKey as string, prompt, contexts, deckBrief: req.deckBrief });
  }

  // 2) Fetch + inline the first working candidate per object (in parallel).
  const patches = (
    await Promise.all(
      contexts.map(async (c): Promise<PatchOp | null> => {
        const item = found.find((f) => f.id === c.id) ?? found[contexts.indexOf(c)];
        const candidates = item?.candidates ?? [];
        for (const url of candidates) {
          const dataUrl = await fetchInlineImage(url).catch(() => null);
          if (dataUrl) {
            const patch = validatePatch({ [keyFor(c)]: dataUrl });
            if (Object.keys(patch).length) return { id: c.id as string, patch };
          }
        }
        return null;
      })
    )
  ).filter((p): p is PatchOp => !!p);

  if (!patches.length) throw new Error("No usable images were found on the web for the selected objects.");
  const missed = contexts.length - patches.length;
  const message =
    `Pasted ${patches.length} web image${patches.length === 1 ? "" : "s"}` + (missed > 0 ? ` (${missed} object${missed === 1 ? "" : "s"} had no usable result)` : "") + ".";
  return { patches, message, mock: false };
}

interface SearchArgs {
  apiKey: string;
  prompt: string;
  contexts: Array<ContextLike & { tag?: string }>;
  deckBrief?: Record<string, unknown>;
}

async function searchImageCandidates(args: SearchArgs): Promise<Array<{ id: string; candidates: string[] }>> {
  const model = env("HTML_PPT_IMAGE_SEARCH_MODEL") || "gpt-5.5";
  const baseUrl = (env("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
  const timeoutMs = Number(env("HTML_PPT_IMAGE_SEARCH_TIMEOUT") || "120") * 1000;
  const tool = env("HTML_PPT_OPENAI_WEBSEARCH_TOOL") || "web_search";

  const system =
    "You find REAL, currently-online, directly-loadable image URLs using web search. " +
    "For EACH selected object, search the web and return 3–5 candidate DIRECT image URLs (links that return an actual image file: .jpg/.jpeg/.png/.webp, or a known direct image/CDN link), best first. " +
    "Prefer official / brand / high-resolution sources that match the object's label and the overall topic. " +
    "Do NOT invent or guess URLs — only return links you actually found. Never return page URLs that aren't the image itself.";
  const user = {
    request: args.prompt,
    deck_topic: args.deckBrief?.topic ?? "",
    objects: args.contexts.map((c) => ({ id: c.id, label: String(c.text ?? "").slice(0, 120) })),
  };

  const payload = {
    model,
    tools: [{ type: tool }],
    input: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) },
    ],
    text: { format: { type: "json_schema", name: "image_search_results", schema: IMAGE_SEARCH_SCHEMA, strict: false } },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Image search connection failed: ${String((err as Error)?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Image search API error ${resp.status}: ${detail.slice(0, 800)}`);
  }
  const text = extractResponseText((await resp.json()) as Record<string, unknown>);
  if (!text) throw new Error("Image search returned no output.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Image search output was not valid JSON.");
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => (it && typeof it === "object" ? (it as Record<string, unknown>) : null))
    .filter((it): it is Record<string, unknown> => !!it && typeof it.id === "string")
    .map((it) => ({
      id: it.id as string,
      candidates: Array.isArray(it.candidates) ? (it.candidates as unknown[]).filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u)) : [],
    }));
}

// Fetch an external image URL and return it as an inlined data URL (or null).
// Validates content-type + size so the deck stays self-contained and bounded.
async function fetchInlineImage(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Slidesmith/1.0)", Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!resp.ok) return null;
    const ct = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\/(png|jpe?g|webp|gif|svg\+xml|avif)$/.test(ct)) return null;
    const buf = await resp.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX_IMAGE_BYTES) return null;
    return `data:${ct};base64,${bytesToBase64(new Uint8Array(buf))}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
