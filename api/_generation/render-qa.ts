// Render-and-measure QA — the cheap half of a visual feedback loop.
//
// Renders the assembled deck in a headless Chromium, reveals every slide, and
// MEASURES layout failures the text-only deckLint() can't see — slides whose
// content overflows the 100vh frame (vertically or horizontally). The findings
// are returned as human-readable strings that generate.ts folds into the issue
// list it already feeds to the emit_qa_fixes pass. So this adds NO model tokens
// of its own: render + measurement run entirely in the browser; only the existing
// repair call (which already runs) consumes tokens, now with better findings.
//
// Playwright is a SOFT, optional dependency. If it (or its browser binary) isn't
// available, this returns [] and the pipeline degrades to text-only lint QA — it
// never throws, matching the pipeline's never-hard-fail contract.
//
// Activate it by installing the browser backend:
//   npm i -D playwright && npx playwright install chromium
// Toggle/tune via env:
//   HTML_PPT_RENDER_QA           = 0|off  → disable (default on, but no-ops without playwright)
//   HTML_PPT_RENDER_QA_TIMEOUT_MS = nav/launch timeout (default 20000)
//   HTML_PPT_RENDER_QA_SETTLE_MS  = post-reveal settle for fonts/charts (default 1200)
//   HTML_PPT_RENDER_QA_OVERFLOW_PX = overflow threshold in px (default 8)
//
// NOTE (prod): like the deferred Playwright visual-QA in the docs, this needs a
// real browser at runtime. It works in the Node dev server out of the box once
// playwright is installed; a serverless deploy needs a chromium-capable backend
// (e.g. @sparticuz/chromium) — otherwise it simply no-ops there.

import { env } from "./providers";
import type { DeckFiles } from "../../shared/generation";

const OFF_RE = /^(0|false|off|no)$/i;

export async function measureDeck(files: DeckFiles, log?: Record<string, unknown>): Promise<string[]> {
  if (OFF_RE.test(env("HTML_PPT_RENDER_QA") || "")) {
    if (log) log.renderQa = "disabled";
    return [];
  }
  const indexHtml = files?.indexHtml || "";
  if (!indexHtml.includes("<section")) return [];

  // Lazy, soft dependency — never make playwright a hard requirement of the build.
  // Variable specifier (not a string literal) keeps tsc/Vite from resolving it at
  // build time, so the project compiles and runs without playwright present.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chromium: any;
  for (const mod of ["playwright", "playwright-core"]) {
    try {
      const pw = await import(/* @vite-ignore */ mod);
      chromium = pw?.chromium ?? pw?.default?.chromium;
      if (chromium) break;
    } catch {
      /* try the next module name */
    }
  }
  if (!chromium) {
    if (log) log.renderQa = "playwright not installed (skipped)";
    return [];
  }

  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const overflowPx = Number(env("HTML_PPT_RENDER_QA_OVERFLOW_PX") || "8");
  const navTimeout = Number(env("HTML_PPT_RENDER_QA_TIMEOUT_MS") || "20000");
  const settleMs = Number(env("HTML_PPT_RENDER_QA_SETTLE_MS") || "1200");

  let dir = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "deckqa-"));
    await fs.writeFile(path.join(dir, "index.html"), indexHtml, "utf8");
    await fs.writeFile(path.join(dir, "style.css"), files.styleCss || "", "utf8");
    await fs.writeFile(path.join(dir, "script.js"), files.scriptJs || "", "utf8");
    if (files.threeSceneJs) await fs.writeFile(path.join(dir, "three_scene.js"), files.threeSceneJs, "utf8");
    for (const a of files.assets ?? []) {
      const m = a?.dataUrl ? /^data:[^;]+;base64,(.*)$/.exec(a.dataUrl) : null;
      if (!a?.path || !m) continue;
      const p = path.join(dir, a.path);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, Buffer.from(m[1], "base64"));
    }

    browser = (await chromium!.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] })) as typeof browser;
    const page = await browser!.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.goto("file://" + path.join(dir, "index.html").replace(/\\/g, "/"), { waitUntil: "load", timeout: navTimeout });

    // Reveal every slide (bypass the IntersectionObserver) and run the deck's
    // headless init (chart dispatch) so layout reaches its final, measurable state.
    await page.evaluate(() => {
      document.querySelectorAll(".slide").forEach((s) => s.classList.add("in-view"));
      const fn = (window as unknown as { initAll?: () => void }).initAll;
      if (typeof fn === "function") { try { fn(); } catch { /* ignore */ } }
    });
    await page.waitForTimeout(settleMs);

    const findings: string[] = await page.evaluate((threshold: number) => {
      const out: string[] = [];
      const slides = Array.from(document.querySelectorAll<HTMLElement>(".slide"));
      const labelOf = (s: Element, i: number) => {
        const t = (s.querySelector(
          ".slide-title,.divider-title,.cover-title,.contents-title,.mega-num,.cl-t,.section-title,h1,h2"
        ) as HTMLElement | null)?.innerText;
        const clean = t ? t.replace(/\s+/g, " ").trim().slice(0, 56) : "";
        return `slide ${i + 1}${clean ? ` ("${clean}")` : ""}`;
      };
      slides.forEach((el, i) => {
        const vOver = el.scrollHeight - el.clientHeight;
        if (vOver > threshold) {
          out.push(
            `${labelOf(el, i)}: content overflows the 100vh frame vertically by ~${Math.round(
              vOver
            )}px. Fix: cut/condense content on this slide, split it into two slides, switch to a 2-column layout, or reduce (still presentation-sized) type — do not let content run off-screen.`
          );
        }
        const hOver = el.scrollWidth - el.clientWidth;
        if (hOver > threshold) {
          out.push(
            `${labelOf(el, i)}: content overflows horizontally by ~${Math.round(
              hOver
            )}px. Fix: allow wrapping (word-break:keep-all; overflow-wrap:break-word), constrain element widths, or shrink a too-wide table/chart.`
          );
        }
      });
      return out;
    }, overflowPx);

    if (log) {
      log.renderQa = "ran";
      log.renderQaFindings = findings.length;
    }
    return findings.slice(0, 24);
  } catch (err) {
    if (log) log.renderQaError = String((err as Error)?.message ?? err);
    return [];
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (dir) await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
