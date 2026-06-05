// Serverless entry for durable per-deck prompt history (append modification
// prompts / list all). NODE runtime (uses the local-dir storage seam). In dev,
// mounted at /api/deck-prompts by vite.config.ts.

import { handleDeckPrompts } from "./_generation/prompt-log";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    const body = await request.json();
    const result = await handleDeckPrompts(body);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}
