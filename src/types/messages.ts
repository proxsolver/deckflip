// postMessage protocol between the React shell (parent) and the editor running
// inside the deck <iframe>. This replaces QWebChannel from the PyQt build.
//
//   parent -> iframe : Command (request, correlated by id)
//   iframe -> parent : Response (for commands that return a value)
//   iframe -> parent : EditorEvent (fire-and-forget: selection/mutation/slide)

import type { Patch, PatchOp } from "@shared/editing";
import type { EditorAction, LayoutOp, BlockSpec, SceneParamOp } from "@shared/editing";
import type { SceneParamInfo, BackgroundMotionInfo, BackgroundMotionOp, SceneSectionInfo, SceneAssignOp } from "@shared/editing";
import type { SelectionPayload, SelectedContext, SlideInfo, BackgroundLayer, SlidePalette } from "./context";

export type EditorTool = "select" | "text" | "rect";

// Manual image insertion (Toolbar → upload/URL). The src is an inlined data URL
// (uploads) or an external URL (paste). Editor-side only — not an AI action.
export interface ImageSpec {
  src: string;
  target?: { slideIndex?: number; x?: number; y?: number; w?: number };
}

export type EditorMethod =
  | "setEditMode"
  | "setTool"
  | "applyPatch"
  | "applyPatches"
  | "applyLayout"
  | "insertBlock"
  | "insertImage"
  | "applyActions"
  | "rebuildElement"
  | "duplicateSelected"
  | "deleteSelected"
  | "deselect"
  | "selectById"
  | "listBackgroundLayers"
  | "listSceneParams"
  | "applySceneParam"
  | "listSceneSections"
  | "applySceneAssignment"
  | "listBackgroundMotion"
  | "applyBackgroundMotion"
  | "assignStableIds"
  | "bringFront"
  | "sendBack"
  | "copySelected"
  | "cutSelected"
  | "paste"
  | "nudgeSelected"
  | "undo"
  | "redo"
  | "prevSlide"
  | "nextSlide"
  | "goToSlide"
  | "getCleanHtml"
  | "getSelectedContext"
  | "getSelectionContexts"
  | "getSelectedImageData"
  | "getSelectedPayload"
  | "getSlidePalette";

export interface Command {
  kind: "cmd";
  id: number;
  method: EditorMethod;
  args: unknown[];
}

export interface CommandResponse {
  kind: "res";
  id: number;
  result: unknown;
  error?: string;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

export type EditorEvent =
  | { kind: "evt"; name: "ready"; payload: null }
  | { kind: "evt"; name: "selection"; payload: SelectionPayload }
  | { kind: "evt"; name: "mutation"; payload: SelectionPayload }
  | { kind: "evt"; name: "slide"; payload: SlideInfo }
  | { kind: "evt"; name: "history"; payload: HistoryState }
  | { kind: "evt"; name: "log"; payload: string };

export type InboundMessage = CommandResponse | EditorEvent;

// Typed argument helpers for the parent-side bridge client.
export interface EditorCalls {
  setEditMode(enabled: boolean): Promise<void>;
  setTool(tool: EditorTool): Promise<void>;
  applyPatch(patch: Patch): Promise<void>;
  applyPatches(ops: PatchOp[]): Promise<void>;
  applyLayout(spec: Omit<LayoutOp, "ids"> & { ids?: string[] }): Promise<void>;
  insertBlock(spec: BlockSpec): Promise<void>;
  insertImage(spec: ImageSpec): Promise<void>;
  applyActions(actions: EditorAction[]): Promise<void>;
  rebuildElement(id: string, html: string): Promise<void>;
  duplicateSelected(): Promise<void>;
  deleteSelected(): Promise<void>;
  deselect(): Promise<void>;
  selectById(id: string): Promise<void>;
  listBackgroundLayers(): Promise<BackgroundLayer[]>;
  listSceneParams(): Promise<SceneParamInfo[]>;
  applySceneParam(op: SceneParamOp): Promise<void>;
  listSceneSections(): Promise<SceneSectionInfo>;
  applySceneAssignment(op: SceneAssignOp): Promise<void>;
  listBackgroundMotion(): Promise<BackgroundMotionInfo>;
  applyBackgroundMotion(op: BackgroundMotionOp): Promise<void>;
  assignStableIds(): Promise<string[]>;
  bringFront(): Promise<void>;
  sendBack(): Promise<void>;
  copySelected(): Promise<void>;
  cutSelected(): Promise<void>;
  paste(): Promise<void>;
  nudgeSelected(dx: number, dy: number): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  prevSlide(): Promise<void>;
  nextSlide(): Promise<void>;
  goToSlide(n: number): Promise<void>;
  getCleanHtml(): Promise<string>;
  getSelectedContext(): Promise<SelectedContext | null>;
  getSelectionContexts(): Promise<SelectedContext[]>;
  getSelectedImageData(): Promise<string | null>;
  getSelectedPayload(): Promise<SelectionPayload>;
  getSlidePalette(): Promise<SlidePalette>;
}
