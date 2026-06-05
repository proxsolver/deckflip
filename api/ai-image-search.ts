// Serverless entry point for web image SEARCH (find real photos for one or many
// selected objects and inline them). Mirrors api/ai-image.ts. In dev,
// vite.config.ts mounts handleAiImageSearch at the same path.

import { handleAiImageSearch } from "./_editing/image";

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    const body = await request.json();
    const result = await handleAiImageSearch(body);
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
