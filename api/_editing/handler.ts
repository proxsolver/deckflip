// Server-side AI EDIT logic. Holds the OpenAI key (server-only), runs the
// validator as the authoritative gate, and returns a safe action envelope
// (patch | layout | insertBlock | sceneParam). If OPENAI_API_KEY is absent it
// returns the deterministic mock actions — the full UI flow works with zero
// secrets, exactly like the desktop app's mock mode.

import {
  ACTION_ENVELOPE_SCHEMA,
  validatePatch,
  validateActions,
  PATCH_KEYS,
  ANIMATION_NONE,
  ANIMATION_PRESETS,
  ANIMATION_TIMING_FUNCTIONS,
  LAYOUT_VERBS,
  BLOCK_TEMPLATES,
  BLOCK_TYPES,
  SCENE_PARAMS,
  SCENE_PARAM_KEYS,
  type EditorAction,
  type BlockType,
} from "../../shared/editing";
import { env, extractResponseText, type ContextLike } from "./common";

export interface AiEditRequest {
  prompt: string;
  /** Legacy single-object context. */
  context?: ContextLike;
  /** Multi-object selection; preferred. Each entry carries its own `id`. */
  contexts?: ContextLike[];
  /** Optional design brief from the generation step — the deck's original intent,
   *  threaded in as memory so edits stay consistent with how the deck was built. */
  deckBrief?: Record<string, unknown>;
}

// The unified action envelope returned by the text endpoint (patch | layout |
// insertBlock | sceneParam). Replaces the bare patch list as the primary shape;
// the image endpoint still uses AiEditResponse (see ./image).
export interface AiActionResponse {
  actions: EditorAction[];
  message: string;
  mock: boolean;
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

  const raw = await callOpenAi({ apiKey, model, baseUrl, timeoutMs, prompt, contexts, deckBrief: req.deckBrief });
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
  deckBrief?: Record<string, unknown>;
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
    // Original deck design intent (present for AI-generated decks) so edits stay
    // consistent with the deck's palette/fonts/voice. Advisory context only.
    deck_brief: args.deckBrief,
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

  // Reasoning models (gpt-5.x / o-series) bill reasoning tokens against the
  // output budget, so WITHOUT an explicit max_output_tokens the JSON can come back
  // empty/truncated → "no valid actions" for every edit. Give it room, and ask for
  // LOW reasoning effort since these are small, fast style/layout edits.
  const reasoning = /^(gpt-5|o\d)/i.test(args.model);
  const payload: Record<string, unknown> = {
    model: args.model,
    input: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) },
    ],
    max_output_tokens: Number(env("HTML_PPT_AI_MAX_TOKENS") || "16000"),
    text: {
      format: { type: "json_schema", name: "html_editor_actions", schema: ACTION_ENVELOPE_SCHEMA, strict: true },
    },
    ...(reasoning ? { reasoning: { effort: env("HTML_PPT_AI_REASONING") || "low" } } : {}),
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
