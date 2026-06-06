// Color extraction from the current slide DOM + color-theory suggestion engine.
// Runs inside the deck iframe so it has direct access to getComputedStyle.
// core.ts calls extractSlideColors(slideElement) — no STATE import, no circular dep.

import type { ColorSuggestion, SlidePalette } from "../types/context";

// ── HSL math helpers (pure functions, no DOM) ──────────────────────────────

interface Hsla {
  h: number; // 0–360
  s: number; // 0–100
  l: number; // 0–100
  a: number; // 0–1
}

const RGB_RE = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/;
const HEX6_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX3_RE = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;

function parseCssColor(raw: string): Hsla | null {
  const v = raw.trim();
  if (!v || v === "transparent" || v === "inherit" || v === "initial" || v === "currentcolor") return null;

  // rgb(...) / rgba(...)
  const m = v.match(RGB_RE);
  if (m) {
    const r = parseFloat(m[1]) / 255;
    const g = parseFloat(m[2]) / 255;
    const b = parseFloat(m[3]) / 255;
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    if (a < 0.05) return null;
    return rgbToHsl(r, g, b, a);
  }

  // #rrggbb
  const h6 = v.match(HEX6_RE);
  if (h6) return rgbToHsl(parseInt(h6[1], 16) / 255, parseInt(h6[2], 16) / 255, parseInt(h6[3], 16) / 255, 1);

  // #rgb
  const h3 = v.match(HEX3_RE);
  if (h3)
    return rgbToHsl(
      parseInt(h3[1], 16) / 15,
      parseInt(h3[2], 16) / 15,
      parseInt(h3[3], 16) / 15,
      1,
    );

  return null;
}

function rgbToHsl(r: number, g: number, b: number, a: number): Hsla {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100), a };
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const a2 = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = ln - a2 * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * Math.max(0, Math.min(1, color)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Slide DOM walking ──────────────────────────────────────────────────────

interface ColorEntry {
  hsl: Hsla;
  count: number;
}

/**
 * Extract a color palette from the given slide element.
 * Called from editorApi.getSlidePalette() in core.ts.
 */
export function extractSlideColors(slide: HTMLElement): SlidePalette {
  const colorMap = new Map<string, ColorEntry>();

  // Collect slide's own background
  collectColor(slide, "backgroundColor", colorMap);

  // Walk all descendant elements
  const els = slide.querySelectorAll("*");
  for (const el of els) {
    // Skip hidden elements
    const cs = window.getComputedStyle(el as HTMLElement);
    if (cs.display === "none" || cs.visibility === "hidden") continue;

    // Skip editor artifacts
    if ((el as HTMLElement).dataset.htmlPptEditor) continue;

    collectComputedStyleColors(cs, colorMap);
  }

  // Separate neutral (low saturation) from colored
  const neutral: ColorEntry[] = [];
  const colored: ColorEntry[] = [];
  for (const entry of colorMap.values()) {
    if (entry.hsl.s < 12) {
      neutral.push(entry);
    } else {
      colored.push(entry);
    }
  }

  // Cluster colored entries by hue (30° buckets = 12 buckets)
  const hueBuckets = new Map<number, ColorEntry>();
  for (const entry of colored) {
    const bucket = Math.floor(entry.hsl.h / 30);
    const existing = hueBuckets.get(bucket);
    if (!existing || entry.count * entry.hsl.s > existing.count * existing.hsl.s) {
      hueBuckets.set(bucket, entry);
    } else {
      existing.count += entry.count;
    }
  }

  // Sort by (count × saturation) descending
  const sortedBuckets = Array.from(hueBuckets.values()).sort(
    (a, b) => b.count * b.hsl.s - a.count * a.hsl.s,
  );

  // Dominant colors (top 2)
  const dominant: ColorSuggestion[] = sortedBuckets.slice(0, 2).map((e, i) => ({
    hex: hslToHex(e.hsl.h, e.hsl.s, e.hsl.l).toUpperCase(),
    label: i === 0 ? "Main" : "Sub",
  }));

  // Generate 5 suggestions from the primary dominant
  const primary = sortedBuckets[0]?.hsl;
  const suggestions =
    primary && primary.s >= 12
      ? generateSuggestions(primary)
      : fallbackSuggestions(neutral);

  const rawColors = sortedBuckets.map((e) => hslToHex(e.hsl.h, e.hsl.s, e.hsl.l).toUpperCase());

  return { dominant, suggestions, rawColors };
}

// ── Color collection ───────────────────────────────────────────────────────

function collectComputedStyleColors(cs: CSSStyleDeclaration, map: Map<string, ColorEntry>) {
  const props = [cs.color, cs.backgroundColor, cs.borderTopColor];
  for (const raw of props) {
    if (!raw) continue;
    const hsl = parseCssColor(raw);
    if (!hsl) continue;
    // Quantize to reduce near-duplicates: round H to 5°, S/L to 5%
    const key = `${Math.round(hsl.h / 5) * 5}-${Math.round(hsl.s / 5) * 5}-${Math.round(hsl.l / 5) * 5}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
    } else {
      map.set(key, { hsl, count: 1 });
    }
  }
}

function collectColor(el: HTMLElement, prop: string, map: Map<string, ColorEntry>) {
  const cs = window.getComputedStyle(el);
  const raw = cs.getPropertyValue(prop);
  if (!raw) return;
  const hsl = parseCssColor(raw);
  if (!hsl) return;
  const key = `${Math.round(hsl.h / 5) * 5}-${Math.round(hsl.s / 5) * 5}-${Math.round(hsl.l / 5) * 5}`;
  const existing = map.get(key);
  if (existing) {
    existing.count++;
  } else {
    map.set(key, { hsl, count: 1 });
  }
}

// ── Suggestion generation ──────────────────────────────────────────────────

function generateSuggestions(d: Hsla): ColorSuggestion[] {
  const results: ColorSuggestion[] = [];

  // 1. Accent — the dominant color itself
  results.push({
    hex: hslToHex(d.h, d.s, d.l).toUpperCase(),
    label: "Accent",
  });

  // 2. Complement — opposite on the color wheel
  const compH = (d.h + 180) % 360;
  results.push({
    hex: hslToHex(compH, clamp(d.s, 30, 90), clamp(d.l, 30, 70)).toUpperCase(),
    label: "Complement",
  });

  // 3. Soft — same hue, reduced saturation, mid lightness
  const softS = Math.max(d.s * 0.4, 15);
  const softL = clamp(d.l < 50 ? 65 : 55, 40, 80);
  results.push({
    hex: hslToHex(d.h, softS, softL).toUpperCase(),
    label: "Soft",
  });

  // 4. Dark — same hue, lower saturation, darker
  const darkS = d.s * 0.6;
  const darkL = clamp(d.l * 0.35, 12, 30);
  results.push({
    hex: hslToHex(d.h, darkS, darkL).toUpperCase(),
    label: "Dark",
  });

  // 5. Light — same hue, low saturation, light/pastel
  const lightS = d.s * 0.3;
  const lightL = clamp(d.l + 30, 75, 92);
  results.push({
    hex: hslToHex(d.h, lightS, lightL).toUpperCase(),
    label: "Light",
  });

  return results;
}

function fallbackSuggestions(neutrals: ColorEntry[]): ColorSuggestion[] {
  // Grayscale-only slide: offer neutrals + a tasteful accent
  const sorted = neutrals.sort((a, b) => b.count - a.count);
  const darkest = sorted.find((e) => e.hsl.l < 40);
  const lightest = sorted.find((e) => e.hsl.l > 60);

  return [
    { hex: "#6366F1", label: "Accent" }, // Indigo accent
    { hex: "#F59E0B", label: "Complement" }, // Warm amber
    { hex: "#94A3B8", label: "Soft" }, // Slate
    { hex: darkest ? hslToHex(darkest.hsl.h, darkest.hsl.s, darkest.hsl.l).toUpperCase() : "#1E293B", label: "Dark" },
    { hex: lightest ? hslToHex(lightest.hsl.h, lightest.hsl.s, lightest.hsl.l).toUpperCase() : "#F1F5F9", label: "Light" },
  ];
}
