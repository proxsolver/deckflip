// Serverless entry point for AI image generation (web-standard Request/Response).
// Mirrors api/ai-edit.ts. In dev, vite.config.ts mounts handleAiImage at the same
// path so it works with no separate backend.

import { handleAiImage } from "./_handler";

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    const body = await request.json();
    const result = await handleAiImage(body);
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
