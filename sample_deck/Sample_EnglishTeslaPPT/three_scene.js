/* =================================================================
   TESLA · Interactive Keynote
   three_scene.js — global 3D background (Three.js r128, global build)

   A single fixed full-viewport scene renders behind the deck and only
   shows a centrepiece on slides where 3D is purposeful (title, section
   dividers, the dedicated feature slides). Content / data / grid slides
   get NO model — just the quiet ambient backdrop.

     logo       → exact Tesla mark, extruded to chrome (from its vector)
     cell       → 4680 battery cell cluster
     sedan      → sleek EV fastback silhouette
     cybertruck → faceted stainless wedge + light bars
     powerwall  → home battery unit
     none       → hide everything (ambient only)

   Models are ORIGINAL procedural geometry; the logo is extruded from
   the Tesla brand vector for an accurate silhouette. A procedural
   studio environment map gives the metals realistic reflections.

   Public API (called from script.js):
     TeslaBG.setStage(presetKey)   // camera / lights / placement mood
     TeslaBG.showModel(modelKey)   // which centrepiece (or "none")
   ================================================================= */

(function () {
  "use strict";

  if (typeof THREE === "undefined") {
    console.warn("[TeslaBG] Three.js failed to load — 3D background disabled.");
    window.TeslaBG = { setStage: function () {}, showModel: function () {}, setMode: function () {} };
    return;
  }

  const canvas = document.getElementById("bg-canvas");

  /* ---------- Renderer ---------- */
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  /* ---------- Scene & camera ---------- */
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x08080b, 0.024);

  const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 9.5);

  /* ---------- Procedural studio environment (for metal reflections) ---------- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envRT = pmrem.fromEquirectangular(makeEnvTexture());
  scene.environment = envRT.texture;

  /* ---------- Lighting (ambient + dual neon point lights + rim) ---------- */
  scene.add(new THREE.AmbientLight(0x5a648c, 0.6));

  const keyLight = new THREE.PointLight(0x37c6ff, 55, 90); // electric blue
  keyLight.position.set(-8, 7, 8);
  scene.add(keyLight);

  const fillLight = new THREE.PointLight(0xa855f7, 48, 90); // violet
  fillLight.position.set(8, -5, 5);
  scene.add(fillLight);

  const rimLight = new THREE.PointLight(0xffffff, 28, 60);
  rimLight.position.set(0, 5, -9);
  scene.add(rimLight);

  /* =================================================================
     STAGE — holds every model; tilts toward the pointer as a unit.
     ================================================================= */
  const stage = new THREE.Group();
  scene.add(stage);

  const dotTex = makeDot(); // shared sprite for the particle field
  const models = {};        // key -> { group, base, vis, target, spin0 }

  function register(key, group, base, spin0) {
    group.visible = false;
    group.scale.setScalar(0.0001);
    models[key] = { group: group, base: base, vis: 0, target: 0, spin0: spin0 || 0 };
    stage.add(group);
  }

  /* shared materials ------------------------------------------------ */
  const chrome   = new THREE.MeshStandardMaterial({ color: 0xeef2ff, metalness: 1.0, roughness: 0.14, envMapIntensity: 1.35 });
  const steel    = new THREE.MeshStandardMaterial({ color: 0xaab1bd, metalness: 0.9, roughness: 0.36, envMapIntensity: 1.0, flatShading: true });
  const aluminum = new THREE.MeshStandardMaterial({ color: 0xd6dae2, metalness: 0.9, roughness: 0.26, envMapIntensity: 1.05 });
  const darkRubber = new THREE.MeshStandardMaterial({ color: 0x0f1115, metalness: 0.25, roughness: 0.8 });
  const paint    = new THREE.MeshStandardMaterial({ color: 0x1d222c, metalness: 0.7, roughness: 0.2, envMapIntensity: 1.2 });
  const matteWhite = new THREE.MeshStandardMaterial({ color: 0xeef1f7, metalness: 0.1, roughness: 0.55, envMapIntensity: 0.6 });
  const glassDark = new THREE.MeshStandardMaterial({ color: 0x080b12, metalness: 0.6, roughness: 0.08, envMapIntensity: 1.3, transparent: true, opacity: 0.82 });
  const emCyan   = new THREE.MeshStandardMaterial({ color: 0x0b1418, emissive: 0x3fe6ff, emissiveIntensity: 2.4, metalness: 0.2, roughness: 0.4 });
  const emViolet = new THREE.MeshStandardMaterial({ color: 0x140b1c, emissive: 0xb06bff, emissiveIntensity: 2.0, metalness: 0.2, roughness: 0.4 });

  // Every model material is made translucent so the 3D blends into the
  // glassmorphism. A per-stage opacity (cur.op) scales these each frame —
  // prominent slides stay nearly solid, ambient slides go ghostly.
  const modelMats = [chrome, steel, aluminum, darkRubber, paint, matteWhite, glassDark, emCyan, emViolet].map(function (m) {
    m.transparent = true;
    return { m: m, base: m.opacity === undefined ? 1 : m.opacity };
  });

  /* =================================================================
     MODEL: Tesla mark — extruded from the exact brand vector
     ================================================================= */
  (function buildLogo() {
    const g = new THREE.Group();
    let built = false;

    if (THREE.SVGLoader) {
      try {
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="' +
          "M12 5.362l2.475-3.026s4.245.09 8.471 2.054c-1.082 1.636-3.231 2.438-3.231 2.438-.146-1.439-1.154-1.79-4.354-1.79L12 24 8.619 5.034c-3.18 0-4.211.354-4.358 1.794 0 0-2.149-.807-3.231-2.443C5.255 2.421 9.5 2.331 9.5 2.331L12 5.362z" +
          '"/></svg>';
        const data = new THREE.SVGLoader().parse(svg);
        const shapes = [];
        data.paths.forEach((p) => { p.toShapes(true).forEach((s) => shapes.push(s)); });
        const geo = new THREE.ExtrudeGeometry(shapes, {
          depth: 5.5, bevelEnabled: true, bevelThickness: 0.7, bevelSize: 0.55, bevelSegments: 5, steps: 1,
        });
        geo.applyMatrix4(new THREE.Matrix4().makeScale(1, -1, 1)); // SVG y-down → y-up
        geo.computeVertexNormals();
        geo.center();
        // normalize to ~4.6 units tall
        const size = new THREE.Box3().setFromBufferAttribute(geo.attributes.position).getSize(new THREE.Vector3());
        const k = 4.6 / Math.max(size.x, size.y);
        geo.scale(k, k, k);
        const mesh = new THREE.Mesh(geo, chrome);
        mesh.material.side = THREE.DoubleSide;
        g.add(mesh);
        built = true;
      } catch (e) {
        console.warn("[TeslaBG] vector logo failed, using fallback:", e);
      }
    }

    if (!built) {
      // fallback: simple extruded T (only used if SVGLoader is unavailable)
      const t = new THREE.Shape();
      t.moveTo(-2.5, 1.55); t.lineTo(2.5, 1.55); t.lineTo(2.5, 0.78);
      t.lineTo(0.46, 0.78); t.lineTo(0.3, -3.5); t.lineTo(-0.3, -3.5);
      t.lineTo(-0.46, 0.78); t.lineTo(-2.5, 0.78); t.closePath();
      const geo = new THREE.ExtrudeGeometry(t, { depth: 0.9, bevelEnabled: true, bevelThickness: 0.14, bevelSize: 0.14, bevelSegments: 4 });
      geo.center();
      g.add(new THREE.Mesh(geo, chrome));
    }

    register("logo", g, 0.95, 0.16);
  })();

  /* =================================================================
     MODEL: 4680 battery cell cluster
     ================================================================= */
  (function buildCell() {
    const g = new THREE.Group();
    function cell(scale) {
      const c = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 2.5, 60, 1), aluminum);
      c.add(body);
      const topRing = new THREE.Mesh(new THREE.TorusGeometry(0.96, 0.09, 18, 60), chrome);
      topRing.rotation.x = Math.PI / 2; topRing.position.y = 1.2; c.add(topRing);
      const term = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.22, 40), chrome);
      term.position.y = 1.32; c.add(term);
      [0.6, 0, -0.6].forEach((y) => {
        const seam = new THREE.Mesh(new THREE.TorusGeometry(1.006, 0.02, 8, 70), emCyan);
        seam.rotation.x = Math.PI / 2; seam.position.y = y; c.add(seam);
      });
      c.scale.setScalar(scale);
      return c;
    }
    const main = cell(1.0); g.add(main);
    const b = cell(0.82); b.position.set(-1.95, -0.35, -1.1); g.add(b);
    const cc = cell(0.7); cc.position.set(1.75, 0.3, -1.4); g.add(cc);
    register("cell", g, 1.0, 0.18);
  })();

  /* =================================================================
     MODEL: Cybertruck (faceted stainless wedge)
     ================================================================= */
  (function buildCybertruck() {
    const g = new THREE.Group();
    const W = 3.4;

    // sharp wedge profile (front at -x)
    const p = new THREE.Shape();
    p.moveTo(-4.9, -0.55);
    p.lineTo(-4.7, 0.12);
    p.lineTo(-0.7, 1.78);  // apex (windshield top)
    p.lineTo(2.6, 1.42);   // cabin/bed rail
    p.lineTo(4.9, 0.42);   // tail top
    p.lineTo(4.9, -0.55);
    p.closePath();
    const bodyGeo = new THREE.ExtrudeGeometry(p, { depth: W, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 1 });
    bodyGeo.center();
    const body = new THREE.Mesh(bodyGeo, steel);
    body.material.side = THREE.DoubleSide;
    g.add(body);

    // greenhouse glass (dark trapezoid)
    const w = new THREE.Shape();
    w.moveTo(-2.5, 0.55); w.lineTo(-0.6, 1.6); w.lineTo(2.25, 1.28); w.lineTo(2.3, 0.62); w.closePath();
    const wGeo = new THREE.ExtrudeGeometry(w, { depth: W + 0.06, bevelEnabled: false });
    wGeo.center();
    g.add(new THREE.Mesh(wGeo, glassDark));

    // signature full-width light bars
    const lbF = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, W + 0.04), emCyan);
    lbF.position.set(-4.72, 0.16, 0); g.add(lbF);
    const lbR = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, W + 0.04), emCyan);
    lbR.position.set(4.88, 0.4, 0); g.add(lbR);

    // large wheels with bright rims
    [[-3.05, 1], [3.05, 1], [-3.05, -1], [3.05, -1]].forEach(([x, side]) => {
      const z = side * (W / 2 + 0.02);
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.94, 0.94, 0.5, 30), darkRubber);
      tire.rotation.x = Math.PI / 2; tire.position.set(x, -0.9, z); g.add(tire);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.07, 12, 30), chrome);
      rim.rotation.y = Math.PI / 2; rim.position.set(x, -0.9, z + side * 0.22); g.add(rim);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.52, 24), steel);
      hub.rotation.x = Math.PI / 2; hub.position.set(x, -0.9, z); g.add(hub);
    });

    register("cybertruck", g, 0.5, 0.13);
  })();

  /* =================================================================
     MODEL: Sleek EV fastback (profile-sculpted)
     ================================================================= */
  (function buildSedan() {
    const g = new THREE.Group();
    const W = 3.0;

    const s = new THREE.Shape();
    s.moveTo(-4.6, -0.5);
    s.lineTo(-4.6, 0.02);
    s.quadraticCurveTo(-3.9, 0.12, -3.2, 0.34);  // hood
    s.quadraticCurveTo(-2.3, 0.5, -1.7, 0.78);   // cowl / A-pillar base
    s.quadraticCurveTo(-0.9, 1.08, 0.15, 1.14);  // roof peak (low, forward)
    s.quadraticCurveTo(1.9, 1.12, 3.05, 0.6);    // long fastback
    s.quadraticCurveTo(3.95, 0.42, 4.6, 0.32);   // decklid
    s.lineTo(4.6, -0.5);
    s.closePath();
    const bodyGeo = new THREE.ExtrudeGeometry(s, { depth: W, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 5 });
    bodyGeo.center();
    const body = new THREE.Mesh(bodyGeo, paint);
    body.material.side = THREE.DoubleSide;
    g.add(body);

    // greenhouse glass
    const win = new THREE.Shape();
    win.moveTo(-1.65, 0.74);
    win.quadraticCurveTo(-0.9, 1.0, 0.15, 1.04);
    win.quadraticCurveTo(1.7, 1.02, 2.7, 0.66);
    win.lineTo(2.3, 0.58);
    win.lineTo(-1.5, 0.6);
    win.closePath();
    const winGeo = new THREE.ExtrudeGeometry(win, { depth: W + 0.06, bevelEnabled: false });
    winGeo.center();
    g.add(new THREE.Mesh(winGeo, glassDark));

    // wheels with bright hubs
    [[-2.7, 1], [2.7, 1], [-2.7, -1], [2.7, -1]].forEach(([x, side]) => {
      const z = side * (W / 2 + 0.0);
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.4, 32), darkRubber);
      tire.rotation.x = Math.PI / 2; tire.position.set(x, -0.5, z); g.add(tire);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.44, 28), aluminum);
      hub.rotation.x = Math.PI / 2; hub.position.set(x, -0.5, z); g.add(hub);
    });

    // full-width light bars front + rear
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, W * 0.78), emCyan);
    head.position.set(-4.5, -0.04, 0); g.add(head);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, W * 0.82), emViolet);
    tail.position.set(4.52, 0.04, 0); g.add(tail);

    register("sedan", g, 0.55, 0.14);
  })();

  /* =================================================================
     MODEL: Powerwall (home battery)
     ================================================================= */
  (function buildPowerwall() {
    const g = new THREE.Group();
    const wd = 2.3, ht = 4.6, r = 0.55;
    const rr = new THREE.Shape();
    rr.moveTo(-wd + r, -ht);
    rr.lineTo(wd - r, -ht);
    rr.quadraticCurveTo(wd, -ht, wd, -ht + r);
    rr.lineTo(wd, ht - r);
    rr.quadraticCurveTo(wd, ht, wd - r, ht);
    rr.lineTo(-wd + r, ht);
    rr.quadraticCurveTo(-wd, ht, -wd, ht - r);
    rr.lineTo(-wd, -ht + r);
    rr.quadraticCurveTo(-wd, -ht, -wd + r, -ht);
    const slabGeo = new THREE.ExtrudeGeometry(rr, { depth: 0.95, bevelEnabled: true, bevelThickness: 0.14, bevelSize: 0.14, bevelSegments: 3 });
    slabGeo.scale(0.82, 0.82, 1); slabGeo.center();
    g.add(new THREE.Mesh(slabGeo, matteWhite));

    const panel = new THREE.Mesh(new THREE.BoxGeometry(2.55, 3.7, 0.06), glassDark);
    panel.position.set(-0.1, 0.1, 0.62); g.add(panel);

    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.9, 0.05), emCyan);
    strip.position.set(0.82, 0.25, 0.64); g.add(strip);

    g.rotation.y = -0.5;
    register("powerwall", g, 0.62, 0.12);
  })();

  /* =================================================================
     PARTICLE FIELD — quiet ambient "nebula" (always present, subtle)
     ================================================================= */
  const P_COUNT = 2200;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(P_COUNT * 3);
  const pCol = new Float32Array(P_COUNT * 3);
  const cA = new THREE.Color(0x38bdf8), cB = new THREE.Color(0xa855f7);
  for (let i = 0; i < P_COUNT; i++) {
    const r = 10 + Math.pow(frand(i * 0.91 + 5.3), 1.6) * 22;
    const theta = Math.acos(2 * frand(i * 1.3) - 1);
    const phi = frand(i * 2.7) * Math.PI * 2;
    pPos[i * 3] = r * Math.sin(theta) * Math.cos(phi);
    pPos[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
    pPos[i * 3 + 2] = r * Math.cos(theta);
    const c = cA.clone().lerp(cB, frand(i * 4.1));
    pCol[i * 3] = c.r; pCol[i * 3 + 1] = c.g; pCol[i * 3 + 2] = c.b;
  }
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
  const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
    size: 0.13, map: dotTex, vertexColors: true, transparent: true, opacity: 0.6,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  scene.add(particles);

  /* =================================================================
     OPTIONAL — load your own .glb model
     ----------------------------------------------------------------
     1) Uncomment the GLTFLoader <script> tag in index.html.
     2) Place e.g. "tesla.glb" next to these files.
     3) Uncomment below, then call TeslaBG.showModel('glb') from
        script.js (e.g. map a slide to "glb" in MODEL_BY_INDEX).
     -----------------------------------------------------------------
     const loader = new THREE.GLTFLoader();
     loader.load("tesla.glb", function (gltf) {
       const m = gltf.scene;
       const box = new THREE.Box3().setFromObject(m);
       const k = 4.6 / Math.max(...box.getSize(new THREE.Vector3()).toArray());
       m.scale.setScalar(k);
       const c = box.getCenter(new THREE.Vector3());
       m.position.sub(c.multiplyScalar(k));
       register("glb", m, 1.0, 0.14);
     }, undefined, function (err) { console.error("[TeslaBG] GLB load failed:", err); });
     ================================================================= */

  /* =================================================================
     STAGE PRESETS — camera / light / placement mood per slide
     (spin values intentionally gentle)
     ================================================================= */
  // op = model opacity. Prominent slides (hero / feature / divider) stay
  // nearly solid; ambient slides (tech / calm / energy) shrink to a back
  // corner and go ghostly so the 3D quietly rotates behind the content.
  const PRESETS = {
    hero:      { x:  3.1, y:  0.0, scale: 1.1,  spin: 0.8, key: 55, fill: 48, parts: 0.7,  fov: 52, op: 0.90 },
    techFocus: { x:  3.5, y:  0.0, scale: 1.4,  spin: 0.9, key: 78, fill: 68, parts: 0.55, fov: 50, op: 0.92 },
    section:   { x:  3.6, y:  0.1, scale: 1.25, spin: 0.65,key: 68, fill: 58, parts: 0.6,  fov: 50, op: 0.86 },
    tech:      { x:  4.7, y:  0.7, scale: 0.72, spin: 0.6, key: 58, fill: 50, parts: 0.4,  fov: 54, op: 0.40 },
    calm:      { x:  5.1, y: -1.2, scale: 0.62, spin: 0.5, key: 45, fill: 36, parts: 0.32, fov: 55, op: 0.30 },
    energy:    { x:  4.7, y:  0.6, scale: 0.74, spin: 0.6, key: 50, fill: 62, parts: 0.42, fov: 54, op: 0.42 },
    closing:   { x:  2.9, y:  0.2, scale: 1.15, spin: 0.5, key: 78, fill: 70, parts: 0.7,  fov: 50, op: 0.55 },
  };

  let target = Object.assign({}, PRESETS.hero);
  const cur = Object.assign({}, PRESETS.hero);
  let currentModel = "logo";
  models.logo.target = 1;

  window.TeslaBG = {
    setStage: function (name) { target = PRESETS[name] || PRESETS.calm; },
    showModel: function (key) {
      if (!key || !models[key]) key = "none";
      if (key === currentModel) return;
      currentModel = key;
      Object.keys(models).forEach((k) => { models[k].target = k === key ? 1 : 0; });
    },
    setMode: function (name) { this.setStage(name); }, // back-compat alias
  };

  /* ---------- Pointer parallax ---------- */
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  window.addEventListener("pointermove", function (e) {
    pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
  });

  /* ---------- Resize ---------- */
  window.addEventListener("resize", function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* ---------- Render loop ---------- */
  let t = 0;
  function animate() {
    requestAnimationFrame(animate);
    t += 0.016;

    const k = 0.05;
    cur.x += (target.x - cur.x) * k;
    cur.y += (target.y - cur.y) * k;
    cur.scale += (target.scale - cur.scale) * k;
    cur.spin += (target.spin - cur.spin) * k;
    cur.key += (target.key - cur.key) * k;
    cur.fill += (target.fill - cur.fill) * k;
    cur.parts += (target.parts - cur.parts) * k;
    cur.fov += (target.fov - cur.fov) * k;
    cur.op += (target.op - cur.op) * k;

    // blend the 3D into the glassmorphism via translucency
    for (let i = 0; i < modelMats.length; i++) {
      modelMats[i].m.opacity = modelMats[i].base * cur.op;
    }

    pointer.x += (pointer.tx - pointer.x) * 0.05;
    pointer.y += (pointer.ty - pointer.y) * 0.05;

    // place + gently tilt the stage toward the pointer
    stage.position.set(cur.x, cur.y, 0);
    stage.rotation.x = pointer.y * 0.22;
    stage.rotation.y = pointer.x * 0.26;

    // per-model show/hide (scale-based swap) + slow self-rotation
    Object.keys(models).forEach((key) => {
      const m = models[key];
      m.vis += (m.target - m.vis) * 0.08;
      const s = m.base * cur.scale * easeBack(m.vis);
      m.group.scale.setScalar(Math.max(s, 0.0001));
      m.group.visible = m.vis > 0.004;
      if (m.group.visible) {
        m.group.rotation.y += m.spin0 * cur.spin * 0.016;
        m.group.position.y = Math.sin(t * 0.4 + m.base * 6) * 0.12; // gentle float
      }
    });

    // living neon lights (slow orbit)
    keyLight.intensity = cur.key;
    fillLight.intensity = cur.fill;
    keyLight.position.x = Math.cos(t * 0.2) * 8;
    keyLight.position.z = Math.sin(t * 0.2) * 8 + 2;
    fillLight.position.x = Math.cos(t * 0.2 + Math.PI) * 8;
    particles.material.opacity = cur.parts;
    particles.rotation.y += 0.0002;
    particles.rotation.x += 0.0001;

    // camera parallax + eased fov
    camera.position.x += (pointer.x * 0.5 - camera.position.x) * 0.04;
    camera.position.y += (-pointer.y * 0.35 - camera.position.y) * 0.04;
    camera.fov += (cur.fov - camera.fov) * 0.05;
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  }
  animate();

  /* =================================================================
     Helpers
     ================================================================= */
  function easeBack(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    const c = 1.4;
    return 1 + (c + 1) * Math.pow(v - 1, 3) + c * Math.pow(v - 1, 2);
  }

  function frand(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  function makeEnvTexture() {
    const c = document.createElement("canvas"); c.width = 64; c.height = 256;
    const ctx = c.getContext("2d");
    const grd = ctx.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0.0, "#dff0ff");
    grd.addColorStop(0.34, "#2b3650");
    grd.addColorStop(0.55, "#0a0a0e");
    grd.addColorStop(0.78, "#3a1b5e");
    grd.addColorStop(1.0, "#0b0712");
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 64, 256);
    ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(0, 16, 64, 9);   // bright studio strip
    ctx.fillStyle = "rgba(130,205,255,0.55)"; ctx.fillRect(0, 72, 64, 5);
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    return tex;
  }

  function makeDot() {
    const s = 64, cv = document.createElement("canvas"); cv.width = cv.height = s;
    const ctx = cv.getContext("2d");
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.85)");
    g.addColorStop(0.55, "rgba(255,255,255,0.25)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(cv); tex.needsUpdate = true; return tex;
  }
})();
