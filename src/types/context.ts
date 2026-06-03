// Shapes emitted by the editor (port of payload() and selectedContext() in the
// old editor_bridge.js). When nothing is selected, payload() returns {} so all
// fields are optional and `id` is the presence signal.

export interface SelectionPayload {
  id?: string;
  tag?: string;
  className?: string;
  slideIndex?: number;
  totalSlides?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  fontSize?: number;
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  position?: string;
  text?: string;
  textSafe?: boolean;
  /** Friendly name of the applied animation preset, or "none". */
  animationName?: string;
  childElementCount?: number;
  zIndex?: number;
  positioned?: boolean;
  /** Durable marker on the primary (present once the object has been chatted about). */
  stableId?: string;
  /** Multi-selection info (the primary's fields above describe selectionIds[last]). */
  selectionCount?: number;
  selectionIds?: string[];
  /** Durable markers per selected element (null until first chatted about). */
  selectionStableIds?: (string | null)[];
}

/** A global background / decoration layer offered by the background picker. */
export interface BackgroundLayer {
  id: string;
  /** Human-friendly name shown in the picker (e.g. "Glow / colored light"). */
  label: string;
  /** One-line hint: what it is + what's editable. Shown dimmed under the label. */
  hint?: string;
  /** The raw `tag#id.class` selector, for users who want the technical handle. */
  selector?: string;
  w: number;
  h: number;
}

export interface TextNodeInfo {
  index: number;
  text: string;
  parentTag: string;
  parentClass: string;
}

export interface SelectedContext extends SelectionPayload {
  innerText: string;
  outerHTML: string;
  inlineStyle: string;
  parentTag: string;
  parentClass: string;
  slideClass: string;
  slideDataset: Record<string, string>;
  textNodes: TextNodeInfo[];
  computedStyle: Record<string, string>;
}

export interface SlideInfo {
  current: number;
  total: number;
}
