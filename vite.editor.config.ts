import { defineConfig } from "vite";
import { resolve } from "node:path";

// Builds the editor as a single self-contained IIFE bundle that gets injected
// into the deck <iframe> at runtime (the web analogue of inject_editor_js in
// the old PyQt main_window.py). Everything it needs, including shared/*, is
// bundled in — it must not rely on any app-side runtime import.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "shared"),
      "@": resolve(__dirname, "src"),
    },
  },
  // The bundle is written into public/ so Vite serves it at /editor-bundle.js
  // in dev and copies it into dist/ during the app build. Disable publicDir for
  // this build so outDir and publicDir aren't the same folder.
  publicDir: false,
  build: {
    outDir: "public",
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/editor/index.ts"),
      formats: ["iife"],
      name: "__htmlPptEditorBundle",
      fileName: () => "editor-bundle.js",
    },
    rollupOptions: {
      output: { entryFileNames: "editor-bundle.js" },
    },
  },
});
