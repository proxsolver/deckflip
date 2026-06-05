// Serverless entry point for 3D scene regeneration. Runs on the NODE runtime
// (not edge): it reuses the generation provider layer in _generate.ts, which
// transitively imports the node:fs storage seam. In dev, the same handler is
// mounted at /api/regenerate-scene by vite.config.ts.

import { handleRegenerateScene } from "./_generation/scene";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    const body = await request.json();
    const result = await handleRegenerateScene(body);
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
