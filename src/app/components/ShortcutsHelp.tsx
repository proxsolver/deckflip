// Keyboard shortcut cheat-sheet modal.

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Edit",
    rows: [
      ["Undo", "Ctrl/⌘ Z"],
      ["Redo", "Ctrl/⌘ Y · Ctrl/⌘ Shift Z"],
      ["Copy", "Ctrl/⌘ C"],
      ["Cut", "Ctrl/⌘ X"],
      ["Paste", "Ctrl/⌘ V"],
      ["Duplicate", "Ctrl/⌘ D"],
      ["Delete", "Delete · Backspace"],
    ],
  },
  {
    title: "Arrange & move",
    rows: [
      ["Nudge selected", "Arrow keys"],
      ["Nudge by 10px", "Shift + Arrow"],
      ["Bring to front", "Ctrl/⌘ ]"],
      ["Send to back", "Ctrl/⌘ ["],
      ["Deselect", "Esc"],
    ],
  },
  {
    title: "Text & slides",
    rows: [
      ["Edit text", "Double-click object"],
      ["Finish text edit", "Esc"],
      ["Previous / next slide", "Toolbar ◀ ▶ (or deck arrows when nothing selected)"],
    ],
  },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts" role="dialog" aria-modal="true">
        <h3>Keyboard shortcuts</h3>
        <div className="shortcuts-grid">
          {GROUPS.map((g) => (
            <div key={g.title} className="shortcuts-group">
              <div className="shortcuts-group-title">{g.title}</div>
              {g.rows.map(([label, keys]) => (
                <div key={label} className="shortcut-row">
                  <span>{label}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="actions">
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
