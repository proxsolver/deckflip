/**
 * Sentry initialization for the Vite dev-server API layer.
 *
 * Call `initSentry()` once at server startup (vite.config.ts configureServer).
 * If SENTRY_DSN is missing the init is a no-op — safe for local dev.
 */
import * as Sentry from "@sentry/node";

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // No DSN = Sentry stays disabled (local dev, CI, etc.)
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV ?? "production",
    tracesSampleRate: 0.1, // 10% of transactions
    release: process.env.SENTRY_RELEASE ?? "deckflip-qas@0.1.0",
  });

  initialized = true;
}

/** Capture an exception. No-op when Sentry is not initialized. */
export function captureException(err: unknown): void {
  if (initialized) {
    Sentry.captureException(err);
  }
}
