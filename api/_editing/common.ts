// Shared infrastructure for the editing endpoints (text edit + image). Kept in
// one small module so ./handler and ./image don't import each other.

export function env(name: string): string | undefined {
  // Works under Node (Vercel/Netlify functions) and most edge runtimes.
  return (typeof process !== "undefined" && process.env ? process.env[name] : undefined)?.trim() || undefined;
}

export type ContextLike = Record<string, unknown> & {
  id?: string;
  text?: string;
  fontSize?: number;
  w?: number;
};

// Tolerant to the various Responses API shapes (port of _extract_response_text).
export function extractResponseText(response: Record<string, unknown>): string {
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
