// Serverless entry point for single-slide generation (Phase 3 slide management).
// Runs on the NODE runtime (not edge): it reuses the generation provider layer,
// which transitively imports the node:fs storage seam. In dev, the same handler is
// mounted at /api/generate-slide by vite.config.ts.

import { handleGenerateSlide } from "./_generation/slide";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    const body = await request.json();
    const result = await handleGenerateSlide(body);
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
