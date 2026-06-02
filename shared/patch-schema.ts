// OpenAI structured-output schema for the patch. Mirrors PATCH_SCHEMA in the
// old ai/client.py. Built from the single PATCH_KEYS source so it can never
// drift from the validator or the editor.

import { PATCH_KEYS } from "./patch-keys";
import { ANIMATION_NONE, ANIMATION_PRESETS, ANIMATION_TIMING_FUNCTIONS } from "./animation-presets";
import { LAYOUT_VERBS, LAYOUT_AXES } from "./actions";
import { BLOCK_TYPES } from "./blocks";

type JsonSchema = Record<string, unknown>;

function nullable(types: string | string[]): JsonSchema {
  const list = Array.isArray(types) ? [...types] : [types];
  if (!list.includes("null")) list.push("null");
  return { type: list };
}

// A nullable string constrained to a fixed enum (plus null for "no change").
function nullableEnum(values: readonly string[]): JsonSchema {
  return { type: ["string", "null"], enum: [...values, null] };
}

const PROPERTY_TYPES: Record<string, JsonSchema> = {
  text: nullable("string"),
  x: nullable("number"),
  y: nullable("number"),
  w: nullable("number"),
  h: nullable("number"),
  fontSize: nullable("number"),
  color: nullable("string"),
  backgroundColor: nullable("string"),
  borderColor: nullable("string"),
  borderWidth: nullable(["string", "number"]),
  borderStyle: nullable("string"),
  borderRadius: nullable(["string", "number"]),
  fontWeight: nullable(["string", "number"]),
  lineHeight: nullable(["string", "number"]),
  letterSpacing: nullable(["string", "number"]),
  opacity: nullable("number"),
  zIndex: nullable("number"),
  filter: nullable("string"),
  // Image keys are delivered by the image-generation endpoint, not the text
  // model; included here so the unified Patch shape validates either way.
  src: nullable("string"),
  backgroundImage: nullable("string"),
  // Animation: the name is enum-constrained to the shipped presets (+ "none");
  // timing function is enum-constrained; durations/iteration are free strings
  // the validator re-checks (e.g. "0.6s", "2s", "infinite").
  animationName: nullableEnum([ANIMATION_NONE, ...ANIMATION_PRESETS]),
  animationDuration: nullable("string"),
  animationDelay: nullable("string"),
  animationTimingFunction: nullableEnum(ANIMATION_TIMING_FUNCTIONS),
  animationIterationCount: nullable(["string", "number"]),
};

export const PATCH_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    patch: {
      type: "object",
      additionalProperties: false,
      properties: PROPERTY_TYPES,
      // Strict structured-output works best when all fields are present; the
      // model sets unused fields to null.
      required: [...PATCH_KEYS],
    },
  },
  required: ["message", "patch"],
};

// The nested patch object, reused inside an "patch" action.
const PATCH_OBJECT_SCHEMA: JsonSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: PROPERTY_TYPES,
  required: [...PATCH_KEYS],
};

// One action, modeled as a FLAT object (type enum + every field nullable) rather
// than a discriminated anyOf — far more robust under OpenAI strict structured
// output. The validator interprets fields by `type` and ignores the rest.
const ACTION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["patch", "layout", "insertBlock"] },
    // patch action
    id: nullable("string"),
    patch: PATCH_OBJECT_SCHEMA,
    // layout action
    op: nullableEnum(LAYOUT_VERBS),
    axis: nullableEnum(LAYOUT_AXES),
    ids: { type: ["array", "null"], items: { type: "string" } },
    relativeTo: nullableEnum(["group", "slide"]),
    gap: nullable("number"),
    cols: nullable("number"),
    step: nullable("number"),
    // insertBlock action
    blockType: nullableEnum(BLOCK_TYPES),
    slots: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, value: { type: "string" } },
        required: ["name", "value"],
      },
    },
    target: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: { slideIndex: nullable("number"), x: nullable("number"), y: nullable("number") },
      required: ["slideIndex", "x", "y"],
    },
  },
  required: [
    "type",
    "id",
    "patch",
    "op",
    "axis",
    "ids",
    "relativeTo",
    "gap",
    "cols",
    "step",
    "blockType",
    "slots",
    "target",
  ],
};

// The unified envelope the model returns for the actions pipeline.
export const ACTION_ENVELOPE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    actions: { type: "array", items: ACTION_SCHEMA },
  },
  required: ["message", "actions"],
};

// Multi-object variant: the model returns one entry per selected object it wants
// to change, each carrying the object's `id`. Built from the same PROPERTY_TYPES
// so it can never drift from the single-patch schema or the validator.
export const PATCH_LIST_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    patches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, ...PROPERTY_TYPES },
        required: ["id", ...PATCH_KEYS],
      },
    },
  },
  required: ["message", "patches"],
};
