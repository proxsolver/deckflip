// Web replacement for services/project_io.py. Decks are loaded through the
// File System Access API (or an <input webkitdirectory> fallback), turned into
// a blob-URL asset map, and the entry HTML is rewritten so it renders inside a
// same-origin srcdoc iframe.

import type { DeckFiles } from "@shared/generation";

export interface LoadedDeck {
  /** Entry HTML rewritten so asset refs point at blob URLs. Feeds iframe srcdoc. */
  html: string;
  /** Original entry file name, e.g. "index.html". */
  entryName: string;
  /** Raw files keyed by normalized relative path. */
  files: Map<string, File>;
  /** Present only when opened via the File System Access API (enables save-in-place). */
  dirHandle?: FileSystemDirectoryHandle;
  /** Blob URLs created for assets; revoke when the deck is replaced. */
  objectUrls: string[];
  /** Reverse of the asset map: blob URL -> original relative path. Lets exporters
   *  resolve the live DOM's blob refs back to the original files. */
  pathForUrl: Map<string, string>;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+/, "");
}

function findEntry(files: Map<string, File>): string | null {
  if (files.has("index.html")) return "index.html";
  const htmls = [...files.keys()].filter((p) => /\.html?$/i.test(p)).sort();
  return htmls[0] ?? null;
}

async function readDirectory(
  handle: FileSystemDirectoryHandle,
  prefix: string,
  out: Map<string, File>
): Promise<void> {
  for await (const [name, entry] of handle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === "file") {
      out.set(normalizePath(path), await (entry as FileSystemFileHandle).getFile());
    } else {
      await readDirectory(entry as FileSystemDirectoryHandle, path, out);
    }
  }
}

// Rewrites href/src attributes that point at bundled assets to their blob URLs.
// Known limitation: url(...) refs inside CSS files are not rewritten yet.
function rewriteAssetRefs(html: string, entryName: string, urlForPath: Map<string, string>): string {
  const baseDir = entryName.includes("/") ? entryName.slice(0, entryName.lastIndexOf("/") + 1) : "";
  const doc = new DOMParser().parseFromString(html, "text/html");

  const resolve = (value: string): string | null => {
    if (!value || /^(https?:|data:|blob:|#|mailto:|\/\/)/i.test(value)) return null;
    const candidate = normalizePath(baseDir + value);
    return urlForPath.get(candidate) ?? urlForPath.get(normalizePath(value)) ?? null;
  };

  doc.querySelectorAll<HTMLElement>("[src]").forEach((el) => {
    const v = el.getAttribute("src")!;
    const url = resolve(v);
    if (url) el.setAttribute("src", url);
  });
  doc.querySelectorAll<HTMLElement>("link[href]").forEach((el) => {
    const v = el.getAttribute("href")!;
    const url = resolve(v);
    if (url) el.setAttribute("href", url);
  });

  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}

export async function openDeckViaPicker(): Promise<LoadedDeck> {
  if (!window.showDirectoryPicker) {
    throw new Error("This browser does not support the directory picker. Use the folder <input> fallback.");
  }
  const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  const files = new Map<string, File>();
  await readDirectory(dirHandle, "", files);
  return buildDeckAsync(files, dirHandle);
}

export async function openDeckFromFileList(fileList: FileList): Promise<LoadedDeck> {
  const files = new Map<string, File>();
  for (const file of Array.from(fileList)) {
    // webkitRelativePath is "<rootDir>/<...>"; drop the leading root segment.
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const stripped = rel.includes("/") ? rel.slice(rel.indexOf("/") + 1) : rel;
    files.set(normalizePath(stripped), file);
  }
  return buildDeckAsync(files);
}

// Async variant of buildDeck that reads the entry text first.
async function buildDeckAsync(files: Map<string, File>, dirHandle?: FileSystemDirectoryHandle): Promise<LoadedDeck> {
  const entryName = findEntry(files);
  if (!entryName) throw new Error("No index.html or .html file found in the selected folder.");

  const objectUrls: string[] = [];
  const urlForPath = new Map<string, string>();
  const pathForUrl = new Map<string, string>();
  for (const [path, file] of files) {
    if (path === entryName) continue;
    const url = URL.createObjectURL(file);
    objectUrls.push(url);
    urlForPath.set(path, url);
    pathForUrl.set(url, path);
  }
  const rawHtml = await files.get(entryName)!.text();
  const html = rewriteAssetRefs(rawHtml, entryName, urlForPath);
  return { html, entryName, files, dirHandle, objectUrls, pathForUrl };
}

export function releaseDeck(deck: LoadedDeck | null): void {
  deck?.objectUrls.forEach((u) => URL.revokeObjectURL(u));
}

// --- AI-generated decks ----------------------------------------------------

// Build a LoadedDeck from in-memory file CONTENTS (the AI generator returns the
// 4 files as strings). Reuses the same blob-URL + rewrite path as a disk-loaded
// deck, so it renders and edits identically. No dirHandle → Save HTML falls back
// to download, which matches "files live in the backend; download raw on demand".
export function buildDeckFromContents(files: DeckFiles): LoadedDeck {
  const entries: Array<[string, string, string]> = [
    ["style.css", files.styleCss, "text/css"],
    ["script.js", files.scriptJs, "text/javascript"],
  ];
  if (files.threeSceneJs) entries.push(["three_scene.js", files.threeSceneJs, "text/javascript"]);

  const fileMap = new Map<string, File>();
  fileMap.set("index.html", new File([files.indexHtml], "index.html", { type: "text/html" }));

  const objectUrls: string[] = [];
  const urlForPath = new Map<string, string>();
  const pathForUrl = new Map<string, string>();
  for (const [path, content, type] of entries) {
    const file = new File([content], path, { type });
    fileMap.set(path, file);
    const url = URL.createObjectURL(file);
    objectUrls.push(url);
    urlForPath.set(path, url);
    pathForUrl.set(url, path);
  }

  // Image assets (extracted/uploaded) → blob URLs keyed by their deck path, so the
  // generated HTML's <img src="assets/..."> refs resolve in the srcdoc iframe.
  for (const asset of files.assets ?? []) {
    const file = dataUrlToFile(asset.dataUrl, asset.path.split("/").pop() || "image");
    if (!file) continue;
    const path = normalizePath(asset.path);
    fileMap.set(path, file);
    const url = URL.createObjectURL(file);
    objectUrls.push(url);
    urlForPath.set(path, url);
    pathForUrl.set(url, path);
  }

  const html = rewriteAssetRefs(files.indexHtml, "index.html", urlForPath);
  return { html, entryName: "index.html", files: fileMap, objectUrls, pathForUrl };
}

// data: URL → File (for in-memory deck assets). Null on malformed input.
function dataUrlToFile(dataUrl: string, name: string): File | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl || "");
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  try {
    let bytes: Uint8Array;
    if (m[2]) {
      const bin = atob(m[3]);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
    }
    return new File([bytes as unknown as BlobPart], name, { type: mime });
  } catch {
    return null;
  }
}

// Swap ONE asset file's contents in a live deck (e.g. three_scene.js after a 3D
// regeneration), preserving every other asset. Creates a fresh blob URL for the
// new content, points the deck's rewritten HTML at it (string-swap of the old
// blob URL), and revokes the old one. Returns a new LoadedDeck; reloading the
// iframe with its `html` re-runs the swapped file. The deck must already
// reference `relPath` as an asset (it had this file before).
export function replaceDeckAsset(
  deck: LoadedDeck,
  relPath: string,
  content: string,
  type = "text/javascript"
): LoadedDeck {
  const path = normalizePath(relPath);
  const oldUrl = [...deck.pathForUrl.entries()].find(([, p]) => p === path)?.[0];

  const file = new File([content], path.split("/").pop() || path, { type });
  const newUrl = URL.createObjectURL(file);

  const files = new Map(deck.files);
  files.set(path, file);
  const pathForUrl = new Map(deck.pathForUrl);
  let objectUrls = deck.objectUrls.slice();
  let html = deck.html;

  if (oldUrl) {
    URL.revokeObjectURL(oldUrl);
    pathForUrl.delete(oldUrl);
    objectUrls = objectUrls.filter((u) => u !== oldUrl);
    html = html.split(oldUrl).join(newUrl);
  }
  pathForUrl.set(newUrl, path);
  objectUrls.push(newUrl);

  return { ...deck, files, pathForUrl, objectUrls, html };
}

// Trigger a download for each raw file (sequential so the browser doesn't drop
// the later ones). Lets a user pull the generated source even though it normally
// lives only in the backend.
export function downloadDeckFiles(files: DeckFiles): void {
  const out: Array<[string, string]> = [
    ["index.html", files.indexHtml],
    ["style.css", files.styleCss],
    ["script.js", files.scriptJs],
  ];
  if (files.threeSceneJs) out.push(["three_scene.js", files.threeSceneJs]);
  out.forEach(([name, content], i) => {
    setTimeout(() => downloadHtml(content, name), i * 250);
  });
}

// --- Save / export -------------------------------------------------------

export async function saveHtmlInPlace(deck: LoadedDeck, html: string): Promise<void> {
  if (!deck.dirHandle) throw new Error("Save in place needs a folder opened via the directory picker.");
  await writeFileToDir(deck.dirHandle, deck.entryName, html);
}

export function downloadHtml(html: string, filename = "edited_index.html"): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const IGNORED_EXPORT_DIRS = new Set(["__pycache__", ".git", ".venv", "venv", "node_modules"]);

export async function exportProjectToDirectory(deck: LoadedDeck, editedHtml: string): Promise<void> {
  if (!window.showDirectoryPicker) throw new Error("This browser does not support the directory picker.");
  const outDir = await window.showDirectoryPicker({ mode: "readwrite" });
  for (const [path, file] of deck.files) {
    if (path.split("/").some((seg) => IGNORED_EXPORT_DIRS.has(seg))) continue;
    const data = path === deck.entryName ? editedHtml : await file.arrayBuffer();
    await writeFileToDir(outDir, path, data);
  }
}

// --- Standalone (single self-contained file) export ----------------------

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

// Resolve `url(...)` refs inside a stylesheet to data URIs, relative to the CSS
// file's own directory. This is the piece the live preview never handled.
async function inlineCssUrls(cssText: string, cssPath: string, files: Map<string, File>): Promise<string> {
  const baseDir = cssPath.includes("/") ? cssPath.slice(0, cssPath.lastIndexOf("/") + 1) : "";
  const replacements = new Map<string, string>();
  const refs = new Set<string>();
  for (const m of cssText.matchAll(CSS_URL_RE)) {
    const ref = m[2].trim();
    if (ref && !/^(https?:|data:|blob:|#|\/\/)/i.test(ref)) refs.add(ref);
  }
  for (const ref of refs) {
    const clean = ref.split(/[?#]/)[0];
    const file = files.get(normalizePath(baseDir + clean)) ?? files.get(normalizePath(clean));
    if (file) replacements.set(ref, await fileToDataUrl(file));
  }
  return cssText.replace(CSS_URL_RE, (whole, _q, ref) => {
    const dataUrl = replacements.get((ref as string).trim());
    return dataUrl ? `url(${dataUrl})` : whole;
  });
}

// Builds ONE self-contained .html: stylesheets inlined as <style> (with their
// url(...) assets data-URI'd), scripts inlined as <script>, and remaining
// src/href asset refs turned into data URIs. The live DOM references assets by
// blob URL, so we map those back to the original files via deck.pathForUrl,
// with a relative-path fallback for anything not rewritten at load time.
// External (http/CDN) refs are left untouched.
export async function exportStandaloneHtml(deck: LoadedDeck, editedHtml: string): Promise<void> {
  const doc = new DOMParser().parseFromString(editedHtml, "text/html");

  const pathFor = (ref: string): string | null => {
    if (!ref || /^(https?:|data:|#|\/\/)/i.test(ref)) return null;
    const direct = deck.pathForUrl.get(ref);
    if (direct) return direct;
    const clean = normalizePath(ref.split(/[?#]/)[0]);
    return deck.files.has(clean) ? clean : null;
  };
  const fileFor = (ref: string): File | null => {
    const path = pathFor(ref);
    return path ? deck.files.get(path) ?? null : null;
  };

  for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))) {
    const path = pathFor(link.getAttribute("href")!);
    const file = path ? deck.files.get(path) : null;
    if (!path || !file) continue;
    const css = await inlineCssUrls(await file.text(), path, deck.files);
    const style = doc.createElement("style");
    style.textContent = css;
    link.replaceWith(style);
  }

  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>("script[src]"))) {
    const file = fileFor(script.getAttribute("src")!);
    if (!file) continue; // external/CDN script: leave the network ref intact
    const inline = doc.createElement("script");
    const type = script.getAttribute("type");
    if (type) inline.setAttribute("type", type);
    // Neutralize any literal </script> so the inlined block can't terminate early.
    inline.textContent = (await file.text()).replace(/<\/(script)>/gi, "<\\/$1>");
    script.replaceWith(inline);
  }

  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[src]"))) {
    const file = fileFor(el.getAttribute("src")!);
    if (file) el.setAttribute("src", await fileToDataUrl(file));
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLLinkElement>("link[href]"))) {
    const file = fileFor(el.getAttribute("href")!);
    if (file) el.setAttribute("href", await fileToDataUrl(file));
  }

  const html = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  const base = (deck.entryName.split("/").pop() || "deck").replace(/\.html?$/i, "");
  downloadHtml(html, `${base}.standalone.html`);
}

async function writeFileToDir(
  root: FileSystemDirectoryHandle,
  relPath: string,
  data: string | ArrayBuffer
): Promise<void> {
  const parts = relPath.split("/");
  const fileName = parts.pop()!;
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(typeof data === "string" ? data : new Blob([data]));
  await writable.close();
}
