// Serverless entry for upload parsing (pdf/docx/txt/image → text + images).
// NODE runtime: uses pdfjs-dist / mammoth and node:zlib. In dev, the same handler
// is mounted at /api/parse-upload by vite.config.ts.

import { handleParseUpload } from "./_generation/parse";

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    const body = await request.json();
    const result = await handleParseUpload(body);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}
