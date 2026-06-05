// The ONE definition of the content-block library — the menu the AI (and the
// Toolbar) insert from. Same philosophy as patch-keys.ts / animation-presets.ts:
// validator, schema, editor, and AI prompt all import from here.
//
// SAFETY CONTRACT: the AI NEVER authors markup. Each block's `html` is a vetted,
// self-contained template that ships with the app; the AI only chooses a
// `blockType` and fills TEXT `slots`. The editor parses the template once and
// fills [data-slot] nodes via the text-node discipline (setEditableText), so a
// slot value can never introduce a tag, class, or attribute.

export const BLOCK_TYPES = ["callout", "statCard", "bulletItem", "quote", "labelChip"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];
export const BLOCK_TYPE_SET: ReadonlySet<string> = new Set(BLOCK_TYPES);

export interface BlockSlot {
  name: string;
  label: string;
  maxLength: number;
  default: string;
}

export interface BlockTemplate {
  type: BlockType;
  label: string;
  /** Vetted markup. Text slots are marked with data-slot="<name>". */
  html: string;
  slots: BlockSlot[];
  /** Initial inline width (px). Height is left to content. */
  defaultSize: { w: number; h: number };
}

export const BLOCK_TEMPLATES: Record<BlockType, BlockTemplate> = {
  callout: {
    type: "callout",
    label: "Callout",
    html: '<div class="html-ppt-block html-ppt-block-callout"><span data-slot="text">Key insight goes here</span></div>',
    slots: [{ name: "text", label: "Text", maxLength: 400, default: "Key insight goes here" }],
    defaultSize: { w: 440, h: 96 },
  },
  statCard: {
    type: "statCard",
    label: "Stat card",
    html:
      '<div class="html-ppt-block html-ppt-block-statCard">' +
      '<div class="hpb-value" data-slot="value">128%</div>' +
      '<div class="hpb-label" data-slot="label">YoY growth</div>' +
      "</div>",
    slots: [
      { name: "value", label: "Value", maxLength: 24, default: "128%" },
      { name: "label", label: "Label", maxLength: 80, default: "YoY growth" },
    ],
    defaultSize: { w: 260, h: 150 },
  },
  bulletItem: {
    type: "bulletItem",
    label: "Bullet",
    html: '<div class="html-ppt-block html-ppt-block-bulletItem"><span data-slot="text">Bullet point</span></div>',
    slots: [{ name: "text", label: "Text", maxLength: 300, default: "Bullet point" }],
    defaultSize: { w: 440, h: 44 },
  },
  quote: {
    type: "quote",
    label: "Quote",
    html:
      '<blockquote class="html-ppt-block html-ppt-block-quote">' +
      '<span data-slot="text">A memorable quote.</span>' +
      '<cite class="hpb-cite" data-slot="cite">— Source</cite>' +
      "</blockquote>",
    slots: [
      { name: "text", label: "Quote", maxLength: 400, default: "A memorable quote." },
      { name: "cite", label: "Source", maxLength: 120, default: "— Source" },
    ],
    defaultSize: { w: 480, h: 130 },
  },
  labelChip: {
    type: "labelChip",
    label: "Label chip",
    html: '<div class="html-ppt-block html-ppt-block-labelChip"><span data-slot="text">LABEL</span></div>',
    slots: [{ name: "text", label: "Text", maxLength: 60, default: "LABEL" }],
    defaultSize: { w: 160, h: 40 },
  },
};

/** Slot names valid for a block type (used by the validator to drop unknowns). */
export function slotNamesFor(type: BlockType): Set<string> {
  return new Set(BLOCK_TEMPLATES[type].slots.map((s) => s.name));
}

// Base styling for inserted blocks. Injected into the DECK once (not the editor
// UI style) via the persisted-style seam <style id="html-ppt-blocks">, which
// cleanHtml() KEEPS — so exported decks stay self-contained. Deliberately
// neutral and self-contained (uses `inherit`/translucent fills) so a block
// looks at home on light or dark decks without depending on the deck's CSS.
export const BLOCK_BASE_CSS = `
.html-ppt-block { position: absolute; box-sizing: border-box; font-family: inherit; color: inherit; }
.html-ppt-block-callout {
  padding: 16px 20px; border-left: 4px solid #8a7544;
  background: rgba(138,117,68,0.08); border-radius: 8px;
  font-size: 18px; line-height: 1.5;
}
.html-ppt-block-statCard {
  padding: 20px 24px; border: 1px solid rgba(127,127,127,0.3);
  border-radius: 14px; background: rgba(127,127,127,0.05); text-align: center;
}
.html-ppt-block-statCard .hpb-value { font-size: 44px; font-weight: 800; line-height: 1.1; }
.html-ppt-block-statCard .hpb-label { font-size: 14px; opacity: 0.7; margin-top: 6px; letter-spacing: 0.04em; }
.html-ppt-block-bulletItem { display: flex; gap: 10px; align-items: baseline; font-size: 18px; line-height: 1.5; }
.html-ppt-block-bulletItem::before {
  content: ""; flex: 0 0 auto; width: 8px; height: 8px;
  margin-top: 8px; border-radius: 50%; background: #8a7544;
}
.html-ppt-block-quote {
  padding: 12px 22px; border-left: 3px solid rgba(127,127,127,0.5);
  font-style: italic; font-size: 20px; line-height: 1.5;
}
.html-ppt-block-quote .hpb-cite { display: block; margin-top: 8px; font-style: normal; font-size: 14px; opacity: 0.7; }
.html-ppt-block-labelChip {
  display: inline-block; padding: 6px 14px; border-radius: 999px;
  background: rgba(138,117,68,0.15); font-size: 13px; font-weight: 700;
  letter-spacing: 0.06em; text-transform: uppercase;
}
`.trim();
