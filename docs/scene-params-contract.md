# Making a deck's background animation editable

This guide is for **whoever generates or hand-writes a deck** (the AI deck
generator, or you). It explains how to make a deck's background animation
adjustable from the editor's **Scene** panel and by the AI — without giving the
editor any access to your code.

There are two independent mechanisms. Implement whichever fits your animation
(or both).

---

## 1. CSS animations — already work, do nothing

If your ambient motion is plain CSS (`@keyframes` + `animation:` on real DOM
elements — drifting glows, gradient sweeps, pulsing grids), the editor can
already control it on **any** deck, no cooperation required:

- The **Scene** panel shows a **Motion (CSS layers)** group with a **Speed**
  slider and a **Pause/Resume** button. It scans your background/decoration
  layers for ones running a CSS animation and writes inline
  `animation-duration` (scaled from your authored timing) and
  `animation-play-state`. These inline styles are kept on export.
- The AI/Inspector can pause or retime a **selected** animated element via the
  `animationPlayState` (`running` | `paused`) and `animationDuration` patch keys.

To benefit, just make sure your animated layers are reachable by the background
picker: give them an id/class that reads as background (`#bg-*`, `*background*`,
`*backdrop*`, `*particle*`, `glow`, `grid-overlay`, `noise`, `vignette`, or a
top-level `<canvas>`), and keep them at `<body>` level (outside `.slide`).

There is **nothing to implement** for this path.

---

## 2. JS / WebGL animations — implement the scene contract

If your motion is drawn by JavaScript (Three.js, a 2D canvas loop, a shader),
the editor cannot see or change it — its core rule is that it never reads or runs
deck code. To make such an animation tunable, expose a small controller on your
deck's `window`:

```js
window.__htmlPptScene = {
  // Report the params you support, with their CURRENT values, for the UI.
  getParams() {
    return [
      { key: "spinSpeed",       label: "Spin speed",       type: "number", value: state.spin,    min: 0, max: 3, step: 0.1 },
      { key: "particleOpacity", label: "Particle density", type: "number", value: state.parts,   min: 0, max: 1, step: 0.05 },
      { key: "keyLightColor",   label: "Key light color",  type: "color",  value: "#" + keyLight.color.getHexString() },
      // ...only the keys your scene actually has.
    ];
  },
  // Apply one param. Return true if applied, false to reject. Clamp/ignore
  // anything you don't support — the editor re-validates too, but be defensive.
  setParam(key, value) {
    switch (key) {
      case "spinSpeed":       state.spin  = clamp(+value, 0, 3); return true;
      case "particleOpacity": state.parts = clamp(+value, 0, 1); return true;
      case "keyLightColor":   keyLight.color.set(value);         return true;
      default: return false;
    }
  },
};
```

The editor calls **only** these two methods. The AI emits a `sceneParam` action
(`{ sceneKey, sceneValue }`); both the server and the client validate it against
the whitelist before it ever reaches your `setParam`.

### The param whitelist

`key` must be one of these (defined in `shared/scene-params.ts`). Implement the
subset that's meaningful for your scene; omit the rest from `getParams()`.

| key               | type     | range / value                  | meaning                        |
| ----------------- | -------- | ------------------------------ | ------------------------------ |
| `spinSpeed`       | `number` | `0 – 3` (1 = normal)           | rotation speed multiplier      |
| `particleOpacity` | `number` | `0 – 1`                        | particle/density visibility    |
| `keyLightColor`   | `color`  | CSS color (`#rrggbb`, `rgb()`) | primary light / accent color   |
| `fillLightColor`  | `color`  | CSS color                      | secondary light / accent color |
| `brightness`      | `number` | `0.3 – 2` (1 = normal)         | overall scene exposure         |

Need a knob that isn't here (e.g. `density`, `hue`)? Add it to
`SCENE_PARAM_KEYS` + `SCENE_PARAMS` in `shared/scene-params.ts` (one place — the
validator, schema, and UI all key off it), then implement it in your deck.

### Make changes stick in the render loop

If your animation loop overwrites a value every frame, route it through a
mutable knob so the param holds:

```js
// loop:
mesh.rotation.y += baseSpin * state.spin * dt;          // spinSpeed
particles.material.opacity = baseOpacity * state.parts; // particleOpacity
```

Colors / one-shot settings (light color, tone-mapping exposure) can be set
directly in `setParam` since the loop doesn't rewrite them.

### Persist for export (recommended)

Editor edits should survive **Save / Export**. Since your scene state lives in
JS, persist it into a plain JSON `<script>` that the editor's clean-HTML export
keeps (it strips only editor-marked nodes), and read it back on load:

```js
function persist() {
  let el = document.getElementById("html-ppt-scene");
  if (!el) {
    el = document.createElement("script");
    el.type = "application/json";
    el.id = "html-ppt-scene";
    document.body.appendChild(el);
  }
  el.textContent = JSON.stringify(currentConfig());
}
// in setParam: apply, then persist().

// on load, after building the scene:
try {
  const el = document.getElementById("html-ppt-scene");
  if (el && el.textContent) {
    const cfg = JSON.parse(el.textContent);
    Object.keys(cfg).forEach((k) => window.__htmlPptScene.setParam(k, cfg[k]));
  }
} catch {}
```

### Reference implementation

`sample_deck/Sample_EnglishTeslaPPT/three_scene.js` implements all of the above
(spin/particles/lights/brightness + persistence) and is the canonical example to
copy from.

---

## What the editor does on its side (FYI)

- `listSceneParams()` / `applySceneParam()` in `src/editor/core.ts` call your
  `getParams()` / `setParam()`. No controller → the Scene panel's 3D section is
  hidden and `sceneParam` actions no-op.
- Scene changes live in deck JS, so they are **not** on the slide-innerHTML undo
  stack (re-set a control to revert). The CSS-motion path (1) writes inline
  styles, which export keeps but also aren't undoable per-keystroke.
