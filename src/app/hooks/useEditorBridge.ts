// Parent-side RPC client. Replaces QWebChannel + bridge.py: posts Commands into
// the deck iframe, resolves Responses by id, and routes EditorEvents to React
// state via the supplied handlers.

import { useEffect, useMemo, useRef } from "react";
import type {
  Command,
  CommandResponse,
  EditorCalls,
  EditorMethod,
  HistoryState,
  InboundMessage,
} from "@/types/messages";
import type { SelectionPayload, SlideInfo } from "@/types/context";

export interface BridgeHandlers {
  onReady?: () => void;
  onSelection?: (payload: SelectionPayload) => void;
  onMutation?: (payload: SelectionPayload) => void;
  onSlide?: (payload: SlideInfo) => void;
  onHistory?: (payload: HistoryState) => void;
  onLog?: (message: string) => void;
}

export interface EditorBridge extends EditorCalls {
  call(method: EditorMethod, ...args: unknown[]): Promise<unknown>;
}

export function useEditorBridge(
  iframeRef: React.RefObject<HTMLIFrameElement>,
  handlers: BridgeHandlers
): EditorBridge {
  const pending = useRef(new Map<number, (value: unknown) => void>());
  const seq = useRef(1);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const iframe = iframeRef.current;
      if (!iframe || e.source !== iframe.contentWindow) return;
      const msg = e.data as InboundMessage | undefined;
      if (!msg || typeof msg !== "object") return;

      if (msg.kind === "res") {
        const res = msg as CommandResponse;
        const resolve = pending.current.get(res.id);
        if (resolve) {
          pending.current.delete(res.id);
          if (res.error) console.warn("[editor]", res.error);
          resolve(res.result);
        }
        return;
      }

      if (msg.kind === "evt") {
        const h = handlersRef.current;
        switch (msg.name) {
          case "ready":
            h.onReady?.();
            break;
          case "selection":
            h.onSelection?.(msg.payload as never);
            break;
          case "mutation":
            h.onMutation?.(msg.payload);
            break;
          case "slide":
            h.onSlide?.(msg.payload);
            break;
          case "history":
            h.onHistory?.(msg.payload);
            break;
          case "log":
            h.onLog?.(msg.payload);
            break;
        }
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [iframeRef]);

  return useMemo<EditorBridge>(() => {
    function call(method: EditorMethod, ...args: unknown[]): Promise<unknown> {
      const target = iframeRef.current?.contentWindow;
      if (!target) return Promise.resolve(null);
      const id = seq.current++;
      const command: Command = { kind: "cmd", id, method, args };
      return new Promise((resolve) => {
        pending.current.set(id, resolve);
        target.postMessage(command, "*");
        // Safety: never leak a pending promise if the iframe goes away.
        setTimeout(() => {
          if (pending.current.has(id)) {
            pending.current.delete(id);
            resolve(null);
          }
        }, 10000);
      });
    }

    return {
      call,
      setEditMode: (enabled) => call("setEditMode", enabled) as Promise<void>,
      setTool: (tool) => call("setTool", tool) as Promise<void>,
      applyPatch: (patch) => call("applyPatch", patch) as Promise<void>,
      applyPatches: (ops) => call("applyPatches", ops) as Promise<void>,
      applyLayout: (spec) => call("applyLayout", spec) as Promise<void>,
      insertBlock: (spec) => call("insertBlock", spec) as Promise<void>,
      applyActions: (actions) => call("applyActions", actions) as Promise<void>,
      duplicateSelected: () => call("duplicateSelected") as Promise<void>,
      deleteSelected: () => call("deleteSelected") as Promise<void>,
      deselect: () => call("deselect") as Promise<void>,
      selectById: (id) => call("selectById", id) as Promise<void>,
      listBackgroundLayers: () => call("listBackgroundLayers") as Promise<never>,
      listSceneParams: () => call("listSceneParams") as Promise<never>,
      applySceneParam: (op) => call("applySceneParam", op) as Promise<void>,
      listBackgroundMotion: () => call("listBackgroundMotion") as Promise<never>,
      applyBackgroundMotion: (op) => call("applyBackgroundMotion", op) as Promise<void>,
      assignStableIds: () => call("assignStableIds") as Promise<string[]>,
      bringFront: () => call("bringFront") as Promise<void>,
      sendBack: () => call("sendBack") as Promise<void>,
      copySelected: () => call("copySelected") as Promise<void>,
      cutSelected: () => call("cutSelected") as Promise<void>,
      paste: () => call("paste") as Promise<void>,
      nudgeSelected: (dx, dy) => call("nudgeSelected", dx, dy) as Promise<void>,
      undo: () => call("undo") as Promise<void>,
      redo: () => call("redo") as Promise<void>,
      prevSlide: () => call("prevSlide") as Promise<void>,
      nextSlide: () => call("nextSlide") as Promise<void>,
      goToSlide: (n) => call("goToSlide", n) as Promise<void>,
      getCleanHtml: () => call("getCleanHtml") as Promise<string>,
      getSelectedContext: () => call("getSelectedContext") as Promise<never>,
      getSelectionContexts: () => call("getSelectionContexts") as Promise<never>,
      getSelectedImageData: () => call("getSelectedImageData") as Promise<string | null>,
      getSelectedPayload: () => call("getSelectedPayload") as Promise<never>,
    };
  }, [iframeRef]);
}
