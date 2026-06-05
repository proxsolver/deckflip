// Lightweight client-side log + feedback sink for future maintenance. Keeps a
// capped ring buffer in memory, mirrors it to localStorage so it survives a
// reload, captures uncaught errors, and can be downloaded as JSON. User
// "Report a problem" feedback is recorded as a `feedback` entry. Best-effort
// throughout — logging must never throw into the app.

export type LogLevel = "info" | "warn" | "error" | "feedback";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  stage: string;
  message: string;
  meta?: unknown;
}

const LS_KEY = "slidesmith.logs";
const MAX_ENTRIES = 200;

let buffer: LogEntry[] = loadFromStorage();

function loadFromStorage(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const parsed = raw ? (JSON.parse(raw) as LogEntry[]) : [];
    return Array.isArray(parsed) ? parsed.slice(-MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(buffer));
  } catch {
    /* quota/disabled — non-fatal */
  }
}

export function log(level: LogLevel, stage: string, message: string, meta?: unknown): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, stage, message, meta: safeMeta(meta) };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(-MAX_ENTRIES);
  persist();
  // Mirror to the console so live debugging still works.
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`[${stage}] ${message}`, meta ?? "");
}

// Strip anything non-serializable (and huge data URLs) so persistence can't throw.
function safeMeta(meta: unknown): unknown {
  if (meta == null) return undefined;
  try {
    const json = JSON.stringify(meta, (_k, v) =>
      typeof v === "string" && v.startsWith("data:") && v.length > 256 ? `${v.slice(0, 64)}…[${v.length} chars]` : v
    );
    return json && json.length > 4000 ? json.slice(0, 4000) + "…" : JSON.parse(json);
  } catch {
    return String(meta);
  }
}

export const logger = {
  info: (stage: string, message: string, meta?: unknown) => log("info", stage, message, meta),
  warn: (stage: string, message: string, meta?: unknown) => log("warn", stage, message, meta),
  error: (stage: string, message: string, meta?: unknown) => log("error", stage, message, meta),
  feedback: (message: string, meta?: unknown) => log("feedback", "user-feedback", message, meta),
};

export function getLogs(): LogEntry[] {
  return [...buffer];
}

export function clearLogs(): void {
  buffer = [];
  persist();
}

// Download the full log as a JSON file for bug reports.
export function downloadLogs(): void {
  const blob = new Blob([JSON.stringify(buffer, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `slidesmith-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Install once near app start to capture otherwise-invisible runtime failures.
let installed = false;
export function installGlobalErrorCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    log("error", "window.onerror", e.message || "Uncaught error", {
      source: e.filename,
      line: e.lineno,
      col: e.colno,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    log("error", "unhandledrejection", String((e.reason as Error)?.message ?? e.reason ?? "Unhandled rejection"));
  });
}
