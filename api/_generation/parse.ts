// Server-side upload parsing (Node-only): pdf / docx / txt / image → extracted
// text + embedded images (as data: URLs). Used by /api/parse-upload so the deck
// generator can reuse the *content* of the user's files, including images found
// INSIDE documents. Never throws on a bad file — it degrades to whatever it could
// extract (text-only, or nothing) so an upload can't fail the wizard.
//
// docx images come straight from mammoth as data URLs (reliable). pdf images are
// best-effort: pdfjs decodes image XObjects to bitmaps which we PNG-encode here
// (pure Node via node:zlib); any image that can't be decoded is simply skipped.

import { deflateSync } from "node:zlib";
import type { ParseUploadRequest, ParseUploadResponse } from "../../shared/generation";

const MAX_TEXT = 24000;
const MAX_IMAGES = 8;
const MAX_IMG_DIM = 2400; // skip absurdly large bitmaps (memory guard)

export async function handleParseUpload(req: ParseUploadRequest): Promise<ParseUploadResponse> {
  const mime = (req?.mime || "").toLowerCase();
  const name = (req?.name || "").toLowerCase();
  const parsed = parseDataUrl(req?.dataUrl || "");
  if (!parsed) return { text: "", images: [] };

  // Direct image upload → the image IS the asset.
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)) {
    return { text: "", images: [req.dataUrl] };
  }

  const buf = parsed.bytes;

  if (mime.includes("pdf") || name.endsWith(".pdf")) {
    return await parsePdf(buf);
  }
  if (
    mime.includes("officedocument.wordprocessingml") ||
    mime.includes("msword") ||
    name.endsWith(".docx")
  ) {
    return await parseDocx(buf);
  }
  // Plain text / markdown / csv / json / xml → decode as UTF-8.
  return { text: clip(new TextDecoder().decode(buf)), images: [] };
}

// --- docx (mammoth) ---------------------------------------------------------

async function parseDocx(buf: Uint8Array): Promise<ParseUploadResponse> {
  const images: string[] = [];
  try {
    const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
    const nodeBuf = Buffer.from(buf);
    try {
      await mammoth.convertToHtml(
        { buffer: nodeBuf },
        {
          convertImage: mammoth.images.imgElement(async (image: { contentType: string; read: (enc: string) => Promise<string> }) => {
            try {
              if (images.length < MAX_IMAGES) {
                const b64 = await image.read("base64");
                images.push(`data:${image.contentType || "image/png"};base64,${b64}`);
              }
            } catch {
              /* skip one bad image */
            }
            return { src: "" };
          }),
        }
      );
    } catch {
      /* image walk failed — still try text below */
    }
    let text = "";
    try {
      text = (await mammoth.extractRawText({ buffer: nodeBuf })).value || "";
    } catch {
      /* no text */
    }
    return { text: clip(text), images };
  } catch (err) {
    console.error("[parse] docx parse failed:", String((err as Error)?.message ?? err));
    return { text: "", images };
  }
}

// --- pdf (pdfjs-dist legacy build, Node) ------------------------------------

async function parsePdf(buf: Uint8Array): Promise<ParseUploadResponse> {
  const images: string[] = [];
  let text = "";
  try {
    // The legacy build runs without a worker on the Node main thread.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: buf,
      useSystemFonts: false,
      disableFontFace: true,
    });
    const doc = await loadingTask.promise;
    const OPS = pdfjs.OPS;
    const pageCount = Math.min(doc.numPages, 40);
    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      try {
        const tc = await page.getTextContent();
        text += tc.items.map((it) => ("str" in it ? (it as { str: string }).str : "")).join(" ") + "\n";
      } catch {
        /* page had no extractable text */
      }
      if (images.length < MAX_IMAGES) {
        try {
          const ops = await page.getOperatorList();
          const seen = new Set<string>();
          for (let i = 0; i < ops.fnArray.length && images.length < MAX_IMAGES; i++) {
            if (ops.fnArray[i] !== OPS.paintImageXObject) continue;
            const objId = ops.argsArray[i]?.[0];
            if (typeof objId !== "string" || seen.has(objId)) continue;
            seen.add(objId);
            try {
              const img = await getPageObj(page, objId);
              const png = bitmapToPng(img);
              if (png) images.push(png);
            } catch {
              /* skip undecodable image */
            }
          }
        } catch {
          /* operator list unavailable */
        }
      }
      page.cleanup();
    }
    await loadingTask.destroy();
  } catch (err) {
    console.error("[parse] pdf parse failed:", String((err as Error)?.message ?? err));
  }
  return { text: clip(text), images };
}

// page.objs.get resolves async via callback; race a timeout so a never-ready
// object can't hang the request.
function getPageObj(page: { objs: { get: (id: string, cb: (v: unknown) => void) => void } }, id: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("obj timeout")), 3000);
    try {
      page.objs.get(id, (val: unknown) => {
        clearTimeout(timer);
        resolve(val);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

// pdfjs image object → PNG data URL. Handles RGB_24BPP (kind 2) and RGBA_32BPP
// (kind 3) bitmaps, the common cases for photos/JPEGs decoded by pdfjs. Other
// kinds (1bpp masks) are skipped.
function bitmapToPng(img: unknown): string | null {
  if (!img || typeof img !== "object") return null;
  const o = img as { width?: number; height?: number; kind?: number; data?: Uint8Array | Uint8ClampedArray };
  const width = o.width ?? 0;
  const height = o.height ?? 0;
  const data = o.data;
  if (!width || !height || !data || width > MAX_IMG_DIM || height > MAX_IMG_DIM) return null;
  const px = width * height;
  const rgba = new Uint8Array(px * 4);
  if (o.kind === 3 && data.length >= px * 4) {
    rgba.set(data.subarray(0, px * 4));
  } else if (o.kind === 2 && data.length >= px * 3) {
    for (let i = 0, j = 0; i < px; i++) {
      rgba[j++] = data[i * 3];
      rgba[j++] = data[i * 3 + 1];
      rgba[j++] = data[i * 3 + 2];
      rgba[j++] = 255;
    }
  } else {
    return null;
  }
  return rgbaToPngDataUrl(width, height, rgba);
}

// --- minimal PNG encoder (RGBA, no external deps) ---------------------------

function rgbaToPngDataUrl(width: number, height: number, rgba: Uint8Array): string {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// --- shared helpers ---------------------------------------------------------

function clip(s: string): string {
  const t = (s || "").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + "\n…(truncated)" : t;
}

function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const isB64 = !!m[2];
  try {
    const bytes = isB64 ? new Uint8Array(Buffer.from(m[3], "base64")) : new TextEncoder().encode(decodeURIComponent(m[3]));
    return { mime, bytes };
  } catch {
    return null;
  }
}
