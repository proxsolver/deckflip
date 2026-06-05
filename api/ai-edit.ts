// Serverless entry point (web-standard Request/Response — works on Vercel Edge,
// Cloudflare Workers, Netlify Edge). For Node-only function runtimes, wrap
// handleAiEdit() with that platform's req/res adapter instead.

import { handleAiEdit } from "./_editing/handler";

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    const body = await request.json();
    const result = await handleAiEdit(body);
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
