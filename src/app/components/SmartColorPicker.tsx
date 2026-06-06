// Smart color picker: shows up to 5 slide-aware suggestions as swatches,
// then falls back to the native color picker for custom choice.

import type { SlidePalette } from "@/types/context";

interface SmartColorPickerProps {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  palette: SlidePalette | null;
}

const toHex = (v: string) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v : "#ffffff");

export function SmartColorPicker({ label, value, onChange, palette }: SmartColorPickerProps) {
  const activeHex = value.toUpperCase();

  return (
    <div className="ip-color-wrap">
      <div className="ip-color">
        <span>{label}</span>
        <input
          type="color"
          value={toHex(value)}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          title={`${label} color`}
        />
        <input
          type="text"
          value={value}
          placeholder="—"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {palette && palette.suggestions.length > 0 && (
        <div className="ip-suggestions">
          {palette.suggestions.map((s) => {
            const isActive = s.hex.toUpperCase() === activeHex;
            return (
              <button
                key={s.hex + s.label}
                className={"ip-swatch" + (isActive ? " active" : "")}
                title={s.label}
                onClick={() => onChange(s.hex)}
              >
                <span className="ip-swatch-color" style={{ backgroundColor: s.hex }} />
                <span className="ip-swatch-label">{s.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
