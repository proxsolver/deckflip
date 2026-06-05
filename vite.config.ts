import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAiEdit } from "./api/_editing/handler";
import { handleAiEditElement } from "./api/_editing/element";
import { handleAiImage, handleAiImageSearch } from "./api/_editing/image";
import { handleGenerate } from "./api/_generation/generate";
import { handleRegenerateScene } from "./api/_generation/scene";
import { handleParseUpload } from "./api/_generation/parse";
import { handleGenerateCandidates } from "./api/_generation/candidates";
import { handlePersonaInterview } from "./api/_generation/persona";
import { handleDeckPrompts } from "./api/_generation/prompt-log";

// Dev-only middleware so `npm run dev` serves the AI endpoints without a separate
// serverless host. In production the same logic ships as api/ai-edit.ts and
// api/ai-image.ts.

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

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
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        res.statusCode = 413;
        res.end("Payload Too Large");
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", async () => {
      if (res.writableEnded) return;
      try {
        const result = await handler(JSON.parse(body || "{}"));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Bad Request" }));
      }
    });
  });
}

function aiDevApi(): Plugin {
  return {
    name: "ai-dev-api",
    configureServer(server: ViteDevServer) {
      jsonPost(server, "/api/ai-edit", (p) => handleAiEdit(p as Parameters<typeof handleAiEdit>[0]));
      jsonPost(server, "/api/ai-edit-element", (p) => handleAiEditElement(p as Parameters<typeof handleAiEditElement>[0]));
      jsonPost(server, "/api/ai-image", (p) => handleAiImage(p as Parameters<typeof handleAiImage>[0]));
      jsonPost(server, "/api/ai-image-search", (p) => handleAiImageSearch(p as Parameters<typeof handleAiImageSearch>[0]));
      // Deck generation runs in Node here, so it can write generated/<id>/ via
      // the local-dir backend (api/storage.ts). Editing api/_generate.ts needs a
      // dev-server restart (the handler is imported at startup, like the others).
      jsonPost(server, "/api/generate", (p) => handleGenerate(p as Parameters<typeof handleGenerate>[0]));
      jsonPost(server, "/api/regenerate-scene", (p) => handleRegenerateScene(p as Parameters<typeof handleRegenerateScene>[0]));
      jsonPost(server, "/api/parse-upload", (p) => handleParseUpload(p as Parameters<typeof handleParseUpload>[0]));
      jsonPost(server, "/api/generate-candidates", (p) => handleGenerateCandidates(p as Parameters<typeof handleGenerateCandidates>[0]));
      jsonPost(server, "/api/persona-interview", (p) => handlePersonaInterview(p as Parameters<typeof handlePersonaInterview>[0]));
      jsonPost(server, "/api/deck-prompts", (p) => handleDeckPrompts(p as Parameters<typeof handleDeckPrompts>[0]));
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load .env / .env.local into process.env so the Node dev-API middleware can
  // read server-only secrets (ANTHROPIC_API_KEY, etc.). Vite normally exposes
  // only VITE_-prefixed vars, and to the CLIENT — not to process.env on the
  // server. The "" prefix loads every key; we never override a var already set
  // in the shell, so an exported value still wins over the file.
  const fileEnv = loadEnv(mode, process.cwd(), "");
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return {
    plugins: [react(), aiDevApi()],
    server: {
      allowedHosts: ["deckflip.net", ".deckflip.net", "localhost", "127.0.0.1"],
    },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "shared"),
        "@": resolve(__dirname, "src"),
      },
    },
  };
});
