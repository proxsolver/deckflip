// Tiny event sink so the editor core can emit selection/mutation/slide/log
// without importing the RPC layer (avoids a circular dependency). index.ts /
// rpc.ts install the real emitter that posts to the parent window.

import type { EditorEvent } from "@/types/messages";

type EmitFn = (name: EditorEvent["name"], payload: unknown) => void;

let emitFn: EmitFn = () => {};

export function setEmitter(fn: EmitFn): void {
  emitFn = fn;
}

export function emit(name: EditorEvent["name"], payload: unknown): void {
  emitFn(name, payload);
}
