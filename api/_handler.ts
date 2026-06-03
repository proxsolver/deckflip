// Server-side AI logic. Ported from ai/client.py. Holds the OpenAI key
// (server-only), runs the validator as the authoritative gate, and returns a
// safe patch. If OPENAI_API_KEY is absent it returns the deterministic mock
// patch — the full UI flow works with zero secrets, exactly like the desktop
// app's mock mode.

import { ACTION_ENVELOPE_SCHEMA } from "../shared/patch-schema";
import { validatePatch, validateActions } from "../shared/validator";
import { PATCH_KEYS, type PatchOp } from "../shared/patch-keys";
import { ANIMATION_NONE, ANIMATION_PRESETS, ANIMATION_TIMING_FUNCTIONS } from "../shared/animation-presets";
import { LAYOUT_VERBS, type EditorAction } from "../shared/actions";
import { BLOCK_TEMPLATES, BLOCK_TYPES, type BlockType } from "../shared/blocks";
import { SCENE_PARAMS, SCENE_PARAM_KEYS } from "../shared/scene-params";

type ContextLike = Record<string, unknown> & {
  id?: string;
  text?: string;
  fontSize?: number;
  w?: number;
};

export interface AiEditRequest {
  prompt: string;
  /** Legacy single-object context. */
  context?: ContextLike;
  /** Multi-object selection; preferred. Each entry carries its own `id`. */
  contexts?: ContextLike[];
}

export interface AiEditResponse {
  patches: PatchOp[];
  message: string;
  /** true when these patches came from the offline demo/mock engine (no real AI). */
  mock: boolean;
}

// The unified action envelope returned by the text endpoint (patch | layout |
// insertBlock). Replaces the bare patch list as the primary shape; the image
// endpoint still uses AiEditResponse.
export interface AiActionResponse {
  actions: EditorAction[];
  message: string;
  mock: boolean;
}

function env(name: string): string | undefined {
  // Works under Node (Vercel/Netlify functions) and most edge runtimes.
  return (typeof process !== "undefined" && process.env ? process.env[name] : undefined)?.trim() || undefined;
}

const PATCH_KEYS_FOR_PROMPT = [...PATCH_KEYS];

// Accept either the multi-object `contexts` array or the legacy single `context`.
function normalizeContexts(req: AiEditRequest): ContextLike[] {
  const list = Array.isArray(req?.contexts) ? req.contexts : req?.context ? [req.context] : [];
  return list.filter((c): c is ContextLike => !!c && typeof c.id === "string" && c.id.length > 0);
}

export async function handleAiEdit(req: AiEditRequest): Promise<AiActionResponse> {
  const prompt = (req?.prompt ?? "").trim();
  if (!prompt) throw new Error("Prompt is empty.");
  const contexts = normalizeContexts(req);
  if (!contexts.length) throw new Error("No selected object context was provided.");
  const ids = contexts.map((c) => c.id as string);

  // Demo mode: no key, or explicitly forced via HTML_PPT_AI_MOCK (so you can demo
  // the full flow even when a real key is configured).
  const apiKey = env("OPENAI_API_KEY");
  const forceMock = /^(1|true|yes|on)$/i.test(env("HTML_PPT_AI_MOCK") || "");
  if (!apiKey || forceMock) return mockActions(prompt, contexts);

  const model = env("HTML_PPT_AI_MODEL") || env("OPENAI_MODEL") || "gpt-4.1-mini";
  const baseUrl = (env("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
  const timeoutMs = Number(env("HTML_PPT_AI_TIMEOUT") || "45") * 1000;

  const raw = await callOpenAi({ apiKey, model, baseUrl, timeoutMs, prompt, contexts });
  const message =
    raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).message === "string"
      ? ((raw as Record<string, unknown>).message as string)
      : "AI changes generated.";
  const actions = validateActions(raw, ids);
  if (actions.length === 0) {
    throw new Error("AI returned no valid actions after validation.");
  }
  return { actions, message, mock: false };
}

interface CallArgs {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  prompt: string;
  contexts: ContextLike[];
}

async function callOpenAi(args: CallArgs): Promise<unknown> {
  const system =
    "You are an assistant inside a visual HTML presentation editor. " +
    "You receive SEVERAL selected DOM objects, each with an `id`, and a user's edit request. " +
    "Return JSON of the form { message, actions } where `actions` is an array. Each action has a `type`:\n" +
    '- "patch": set `id` to the target object\'s id and `patch` to the style/text changes for it.\n' +
    '- "layout": arrange MULTIPLE selected objects — set `op` (one of the allowed verbs), `ids` (the objects to arrange), ' +
    "and `axis`/`relativeTo`/`gap`/`cols`/`step` as relevant. NEVER set coordinates yourself for layout — the editor computes them.\n" +
    '- "insertBlock": add a new content block — set `blockType` (one of the allowed types) and `slots` (array of {name,value}) ' +
    "for that block's text.\n" +
    '- "sceneParam": tune the deck\'s 3D / canvas BACKGROUND animation — set `sceneKey` (one of the allowed scene params) ' +
    "and `sceneValue` (a number within that param's range, or a CSS color). Use this ONLY when the user asks to change the " +
    "moving 3D/canvas background itself (spin speed, particles, light color, brightness); it has no `id`.\n" +
    "Set every unused field to null. " +
    "Never return full HTML, JavaScript, CSS files, markdown, or explanations outside the JSON schema. " +
    "Preserve HTML semantics and animation classes. Prefer small, safe edits. " +
    "For background/animation layers you may only adjust style (opacity, color, filter); never attempt to change scripts. " +
    "Use CSS-safe colors such as #RRGGBB, rgb(...), rgba(...), or simple color names. " +
    "To animate an object, set `animationName` to one of the allowed preset names (or \"none\") — NEVER invent keyframes.";

  const blockSlots = Object.fromEntries(
    (BLOCK_TYPES as readonly BlockType[]).map((t) => [t, BLOCK_TEMPLATES[t].slots.map((s) => s.name)])
  );

  const user = {
    request: args.prompt,
    selected_objects: args.contexts,
    allowed_patch_keys: PATCH_KEYS_FOR_PROMPT,
    animation_presets: [ANIMATION_NONE, ...ANIMATION_PRESETS],
    animation_timing_functions: [...ANIMATION_TIMING_FUNCTIONS],
    layout_verbs: [...LAYOUT_VERBS],
    block_types: blockSlots,
    scene_params: SCENE_PARAM_KEYS.map((k) => {
      const s = SCENE_PARAMS[k];
      return s.type === "number" ? { key: k, type: s.type, min: s.min, max: s.max } : { key: k, type: s.type };
    }),
    rules: [
      "Use a `patch` action per object you restyle; each MUST include that object's `id`.",
      "Use ONE `layout` action to arrange several objects; put their ids in `ids` and never compute coordinates.",
      "Use `align` with relativeTo:\"slide\" to center on the slide; relativeTo:\"group\" aligns within the selection.",
      "Use an `insertBlock` action to add new content; fill only the slot names listed for that block type.",
      "Use a `sceneParam` action (sceneKey + sceneValue) ONLY to change the moving 3D/canvas background; one action per param.",
      "If changing text, return plain text with line breaks matching visible text segments when possible.",
      "Do not remove important nested tags; the app maps text lines onto existing text nodes.",
      "If the request is vague, make a minimal tasteful adjustment.",
    ],
  };

  const payload = {
    model: args.model,
    input: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) },
    ],
    text: {
      format: { type: "json_schema", name: "html_editor_actions", schema: ACTION_ENVELOPE_SCHEMA, strict: true },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${args.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
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
  const text = extractResponseText(response);
  if (!text) throw new Error("OpenAI response did not contain output text.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`AI output was not valid JSON: ${text.slice(0, 1000)}`);
  }
}

// Tolerant to the various Responses API shapes (port of _extract_response_text).
function extractResponseText(response: Record<string, unknown>): string {
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

// Deterministic fallback (port of _mock_patch). Bilingual Korean/English
// keyword matching — keep the Korean keywords. Emits the full action vocabulary
// (patch + layout + insertBlock) so the whole flow works with zero secrets.
function mockActions(prompt: string, contexts: ContextLike[]): AiActionResponse {
  const ids = contexts.map((c) => c.id as string);
  const p = prompt.toLowerCase();
  const has = (...tokens: string[]) => tokens.some((t) => p.includes(t));
  const actions: EditorAction[] = [];

  // Scene-param intent (the 3D / canvas background). Computed first so that when
  // the prompt is clearly about the background we don't also slap a stray
  // fallback border on the selected object.
  const sceneActions = mockSceneParams(prompt);
  const sceneIntent = sceneActions.length > 0;

  // Per-object style/text/animation patches (the original demo logic).
  for (const ctx of contexts) {
    const patch = validatePatch(mockPatchFor(prompt, ctx, !sceneIntent));
    if (Object.keys(patch).length) actions.push({ type: "patch", id: ctx.id as string, patch });
  }
  actions.push(...sceneActions);

  // Layout intent over the whole selection.
  if (ids.length >= 2) {
    if (has("가운데", "center", "중앙"))
      actions.push({ type: "layout", op: "align", axis: "hcenter", ids, relativeTo: "slide" });
    else if (has("왼쪽", "left", "좌측")) actions.push({ type: "layout", op: "align", axis: "left", ids });
    else if (has("오른쪽", "right", "우측")) actions.push({ type: "layout", op: "align", axis: "right", ids });
    else if (has("위", "top", "상단")) actions.push({ type: "layout", op: "align", axis: "top", ids });
    else if (has("아래", "bottom", "하단")) actions.push({ type: "layout", op: "align", axis: "bottom", ids });
    else if ((has("분배", "distribute", "고르게") && ids.length >= 3))
      actions.push({ type: "layout", op: "distribute", axis: "horizontal", ids });
    else if (has("격자", "grid", "그리드")) actions.push({ type: "layout", op: "grid", ids, cols: 2 });
    else if (has("쌓", "stack", "세로로")) actions.push({ type: "layout", op: "stack", axis: "vertical", ids, gap: 12 });
  }

  // Block-insertion intent.
  if (has("추가", "add", "삽입", "insert", "넣어", "만들어")) {
    const map: Array<[string[], BlockType]> = [
      [["통계", "stat", "수치", "지표"], "statCard"],
      [["인용", "quote", "명언"], "quote"],
      [["불릿", "bullet", "목록"], "bulletItem"],
      [["라벨", "label", "칩", "chip", "태그"], "labelChip"],
      [["콜아웃", "callout", "강조"], "callout"],
    ];
    const found = map.find(([kw]) => has(...kw));
    actions.push({ type: "insertBlock", blockType: found ? found[1] : "callout", slots: [] });
  }

  const n = actions.length;
  return {
    actions,
    message: `Demo mode — ${n} action${n === 1 ? "" : "s"} (no real AI; set OPENAI_API_KEY to use a live model).`,
    mock: true,
  };
}

// Deterministic scene-param matching for demo mode (bilingual). Targets the 3D /
// canvas background; emitted only when a background-motion keyword is present, so
// it never fires on ordinary object edits. The editor no-ops these if the loaded
// deck exposes no scene controller.
function mockSceneParams(prompt: string): EditorAction[] {
  const p = prompt.toLowerCase();
  const has = (...tokens: string[]) => tokens.some((t) => p.includes(t));
  const out: EditorAction[] = [];
  const add = (key: keyof typeof SCENE_PARAMS, value: number | string) =>
    out.push({ type: "sceneParam", key, value });

  // Spin speed.
  if (has("spin faster", "faster", "빠르게", "빨리", "회전 빠")) add("spinSpeed", 2.2);
  else if (has("spin slower", "slower", "천천히", "느리게", "회전 느")) add("spinSpeed", 0.4);
  else if (has("stop spin", "stop rotating", "정지", "회전 멈")) add("spinSpeed", 0);

  // Particle density.
  if (has("more particle", "denser", "입자 많", "파티클 많")) add("particleOpacity", 1);
  else if (has("fewer particle", "less particle", "입자 적", "파티클 줄", "particle off")) add("particleOpacity", 0.15);

  // Light colors (reuse the named-color table).
  const color = DEMO_COLORS.find((c) => has(...c.tokens));
  if (color && has("light", "lighting", "glow", "조명", "빛", "라이트")) {
    add(has("fill", "secondary", "보조") ? "fillLightColor" : "keyLightColor", color.value);
  }

  // Brightness of the whole scene.
  if (has("brighter background", "background brighter", "배경 밝", "장면 밝")) add("brightness", 1.5);
  else if (has("darker background", "background darker", "배경 어둡", "장면 어둡")) add("brightness", 0.6);

  return out;
}

// Named colors the demo understands, English + Korean.
const DEMO_COLORS: Array<{ tokens: string[]; value: string }> = [
  { tokens: ["gold", "골드", "금색"], value: "#8A7544" },
  { tokens: ["blue", "파랑", "파란", "블루"], value: "#0A84FF" },
  { tokens: ["red", "빨강", "빨간", "레드"], value: "#E5484D" },
  { tokens: ["green", "초록", "녹색", "그린"], value: "#2E9E5B" },
  { tokens: ["black", "검정", "검은"], value: "#111111" },
  { tokens: ["white", "흰색", "하양"], value: "#FFFFFF" },
  { tokens: ["beige", "베이지", "크림"], value: "#F8F6F1" },
];

function mockPatchFor(
  prompt: string,
  context: Record<string, unknown>,
  allowFallback = true
): Record<string, unknown> {
  const p = prompt.toLowerCase();
  const patch: Record<string, unknown> = {};
  const currentText = String(context.text ?? "");
  const has = (...tokens: string[]) => tokens.some((t) => p.includes(t));

  if (has("고급", "premium", "luxury", "elegant", "세련")) {
    Object.assign(patch, {
      color: "#1A1A1A",
      backgroundColor: "#F8F6F1",
      borderColor: "#8A7544",
      borderWidth: "2px",
      borderStyle: "solid",
      borderRadius: "14px",
    });
  }
  if (has("크게", "bigger", "larger", "강조", "emphasize")) {
    patch.fontSize = Math.min(500, Number(context.fontSize ?? 24) + 8);
    patch.fontWeight = 800;
  }
  if (has("작게", "smaller")) {
    patch.fontSize = Math.max(1, Number(context.fontSize ?? 24) - 6);
  }
  if (has("가운데", "center", "중앙")) {
    const w = Number(context.w ?? 400);
    patch.x = Math.max(0, Math.round((1920 - w) / 2)); // assumes ~1920px 16:9 canvas
  }
  if (has("짧게", "concise", "shorten")) {
    if (currentText) patch.text = currentText.split("\n")[0].slice(0, 90);
  }
  if (has("영어", "english")) {
    if (currentText) patch.text = currentText;
  }
  if (has("굵게", "bold", "두껍")) patch.fontWeight = 800;
  if (has("얇게", "thin", "가늘")) patch.fontWeight = 300;
  // \bround\b so we don't match the "round" inside "background".
  if (has("둥글", "rounded", "라운드") || /\bround\b/.test(p)) patch.borderRadius = "16px";
  if (has("테두리", "border", "outline")) {
    patch.borderColor = patch.borderColor ?? "#8A7544";
    patch.borderWidth = "2px";
    patch.borderStyle = "solid";
  }
  if (has("투명", "transparent", "see-through")) patch.backgroundColor = "rgba(0,0,0,0)";

  // Named colors → text color, or fill/border when the phrasing implies it.
  const color = DEMO_COLORS.find((c) => has(...c.tokens));
  if (color) {
    if (has("배경", "background", "fill", "채우")) patch.backgroundColor = color.value;
    else if (has("테두리", "border", "outline")) {
      patch.borderColor = color.value;
      patch.borderWidth = "2px";
      patch.borderStyle = "solid";
    } else patch.color = color.value;
  }

  // Animation keywords → a preset name (timing is backfilled when applied).
  if (has("페이드", "fade", "서서히", "나타나")) patch.animationName = "fadeInUp";
  else if (has("슬라이드", "slide", "밀어", "미끄")) patch.animationName = "slideInLeft";
  else if (has("확대", "zoom", "줌", "커지")) patch.animationName = "zoomIn";
  else if (has("펄스", "pulse", "두근", "깜빡")) patch.animationName = "pulse";
  else if (has("둥둥", "float", "떠다", "부유")) patch.animationName = "float";
  else if (has("애니메이션", "animate", "animation", "움직", "등장")) patch.animationName = "fadeInUp";
  // Pause/resume an existing animation (distinct from REMOVING it).
  if (has("pause", "일시정지", "정지", "멈춰", "멈추")) patch.animationPlayState = "paused";
  else if (has("resume", "play", "재생", "계속")) patch.animationPlayState = "running";
  if (has("no animation", "remove animation", "애니메이션 제거", "애니메이션 삭제"))
    patch.animationName = "none";

  // Background-friendly keywords (work on the picker-selected background too).
  if (has("흐리게", "blur", "블러")) patch.filter = "blur(6px)";
  if (has("선명", "sharpen", "unblur", "초점")) patch.filter = "none";
  if (has("어둡게", "dim", "흐릿", "은은")) patch.opacity = 0.35;
  if (has("밝게", "brighten", "brighter", "환하")) patch.filter = "brightness(1.4)";

  if (allowFallback && Object.keys(patch).length === 0) {
    // Nothing matched — make a visible-but-harmless tweak so the demo always "does
    // something" and the round-trip is obvious. Suppressed when the prompt is
    // really about the background scene (so we don't deface the selected object).
    patch.borderColor = "#0A84FF";
    patch.borderWidth = "2px";
    patch.borderStyle = "dashed";
  }
  return patch;
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
