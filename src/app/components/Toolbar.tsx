// Grouped icon toolbar: File dropdown · undo/redo · tool segment · object
// actions · AI · slide nav · edit switch · help. Replaces the old wall of
// text buttons. Every icon has a title with its shortcut.

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import type { EditorTool } from "@/types/messages";
import type { BackgroundLayer } from "@/types/context";
import type { LayoutOp } from "@shared/actions";
import { BLOCK_TYPES, BLOCK_TEMPLATES, type BlockType } from "@shared/blocks";
import {
  BackIcon, ChevronDown, DuplicateIcon, ExportIcon, FolderIcon, FrontIcon, HelpIcon,
  LayersIcon, NextIcon, PointerIcon, PrevIcon, RectIcon, RedoIcon, ReloadIcon, SaveIcon,
  SparkleIcon, TextIcon, TrashIcon, UndoIcon,
} from "./icons";

// Spec a layout verb without ids; the editor fills ids from the live selection.
export type ToolbarLayoutSpec = Omit<LayoutOp, "ids">;

// Local mini-icons (kept here so icons.tsx stays untouched).
const AlignIcon = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
    <line x1="2" y1="2" x2="2" y2="14" /><rect x="4" y="3.5" width="9" height="3" rx="1" fill="currentColor" stroke="none" />
    <rect x="4" y="9.5" width="6" height="3" rx="1" fill="currentColor" stroke="none" />
  </svg>
);
const BlockIcon = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" /><line x1="2.5" y1="6.5" x2="13.5" y2="6.5" />
  </svg>
);

export interface ToolbarProps {
  hasDeck: boolean;
  hasSelection: boolean;
  selectionCount: number;
  editMode: boolean;
  tool: EditorTool;
  slide: { current: number; total: number };
  canUndo: boolean;
  canRedo: boolean;
  onOpenFolder: () => void;
  onOpenFiles: (files: FileList) => void;
  onToggleEdit: () => void;
  onSetTool: (tool: EditorTool) => void;
  onListBackgrounds: () => Promise<BackgroundLayer[]>;
  onSelectLayer: (id: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onBringFront: () => void;
  onSendBack: () => void;
  onLayout: (spec: ToolbarLayoutSpec) => void;
  onInsertBlock: (blockType: BlockType) => void;
  onAiEdit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSaveHtml: () => void;
  onExportProject: () => void;
  onExportStandalone: () => void;
  onExportHtml: () => void;
  onReload: () => void;
  onHelp: () => void;
}

function IconButton({
  title, onClick, disabled, active, children,
}: {
  title: string; onClick: () => void; disabled?: boolean; active?: boolean; children: ReactNode;
}) {
  return (
    <button className={`icon-btn${active ? " active" : ""}`} title={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function Toolbar(props: ToolbarProps) {
  const { editMode, tool, slide, hasDeck, hasSelection, selectionCount } = props;
  const editDisabled = !editMode || !hasDeck;
  const multiDisabled = editDisabled || selectionCount < 2;

  const [menuOpen, setMenuOpen] = useState(false);
  const fileRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [bgOpen, setBgOpen] = useState(false);
  const [bgLayers, setBgLayers] = useState<BackgroundLayer[]>([]);
  const bgRef = useRef<HTMLDivElement>(null);

  const [arrangeOpen, setArrangeOpen] = useState(false);
  const arrangeRef = useRef<HTMLDivElement>(null);
  const [blockOpen, setBlockOpen] = useState(false);
  const blockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (fileRef.current && !fileRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  useEffect(() => {
    if (!bgOpen) return;
    const close = (e: MouseEvent) => {
      if (bgRef.current && !bgRef.current.contains(e.target as Node)) setBgOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [bgOpen]);

  const toggleBackground = async () => {
    const next = !bgOpen;
    setBgOpen(next);
    if (next) setBgLayers(await props.onListBackgrounds());
  };

  useEffect(() => {
    if (!arrangeOpen) return;
    const close = (e: MouseEvent) => {
      if (arrangeRef.current && !arrangeRef.current.contains(e.target as Node)) setArrangeOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [arrangeOpen]);

  useEffect(() => {
    if (!blockOpen) return;
    const close = (e: MouseEvent) => {
      if (blockRef.current && !blockRef.current.contains(e.target as Node)) setBlockOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [blockOpen]);

  const arrangeItem = (label: string, spec: ToolbarLayoutSpec) => (
    <button className="menu-item" onClick={() => { setArrangeOpen(false); props.onLayout(spec); }}>
      <span className="menu-icon"><AlignIcon /></span>
      {label}
    </button>
  );

  const onFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) props.onOpenFiles(e.target.files);
    e.target.value = "";
  };

  const menuItem = (label: string, icon: ReactNode, action: () => void, disabled = false) => (
    <button className="menu-item" disabled={disabled} onClick={() => { setMenuOpen(false); action(); }}>
      <span className="menu-icon">{icon}</span>
      {label}
    </button>
  );

  return (
    <div className="topbar">
      <div className="file-menu" ref={fileRef}>
        <button className="file-trigger" onClick={() => setMenuOpen((o) => !o)}>
          <FolderIcon /> File <ChevronDown width={13} height={13} />
        </button>
        {menuOpen && (
          <div className="menu">
            {menuItem("Open Folder…", <FolderIcon />, props.onOpenFolder)}
            {menuItem("Open Files…", <FolderIcon />, () => inputRef.current?.click())}
            <div className="menu-sep" />
            {menuItem("Save HTML", <SaveIcon />, props.onSaveHtml, !hasDeck)}
            {menuItem("Export Standalone HTML", <ExportIcon />, props.onExportStandalone, !hasDeck)}
            {menuItem("Export Project", <ExportIcon />, props.onExportProject, !hasDeck)}
            {menuItem("Export HTML Only", <ExportIcon />, props.onExportHtml, !hasDeck)}
            <div className="menu-sep" />
            {menuItem("Reload", <ReloadIcon />, props.onReload, !hasDeck)}
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          // @ts-expect-error non-standard directory upload attributes
          webkitdirectory=""
          directory=""
          multiple
          hidden
          onChange={onFileInput}
        />
      </div>

      <span className="divider" />

      <IconButton title="Undo (Ctrl+Z)" disabled={!hasDeck || !props.canUndo} onClick={props.onUndo}><UndoIcon /></IconButton>
      <IconButton title="Redo (Ctrl+Y)" disabled={!hasDeck || !props.canRedo} onClick={props.onRedo}><RedoIcon /></IconButton>

      <span className="divider" />

      <div className="segment" role="group" aria-label="Tools">
        <IconButton title="Pointer" disabled={editDisabled} active={tool === "select"} onClick={() => props.onSetTool("select")}><PointerIcon /></IconButton>
        <IconButton title="Text box" disabled={editDisabled} active={tool === "text"} onClick={() => props.onSetTool("text")}><TextIcon /></IconButton>
        <IconButton title="Rectangle" disabled={editDisabled} active={tool === "rect"} onClick={() => props.onSetTool("rect")}><RectIcon /></IconButton>
      </div>

      <span className="divider" />

      <div className="file-menu bg-menu" ref={bgRef}>
        <button
          className="icon-btn"
          title="Select background / animation layer"
          disabled={editDisabled}
          onClick={toggleBackground}
        >
          <LayersIcon />
        </button>
        {bgOpen && (
          <div className="menu">
            <div className="menu-head">Background layers</div>
            {bgLayers.length === 0 && <div className="menu-empty">No background layers found.</div>}
            {bgLayers.map((layer) => (
              <button
                key={layer.id}
                className="menu-item"
                onClick={() => {
                  setBgOpen(false);
                  props.onSelectLayer(layer.id);
                }}
              >
                <span className="menu-icon"><LayersIcon /></span>
                {layer.label}
                <span className="menu-dim">{layer.w}×{layer.h}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="divider" />

      <IconButton title="Duplicate (Ctrl+D)" disabled={editDisabled || !hasSelection} onClick={props.onDuplicate}><DuplicateIcon /></IconButton>
      <IconButton title="Delete (Del)" disabled={editDisabled || !hasSelection} onClick={props.onDelete}><TrashIcon /></IconButton>
      <IconButton title="Bring to front (Ctrl+])" disabled={editDisabled || !hasSelection} onClick={props.onBringFront}><FrontIcon /></IconButton>
      <IconButton title="Send to back (Ctrl+[)" disabled={editDisabled || !hasSelection} onClick={props.onSendBack}><BackIcon /></IconButton>

      <span className="divider" />

      <div className="file-menu" ref={arrangeRef}>
        <button
          className="icon-btn"
          title="Arrange / align (select 2+ objects)"
          disabled={multiDisabled}
          onClick={() => setArrangeOpen((o) => !o)}
        >
          <AlignIcon />
        </button>
        {arrangeOpen && (
          <div className="menu">
            <div className="menu-head">Align</div>
            {arrangeItem("Left", { op: "align", axis: "left" })}
            {arrangeItem("Center", { op: "align", axis: "hcenter" })}
            {arrangeItem("Right", { op: "align", axis: "right" })}
            {arrangeItem("Top", { op: "align", axis: "top" })}
            {arrangeItem("Middle", { op: "align", axis: "vcenter" })}
            {arrangeItem("Bottom", { op: "align", axis: "bottom" })}
            <div className="menu-sep" />
            {arrangeItem("Center on slide", { op: "align", axis: "hcenter", relativeTo: "slide" })}
            <div className="menu-sep" />
            <div className="menu-head">Distribute</div>
            {arrangeItem("Horizontally", { op: "distribute", axis: "horizontal" })}
            {arrangeItem("Vertically", { op: "distribute", axis: "vertical" })}
            <div className="menu-sep" />
            {arrangeItem("Make same size", { op: "matchSize", axis: "both" })}
            {arrangeItem("Arrange in grid", { op: "grid", cols: 2, gap: 16 })}
          </div>
        )}
      </div>

      <div className="file-menu" ref={blockRef}>
        <button
          className="icon-btn"
          title="Insert content block"
          disabled={editDisabled}
          onClick={() => setBlockOpen((o) => !o)}
        >
          <BlockIcon />
        </button>
        {blockOpen && (
          <div className="menu">
            <div className="menu-head">Insert block</div>
            {BLOCK_TYPES.map((t) => (
              <button
                key={t}
                className="menu-item"
                onClick={() => { setBlockOpen(false); props.onInsertBlock(t); }}
              >
                <span className="menu-icon"><BlockIcon /></span>
                {BLOCK_TEMPLATES[t].label}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="divider" />

      <button className="ai-btn" disabled={editDisabled || !hasSelection} onClick={props.onAiEdit}>
        <SparkleIcon /> AI
      </button>

      <span className="spacer" />

      <div className="nav">
        <IconButton title="Previous slide" disabled={!hasDeck} onClick={props.onPrev}><PrevIcon /></IconButton>
        <span className="slide-label">{slide.total ? slide.current : "-"} / {slide.total || "-"}</span>
        <IconButton title="Next slide" disabled={!hasDeck} onClick={props.onNext}><NextIcon /></IconButton>
      </div>

      <span className="divider" />

      <button
        className={`edit-switch${editMode ? " on" : ""}`}
        disabled={!hasDeck}
        onClick={props.onToggleEdit}
        title="Toggle edit mode"
      >
        <span className="knob" />
        <span className="edit-label">{editMode ? "Edit" : "View"}</span>
      </button>

      <IconButton title="Keyboard shortcuts" onClick={props.onHelp}><HelpIcon /></IconButton>
    </div>
  );
}
