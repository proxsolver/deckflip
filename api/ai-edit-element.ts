// Serverless entry for scoped element regeneration (AI rebuilds one element's
// inner HTML). NODE runtime (reuses the generation provider layer). In dev,
// mounted at /api/ai-edit-element by vite.config.ts.

import { handleAiEditElement } from "./_editing/element";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    const body = await request.json();
    const result = await handleAiEditElement(body);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}
