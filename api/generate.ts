// Serverless entry point for deck generation. NOTE: this handler writes to the
// local-dir backend via node:fs (api/storage.ts), so it needs a Node function
// runtime — NOT the edge runtime used by api/ai-edit.ts. When a real storage
// backend replaces api/storage.ts, revisit the runtime choice. In dev, the same
// handler is mounted at /api/generate by vite.config.ts.

import { handleGenerate } from "./_generation/generate";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    const body = await request.json();
    const result = await handleGenerate(body);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}
