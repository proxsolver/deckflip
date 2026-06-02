// iframe side of the postMessage protocol. Receives Commands from the React
// shell, dispatches them to editorApi, and posts Responses + fire-and-forget
// EditorEvents back to the parent. This replaces the QWebChannel transport.

import type { Command, CommandResponse, EditorEvent } from "@/types/messages";
import { setEmitter } from "./events";
import { editorApi, type EditorApi } from "./core";

// srcdoc / blob iframes are same-origin as the embedder, so we can pin the
// parent origin instead of posting to "*".
function parentOrigin(): string {
  try {
    return document.referrer ? new URL(document.referrer).origin : "*";
  } catch {
    return "*";
  }
}

function post(message: CommandResponse | EditorEvent, targetOrigin: string): void {
  window.parent?.postMessage(message, targetOrigin);
}

export function bindRpc(): void {
  const origin = parentOrigin();

  setEmitter((name, payload) => {
    post({ kind: "evt", name, payload } as EditorEvent, origin);
  });

  window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as Command | undefined;
    if (!msg || msg.kind !== "cmd") return;
    const { id, method, args } = msg;
    let result: unknown = null;
    let error: string | undefined;
    try {
      const fn = (editorApi as EditorApi)[method] as unknown as ((...a: unknown[]) => unknown) | undefined;
      if (typeof fn !== "function") {
        error = `Unknown editor method: ${method}`;
      } else {
        result = fn.apply(editorApi, args || []);
      }
    } catch (err) {
      error = String((err as Error)?.message ?? err);
    }
    const replyOrigin = e.origin && e.origin !== "null" ? e.origin : origin;
    post({ kind: "res", id, result: result ?? null, error }, replyOrigin);
  });
}
