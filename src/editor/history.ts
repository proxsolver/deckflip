// Undo/redo for the editor. Snapshot-based: before each discrete mutation we
// push the slide container's innerHTML; undo/redo swap snapshots. Coarse but
// robust for a deck-editing tool. Snapshots cover slide content only (the
// overlay UI lives on document.body, the injected <style> in <head>, and the
// editor script is a sibling of .presentation — none are captured).
//
// Limitation: restoring innerHTML re-creates nodes, so listeners the deck's own
// script attached inside a slide (e.g. a Three.js canvas) are dropped on undo.

import { emit } from "./events";

const UNDO_LIMIT = 80;
let undoStack: string[] = [];
let redoStack: string[] = [];

function container(): HTMLElement | null {
  const pres = document.querySelector<HTMLElement>(".presentation");
  if (pres) return pres;
  const slide = document.querySelector<HTMLElement>(".slide");
  if (slide?.parentElement) return slide.parentElement;
  return document.body;
}

function emitHistory(): void {
  emit("history", { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
}

export function resetHistory(): void {
  undoStack = [];
  redoStack = [];
  emitHistory();
}

export function saveState(): void {
  const c = container();
  if (!c) return;
  undoStack.push(c.innerHTML);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
  emitHistory();
}

export function undo(): boolean {
  const c = container();
  if (!c || undoStack.length === 0) return false;
  redoStack.push(c.innerHTML);
  c.innerHTML = undoStack.pop()!;
  emitHistory();
  return true;
}

export function redo(): boolean {
  const c = container();
  if (!c || redoStack.length === 0) return false;
  undoStack.push(c.innerHTML);
  c.innerHTML = redoStack.pop()!;
  emitHistory();
  return true;
}
