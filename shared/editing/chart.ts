// The vetted chart-type menu — the single source of truth for the AI, validator,
// JSON schema, and editor, mirroring animation-presets.ts / blocks.ts /
// scene-params.ts. It lets the AI/Inspector change a deck's Chart.js chart TYPE
// (bar → line → pie → …) WITHOUT ever emitting config or code: the AI picks a
// `chartType` from this fixed list, and the editor reads the LIVE Chart instance
// (via the deck's standard `window.Chart` global → Chart.getChart) and recreates
// it with the new type, preserving the chart's data + styling.
//
// Unlike scene params, this needs NO deck contract — any deck whose charts use
// the standard Chart.js global works. The trust model is unchanged: anything
// outside this menu is dropped by the validator.
//
// Note: a chart's type lives in deck JS, not in element innerHTML/inline style,
// so (like scene params) the change is OUTSIDE the innerHTML undo stack and is a
// live preview — it doesn't rewrite the deck's script.js.

// Types chosen to be data-compatible: all consume the standard
// { labels, datasets:[{ data:number[] }] } shape, so switching between them
// preserves the data. (scatter/bubble are intentionally excluded — they need
// {x,y} point data and would break a bar/line dataset.)
export const CHART_TYPES = [
  "bar",
  "line",
  "pie",
  "doughnut",
  "radar",
  "polarArea",
] as const;

export type ChartType = (typeof CHART_TYPES)[number];

export const CHART_TYPE_SET: ReadonlySet<string> = new Set(CHART_TYPES);
