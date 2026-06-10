// Input validation for DeckFlip API endpoints.
// Guards against oversized payloads, prompt injection hints, and malformed data
// BEFORE they reach the expensive AI API calls.

// --- config ----------------------------------------------------------------

const TOPIC_MIN = 2;
const TOPIC_MAX = 2000;
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE_MB = 5;
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;
const MAX_JSON_PAYLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

// Allowed values for enum-like fields (expand as needed).
const ALLOWED_LANGUAGES = new Set(["ko", "en", "ja", "zh", "auto", ""]);
const ALLOWED_LENGTHS = new Set(["short", "medium", "long", "auto", ""]);
const ALLOWED_STYLES = new Set([
  "modern", "corporate", "creative", "minimal", "bold", "elegant",
  "playful", "professional", "tech", "academic", "auto", "",
]);

// Prompt injection red flags (substring match, case-insensitive).
// This is a lightweight first pass — the AI pipeline has its own deeper defense.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+(instructions|prompts)/i,
  /forget\s+(everything|all|previous)/i,
  /you\s+are\s+now\s+/i,
  /system\s*:\s*/i,
  /<\|im_start\|>/i,
  /\[SYSTEM\]/i,
  /###\s*system/i,
  /reveal\s+(your|the|all)\s+(prompt|pipeline|instructions?)/i,
  /show\s+me\s+(your|the|all)\s+(prompt|pipeline|system)/i,
  /dump\s+(your|the|all)\s+(prompt|system|pipeline)/i,
];

// --- types ------------------------------------------------------------------

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationOutput {
  valid: boolean;
  errors: ValidationError[];
}

// --- validators -------------------------------------------------------------

function topic(value: unknown): ValidationError | null {
  if (typeof value !== "string") return { field: "topic", message: "topic must be a string." };
  const trimmed = value.trim();
  if (trimmed.length < TOPIC_MIN) return { field: "topic", message: `최소 ${TOPIC_MIN}자 이상 입력해주세요.` };
  if (trimmed.length > TOPIC_MAX) return { field: "topic", message: `최대 ${TOPIC_MAX}자까지 입력 가능합니다.` };
  return null;
}

function enumField(value: unknown, field: string, allowed: Set<string>): ValidationError | null {
  if (value === undefined || value === null) return null; // optional fields
  if (typeof value !== "string") return { field, message: `${field} must be a string.` };
  if (!allowed.has(value)) {
    const examples = [...allowed].filter(Boolean).slice(0, 5).join(", ");
    return { field, message: `${field}: 허용되지 않는 값입니다. (${examples}...)` };
  }
  return null;
}

function images(value: unknown): ValidationError | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return { field: "images", message: "images must be an array." };
  if (value.length > MAX_IMAGES) return { field: "images", message: `이미지는 최대 ${MAX_IMAGES}장까지 가능합니다.` };
  for (let i = 0; i < value.length; i++) {
    const img = value[i];
    if (typeof img !== "string" || !img.startsWith("data:")) {
      return { field: `images[${i}]`, message: "data URL 형식이어야 합니다." };
    }
    // Rough size check: base64 is ~1.37x the raw size.
    const commaIdx = img.indexOf(",");
    const b64 = commaIdx >= 0 ? img.slice(commaIdx + 1) : "";
    if (b64.length * 0.75 > MAX_IMAGE_SIZE_BYTES) {
      return { field: `images[${i}]`, message: `이미지 크기가 ${MAX_IMAGE_SIZE_MB}MB를 초과합니다.` };
    }
  }
  return null;
}

function injectionCheck(value: unknown): ValidationError | null {
  if (typeof value !== "string") return null;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(value)) {
      return { field: "topic", message: "입력에 허용되지 않는 내용이 포함되어 있습니다." };
    }
  }
  return null;
}

// --- public API -------------------------------------------------------------

/**
 * Validate a generation request payload. Returns an object with `valid` and
 * an array of errors (empty when valid). Call BEFORE passing data to the
 * generation handler to avoid wasting API tokens on bad input.
 */
export function validateGenerateRequest(body: unknown): ValidationOutput {
  if (!body || typeof body !== "object") {
    return { valid: false, errors: [{ field: "body", message: "요청 본문이 없습니다." }] };
  }
  const req = body as Record<string, unknown>;
  const errors: ValidationError[] = [];

  // Required fields.
  const topicErr = topic(req.topic);
  if (topicErr) errors.push(topicErr);

  // Injection check on topic.
  const injectErr = injectionCheck(req.topic);
  if (injectErr) errors.push(injectErr);

  // Optional enum fields.
  const langErr = enumField(req.language, "language", ALLOWED_LANGUAGES);
  if (langErr) errors.push(langErr);

  const lengthErr = enumField(req.length, "length", ALLOWED_LENGTHS);
  if (lengthErr) errors.push(lengthErr);

  const styleErr = enumField(req.style, "style", ALLOWED_STYLES);
  if (styleErr) errors.push(styleErr);

  // Image uploads.
  const imgErr = images(req.images);
  if (imgErr) errors.push(imgErr);

  return { valid: errors.length === 0, errors };
}

/**
 * Lightweight validation for AI-edit requests (smaller scope).
 */
export function validateAiEditRequest(body: unknown): ValidationOutput {
  if (!body || typeof body !== "object") {
    return { valid: false, errors: [{ field: "body", message: "요청 본문이 없습니다." }] };
  }
  const req = body as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (typeof req.instruction !== "string" || req.instruction.trim().length < 2) {
    errors.push({ field: "instruction", message: "수정指令을 2자 이상 입력해주세요." });
  }
  if (typeof req.instruction === "string" && req.instruction.length > 5000) {
    errors.push({ field: "instruction", message: "수정 지시는 최대 5000자까지 가능합니다." });
  }
  // Injection check on instruction.
  const injectErr = injectionCheck(req.instruction);
  if (injectErr) errors.push(injectErr);

  return { valid: errors.length === 0, errors };
}

/**
 * Check raw body size before JSON parsing. Returns true if the body is
 * within acceptable limits.
 */
export function isBodySizeOk(body: string): boolean {
  return body.length <= MAX_JSON_PAYLOAD_BYTES;
}
