// Server-side 3D scene REGENERATION. Authors a brand-new three_scene.js for a
// deck the user is already editing — this is GENERATION (it emits code), not an
// edit-patch, so it does NOT go through validateActions. It is the real fix for
// "make it a totally different 3D animation": the edit-action vocabulary can only
// tune the 5 vetted sceneParam knobs (spinSpeed/particleOpacity/lights/brightness)
// and can never author motion, so a chat request to change the animation itself
// must regenerate the deck's own background JS. The new scene renders in the same
// sandboxed srcdoc iframe as any deck, so the trust boundary is unchanged.
//
// Reuses the provider abstraction (Anthropic Opus primary, OpenAI fallback) from
// _generate.ts. No key → a deterministic mock scene so the flow works secret-free.

import {
  EMIT_SCENE_TOOL,
  EMIT_SCENE_SCHEMA,
  coerceSceneResult,
  type RegenerateSceneRequest,
  type RegenerateSceneResponse,
  type DesignBrief,
} from "../../shared/generation";
import { newUsageAcc, recordUsage, summarizeUsage } from "../../shared/generation";
import { resolveProviders, callWithFallback } from "./providers";

function env(name: string): string | undefined {
  return (typeof process !== "undefined" && process.env ? process.env[name] : undefined)?.trim() || undefined;
}

// Compact, self-contained system prompt. Keeps the deck contract the editor and
// the Scene panel depend on (canvas id, #three-canvas-container, the controller).
const SCENE_SYSTEM_PROMPT = `You author a SINGLE self-contained three_scene.js file: a 3D/canvas background animation for an HTML presentation deck.

HARD CONTRACT (the editor and exported deck depend on every point):
- Use the GLOBAL \`THREE\` (loaded via CDN <script> — do NOT import/require/export anything; this is a classic global script, not a module).
- Render into <canvas id="three-canvas"> inside <div id="three-canvas-container"> (both already exist in the DOM). The container is fixed, full-viewport, behind the slides, pointer-events:none.
- Self-initialize on DOMContentLoaded/load (guard if document.readyState is already complete). Handle window resize (update camera aspect + renderer size + pixel ratio).
- Keep it lightweight and smooth (requestAnimationFrame loop; cap pixel ratio at 2). It is a BACKGROUND — subtle, not distracting, never covering text legibility.
- Expose a controller so the editor's sliders keep working:
    window.__htmlPptScene = {
      getParams(){ return [ {key,label,type:"number"|"color",value,min?,max?,step?}, ... ]; },
      setParam(key,value){ /* apply + persist; return true if applied */ }
    };
  Support these keys: spinSpeed (number 0..3), particleOpacity (number 0..1), keyLightColor (color), fillLightColor (color), brightness (number 0.3..2). A scene may legitimately map some keys onto its own concept (e.g. spinSpeed → flow speed) — that's fine; just keep the key names.
- Persist chosen params by writing them into a kept <script id="html-ppt-scene"> in <head> (create it if missing) so an exported deck reloads with the same look, and re-read it on init. This script id carries NO editor marker, so it survives export.

PER-SECTION SCENES (do this when the user asks for "different animation per section/page" OR when the deck clearly has multiple sections):
- Build the background as a SCENE FACTORY (multiple named scene builders) + a CROSSFADE MANAGER that swaps the active scene when the visible SECTION changes (drive it off scroll position / an IntersectionObserver over '.slide', grouping slides into sections — e.g. by a leading section number or every N slides). Crossfade smoothly over ~600ms (blend opacity / interpolate between the outgoing and incoming scene); never hard-cut, never leave both fully visible.
- Expose THREE more controller methods so the editor can reassign scenes per section:
    listScenes(){ return ["nebula","ribbons", ...]; }                 // available scene names
    getSectionScenes(){ return [ {section:"01", sceneName:"nebula"}, ... ]; } // current mapping
    setSceneForSection(section, sceneName){ /* crossfade + persist; return true */ }
  Persist the section→scene mapping into the same kept <script id="html-ppt-scene"> and re-apply it on init. A single-scene deck simply omits these three methods.

OUTPUT: call the emit_scene tool with the COMPLETE new file in threeSceneJs, a short threeDMotif label, and a one-line message. The new animation must be a GENUINELY DIFFERENT visual concept from the current one (different geometry/motion/feel), not a recolor of the same effect. Honor the deck's palette and the user's instruction. Never output markdown, prose, or partial snippets — only the tool call.`;

function briefText(brief?: DesignBrief): string {
  if (!brief) return "(no brief available)";
  return JSON.stringify(
    {
      topic: brief.topic,
      palette: brief.paletteHex,
      fonts: brief.fonts,
      currentMotif: brief.threeDMotif,
      tone: brief.toneNotes,
    },
    null,
    2
  );
}

export async function handleRegenerateScene(req: RegenerateSceneRequest): Promise<RegenerateSceneResponse> {
  const prompt = (req?.prompt ?? "").trim();
  if (!prompt) throw new Error("Describe the new 3D animation you want.");

  const forceMock = /^(1|true|yes|on)$/i.test(env("HTML_PPT_AI_MOCK") || "");
  const log: Record<string, unknown> = {};
  const providers = forceMock ? { primary: undefined, fallback: undefined } : resolveProviders(log);

  if (!providers.primary) {
    return {
      threeSceneJs: mockSceneJs(prompt),
      threeDMotif: "mock particle field",
      message: "Demo mode — swapped in a sample 3D background (set ANTHROPIC_API_KEY or OPENAI_API_KEY for real regeneration).",
      mock: true,
    };
  }

  const current = (req.currentSceneJs ?? "").slice(0, 24000); // cap the context we echo back
  const userText =
    `=== 사용자 요청 (완전히 다른 3D 배경 애니메이션으로 재생성) ===\n${prompt}\n\n` +
    `=== designBrief ===\n${briefText(req.brief)}\n\n` +
    (current
      ? `=== 현재 three_scene.js (이 컨트롤러/캔버스 계약은 유지하되, 모션/비주얼은 완전히 다르게) ===\n${current}`
      : `현재 three_scene.js가 없다 — 위 계약을 지키는 새 파일을 처음부터 작성하라.`);

  const usageAcc = newUsageAcc();
  const res = await callWithFallback(
    providers,
    {
      maxTokens: Number(env("HTML_PPT_SCENE_MAX_TOKENS") || "20000"),
      images: [],
      userText,
      schema: EMIT_SCENE_SCHEMA,
      toolName: EMIT_SCENE_TOOL,
      toolDescription: "Return the complete new three_scene.js plus a motif label and a one-line message.",
      system: SCENE_SYSTEM_PROMPT,
    },
    log,
    "scene"
  );

  const coerced = coerceSceneResult(res.input);
  if (!coerced) throw new Error("Scene regeneration returned no usable three_scene.js.");

  recordUsage(usageAcc, res.usage, String(log.sceneProvider ?? log.provider ?? ""), String(log.sceneModel ?? log.model ?? ""));
  const usage = summarizeUsage(usageAcc, String(log.sceneProvider ?? log.provider ?? ""), String(log.sceneModel ?? log.model ?? ""));

  return { ...coerced, usage, mock: false };
}

// A small, valid, self-contained scene so the no-key demo visibly swaps the
// background and keeps the controller contract (sliders keep working).
function mockSceneJs(prompt: string): string {
  const seed = prompt.length;
  return `// Mock 3D background (offline demo). Replace with a real key for AI regeneration.
(function(){
  if (typeof THREE === 'undefined') return;
  var canvas = document.getElementById('three-canvas');
  if (!canvas) return;
  var state = { spinSpeed: 1, particleOpacity: 0.8, keyLightColor: '#37c6ff', fillLightColor: '#a855f7', brightness: 1 };
  try { var saved = document.getElementById('html-ppt-scene'); if (saved) Object.assign(state, JSON.parse(saved.textContent || '{}')); } catch(e){}
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000); camera.position.z = 60;
  var COUNT = 1200, geo = new THREE.BufferGeometry(), pos = new Float32Array(COUNT*3);
  for (var i=0;i<COUNT;i++){ pos[i*3]=(Math.random()-0.5)*120; pos[i*3+1]=(Math.random()-0.5)*120; pos[i*3+2]=(Math.random()-0.5)*120; }
  geo.setAttribute('position', new THREE.BufferAttribute(pos,3));
  var mat = new THREE.PointsMaterial({ size: 0.7 + (${seed}%3)*0.2, color: new THREE.Color(state.keyLightColor), transparent: true, opacity: state.particleOpacity });
  var points = new THREE.Points(geo, mat); scene.add(points);
  function resize(){ var w=window.innerWidth,h=window.innerHeight; camera.aspect=w/h; camera.updateProjectionMatrix(); renderer.setSize(w,h,false); }
  window.addEventListener('resize', resize); resize();
  function persist(){ var s=document.getElementById('html-ppt-scene'); if(!s){ s=document.createElement('script'); s.type='application/json'; s.id='html-ppt-scene'; document.head.appendChild(s);} s.textContent=JSON.stringify(state); }
  function loop(){ requestAnimationFrame(loop); points.rotation.y += 0.0015*state.spinSpeed; points.rotation.x += 0.0007*state.spinSpeed; mat.opacity=state.particleOpacity; mat.color.set(state.keyLightColor); renderer.toneMappingExposure=state.brightness; renderer.render(scene,camera); }
  loop(); persist();
  window.__htmlPptScene = {
    getParams: function(){ return [
      {key:'spinSpeed',label:'Spin speed',type:'number',value:state.spinSpeed,min:0,max:3,step:0.1},
      {key:'particleOpacity',label:'Particle density',type:'number',value:state.particleOpacity,min:0,max:1,step:0.05},
      {key:'keyLightColor',label:'Key light color',type:'color',value:state.keyLightColor},
      {key:'fillLightColor',label:'Fill light color',type:'color',value:state.fillLightColor},
      {key:'brightness',label:'Brightness',type:'number',value:state.brightness,min:0.3,max:2,step:0.05}
    ]; },
    setParam: function(k,v){ if(!(k in state)) return false; state[k]=v; persist(); return true; }
  };
})();
`;
}
