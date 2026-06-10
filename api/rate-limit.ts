// In-memory rate limiter — IP + path based, per-window counter.
// Zero dependencies. Sufficient for the 20-user pilot (Phase 1).
// Swap for Redis-backed limiter when scaling beyond a few hundred users.

import type { IncomingMessage, ServerResponse } from "node:http";

// --- config ----------------------------------------------------------------

interface RouteLimit {
  /** Maximum requests per window per IP. */
  max: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Optional human-readable label for error messages. */
  label?: string;
}

// Limits are intentionally generous for the pilot — tighten later.
const ROUTE_LIMITS: Record<string, RouteLimit> = {
  // Deck generation is the expensive call ($1.5 API cost per request).
  "/api/generate":            { max: 5,  windowMs: 24 * 60 * 60 * 1000, label: "하루 5회" },
  // AI editing is cheaper but still costs tokens.
  "/api/ai-edit":             { max: 20, windowMs: 24 * 60 * 60 * 1000, label: "하루 20회" },
  "/api/ai-edit-element":     { max: 20, windowMs: 24 * 60 * 60 * 1000, label: "하루 20회" },
  // AI image generation costs tokens too.
  "/api/ai-image":            { max: 10, windowMs: 24 * 60 * 60 * 1000, label: "하루 10회" },
  "/api/ai-image-search":     { max: 10, windowMs: 24 * 60 * 60 * 1000, label: "하루 10회" },
  // Lighter operations — generous limits.
  "/api/generate-slide":      { max: 15, windowMs: 24 * 60 * 60 * 1000 },
  "/api/regenerate-scene":    { max: 15, windowMs: 24 * 60 * 60 * 1000 },
  "/api/generate-candidates": { max: 10, windowMs: 24 * 60 * 60 * 1000 },
  "/api/persona-interview":   { max: 10, windowMs: 24 * 60 * 60 * 1000 },
};

// Default for any unlisted route: no limit.
const DEFAULT_LIMIT: RouteLimit = { max: Infinity, windowMs: 0 };

// --- in-memory store -------------------------------------------------------

interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

// Key: `${ip}\n${path}` → bucket
const store = new Map<string, Bucket>();

// Purge expired entries every 10 minutes to prevent unbounded growth.
const PURGE_INTERVAL = 10 * 60 * 1000;
let lastPurge = Date.now();

function purge(): void {
  const now = Date.now();
  if (now - lastPurge < PURGE_INTERVAL) return;
  lastPurge = now;
  for (const [key, bucket] of store) {
    if (now >= bucket.resetAt) store.delete(key);
  }
}

// --- helpers ---------------------------------------------------------------

/** Extract the real client IP from Cloudflare headers, falling back to socket. */
function clientIp(req: IncomingMessage): string {
  // Cloudflare provides the true client IP in this header.
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  // Behind a proxy (e.g. nginx), X-Forwarded-For may be set.
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  // Direct connection.
  return req.socket.remoteAddress ?? "unknown";
}

function getLimit(path: string): RouteLimit {
  return ROUTE_LIMITS[path] ?? DEFAULT_LIMIT;
}

// --- public API ------------------------------------------------------------

export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Current count in this window. */
  current: number;
  /** Maximum allowed in this window. */
  limit: number;
  /** Seconds until the window resets. */
  retryAfterSec: number;
  /** Human-readable label (Korean). */
  label: string;
}

/** Check rate limit for a request. Call BEFORE executing the handler. */
export function checkRateLimit(path: string, ip: string): RateLimitResult {
  const limit = getLimit(path);
  if (limit.max === Infinity) {
    return { allowed: true, current: 0, limit: Infinity, retryAfterSec: 0, label: "" };
  }

  const now = Date.now();
  const key = `${ip}\n${path}`;
  let bucket = store.get(key);

  // Reset bucket if window expired.
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + limit.windowMs };
    store.set(key, bucket);
  }

  bucket.count++;
  purge();

  const allowed = bucket.count <= limit.max;
  const retryAfterSec = allowed ? 0 : Math.ceil((bucket.resetAt - now) / 1000);

  return {
    allowed,
    current: bucket.count,
    limit: limit.max,
    retryAfterSec,
    label: limit.label || `${limit.max}회/${limit.windowMs / 1000}초`,
  };
}

/**
 * Vite middleware factory. Returns a function that checks the rate limit
 * and writes a 429 response if exceeded. Returns true if the request
 * should proceed, false if it was rejected.
 */
export function rateLimitGuard(
  req: IncomingMessage,
  res: ServerResponse,
  path: string
): boolean {
  const ip = clientIp(req);
  const result = checkRateLimit(path, ip);

  // Always set rate limit headers so clients can self-regulate.
  res.setHeader("X-RateLimit-Limit", String(result.limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, result.limit - result.current)));

  if (!result.allowed) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Retry-After", String(result.retryAfterSec));
    res.end(JSON.stringify({
      error: `요청 한도를 초과했습니다. (${result.label}) ${Math.ceil(result.retryAfterSec / 60)}분 후 다시 시도해주세요.`,
      retryAfterSec: result.retryAfterSec,
    }));
    console.warn(`[rate-limit] 429 ${ip} ${path} (${result.current}/${result.limit})`);
    return false;
  }

  return true;
}
