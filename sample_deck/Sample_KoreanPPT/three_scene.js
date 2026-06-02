/* ========================================
   복순도가 PPT v2 - Three.js 3D Scene
   라이트 배경에 맞춘 옹기 (어두운 흙색)
   ======================================== */

(function () {
  let scene, camera, renderer, jar, particles;
  let mouseX = 0, mouseY = 0;
  let isActive = false;
  let animationId = null;
  let container = null;

  function init() {
    container = document.getElementById('three-canvas-container');
    if (!container) return;

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xF8F6F1, 0.03);

    const aspect = container.clientWidth / container.clientHeight;
    camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 100);
    camera.position.set(0, 0.5, 8);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // Lighting (라이트 모드용)
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xC19A6B, 1.2);
    keyLight.position.set(4, 6, 5);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
    fillLight.position.set(-4, 2, 3);
    scene.add(fillLight);

    const rimLight = new THREE.PointLight(0x8a7544, 1.0, 15);
    rimLight.position.set(-2, 4, -3);
    scene.add(rimLight);

    // ========================================
    // 옹기 (Korean Onggi) - 어두운 흙색 / 라이트 배경용
    // ========================================
    const profile = [
      [0.0, -2.0], [0.7, -1.95], [1.1, -1.7], [1.45, -1.3],
      [1.7, -0.7], [1.85, 0.0], [1.85, 0.6], [1.7, 1.2],
      [1.4, 1.6], [1.05, 1.8], [0.85, 1.85], [0.7, 1.9],
      [0.55, 1.92], [0.55, 2.05], [0.7, 2.05],
    ];
    const profilePoints = profile.map(([x, y]) => new THREE.Vector2(x, y));
    const jarGeo = new THREE.LatheGeometry(profilePoints, 64);
    const jarMat = new THREE.MeshStandardMaterial({
      color: 0x4a3826,
      roughness: 0.75,
      metalness: 0.1,
    });
    jar = new THREE.Mesh(jarGeo, jarMat);
    jar.position.y = -0.3;
    scene.add(jar);

    // Rim
    const rimGeo = new THREE.TorusGeometry(0.7, 0.03, 16, 100);
    const rimMat = new THREE.MeshBasicMaterial({ color: 0x8a7544, transparent: true, opacity: 0.5 });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.y = 1.75;
    rim.rotation.x = Math.PI / 2;
    jar.add(rim);

    // Subtle particles (yeast dust - 라이트 톤)
    const particleCount = 400;
    const particleGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
      const i3 = i * 3;
      const r = 3 + Math.random() * 5;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.6;
      positions[i3 + 2] = r * Math.cos(phi);

      // Warm beige dust
      colors[i3] = 0.76 + Math.random() * 0.15;
      colors[i3 + 1] = 0.60 + Math.random() * 0.15;
      colors[i3 + 2] = 0.42;
    }
    particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particleGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const particleMat = new THREE.PointsMaterial({
      size: 0.035,
      vertexColors: true,
      transparent: true,
      opacity: 0.4,
      sizeAttenuation: true,
      depthWrite: false,
    });
    particles = new THREE.Points(particleGeo, particleMat);
    scene.add(particles);

    document.addEventListener('mousemove', (e) => {
      mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
      mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    });
    window.addEventListener('resize', onResize);
  }

  function onResize() {
    if (!container || !camera || !renderer) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function animate() {
    if (!isActive) return;
    animationId = requestAnimationFrame(animate);
    const t = performance.now() * 0.001;

    if (jar) {
      jar.rotation.y += 0.003;
      jar.rotation.x += (mouseY * 0.12 - jar.rotation.x) * 0.05;
      jar.rotation.z += (-mouseX * 0.08 - jar.rotation.z) * 0.05;
      jar.position.y = -0.3 + Math.sin(t * 0.7) * 0.05;
    }

    if (particles) {
      particles.rotation.y += 0.0006;
      particles.rotation.x = Math.sin(t * 0.2) * 0.08;
    }

    camera.position.x += (mouseX * 0.4 - camera.position.x) * 0.04;
    camera.position.y += (0.5 + mouseY * -0.2 - camera.position.y) * 0.04;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  }

  window.boksoonThreeScene = {
    activate() {
      if (!scene) init();
      if (!isActive) { isActive = true; animate(); }
    },
    deactivate() {
      isActive = false;
      if (animationId) cancelAnimationFrame(animationId);
    },
  };
})();
