// Serverless entry for candidate previews (3 single-slide style samples).
// NODE runtime (reuses the generation provider layer). In dev, mounted at
// /api/generate-candidates by vite.config.ts.

import { handleGenerateCandidates } from "./_generation/candidates";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    const body = await request.json();
    const result = await handleGenerateCandidates(body);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}
