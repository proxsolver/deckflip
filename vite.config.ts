import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAiEdit, handleAiImage } from "./api/_handler";

// Dev-only middleware so `npm run dev` serves the AI endpoints without a separate
// serverless host. In production the same logic ships as api/ai-edit.ts and
// api/ai-image.ts.
function jsonPost(
  server: ViteDevServer,
  path: string,
  handler: (payload: unknown) => Promise<unknown>
): void {
  server.middlewares.use(path, (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const result = await handler(JSON.parse(body || "{}"));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
      }
    });
  });
}

function aiDevApi(): Plugin {
  return {
    name: "ai-dev-api",
    configureServer(server: ViteDevServer) {
      jsonPost(server, "/api/ai-edit", (p) => handleAiEdit(p as Parameters<typeof handleAiEdit>[0]));
      jsonPost(server, "/api/ai-image", (p) => handleAiImage(p as Parameters<typeof handleAiImage>[0]));
    },
  };
}

export default defineConfig({
  plugins: [react(), aiDevApi()],
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "shared"),
      "@": resolve(__dirname, "src"),
    },
  },
});
