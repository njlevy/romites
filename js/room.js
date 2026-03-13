/**
 * room.js — Three.js white 3D room with a grid texture.
 * Creates an empty room (floor + 3 walls) with a subtle grid pattern,
 * soft lighting, and mouse-following camera.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.163.0/build/three.module.js';

export function initRoom(container) {
  /* ---- renderer ---- */
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setClearColor(0xf5f5f5);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  /* ---- scene ---- */
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xf5f5f5, 14, 30);

  /* ---- responsive camera config (smooth interpolation) ---- */
  function getResponsiveConfig() {
    const w = window.innerWidth;
    // Lerp helper: clamp t to 0–1 then interpolate a→b
    const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

    // Mobile (<=400) → Tablet (768) → Desktop (>=1200)
    const mobileW = 400, tabletW = 768, desktopW = 1200;

    // Config at each anchor point
    const mobile  = { fov: 75, baseZ: 12, rangeX: 0.8, rangeY: 0.4 };
    const tablet  = { fov: 62, baseZ: 10, rangeX: 1.5, rangeY: 0.6 };
    const desktop = { fov: 50, baseZ: 8,  rangeX: 3,   rangeY: 1.2 };

    if (w <= mobileW) return mobile;
    if (w >= desktopW) return desktop;

    // Interpolate between anchors
    const from = w < tabletW ? mobile : tablet;
    const to   = w < tabletW ? tablet : desktop;
    const minW = w < tabletW ? mobileW : tabletW;
    const maxW = w < tabletW ? tabletW : desktopW;
    const t = (w - minW) / (maxW - minW);

    return {
      fov:    lerp(from.fov, to.fov, t),
      baseZ:  lerp(from.baseZ, to.baseZ, t),
      rangeX: lerp(from.rangeX, to.rangeX, t),
      rangeY: lerp(from.rangeY, to.rangeY, t),
    };
  }

  let config = getResponsiveConfig();

  /* ---- camera ---- */
  const camera = new THREE.PerspectiveCamera(
    config.fov,
    container.clientWidth / container.clientHeight,
    0.1,
    100
  );
  camera.position.set(0, 3.5, config.baseZ);
  camera.lookAt(0, 1.5, 0);

  /* ---- grid texture (procedural) ---- */
  function makeGridTexture(size = 512, divisions = 16, lineColor = '#d0d0d0', bgColor = '#fafafa') {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    const step = size / divisions;
    for (let i = 0; i <= divisions; i++) {
      const pos = i * step;
      ctx.beginPath(); ctx.moveTo(pos, 0); ctx.lineTo(pos, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, pos); ctx.lineTo(size, pos); ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  const gridTex = makeGridTexture();
  gridTex.repeat.set(10, 10);

  const wallTex = makeGridTexture(512, 16, '#e0e0e0', '#fdfdfd');
  wallTex.repeat.set(7, 4);

  const matFloor = new THREE.MeshStandardMaterial({
    map: gridTex,
    roughness: 0.85,
    metalness: 0.0,
  });

  const matWall = new THREE.MeshStandardMaterial({
    map: wallTex,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });

  /* ---- room geometry ---- */
  const roomW = 40, roomD = 40, roomH = 24;

  // Floor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomD), matFloor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Back wall
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomH), matWall);
  backWall.position.set(0, roomH / 2, -roomD / 2);
  backWall.receiveShadow = true;
  scene.add(backWall);

  // Left wall
  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, roomH), matWall);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-roomW / 2, roomH / 2, 0);
  leftWall.receiveShadow = true;
  scene.add(leftWall);

  // Right wall
  const rightWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, roomH), matWall);
  rightWall.rotation.y = -Math.PI / 2;
  rightWall.position.set(roomW / 2, roomH / 2, 0);
  rightWall.receiveShadow = true;
  scene.add(rightWall);

  /* ---- lights ---- */
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambient);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(4, 8, 6);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 30;
  dirLight.shadow.camera.left = -10;
  dirLight.shadow.camera.right = 10;
  dirLight.shadow.camera.top = 10;
  dirLight.shadow.camera.bottom = -10;
  scene.add(dirLight);

  const fillLight = new THREE.PointLight(0xfff5ee, 0.4, 20);
  fillLight.position.set(-3, 5, 3);
  scene.add(fillLight);

  /* ---- onBeforeRender callbacks ---- */
  const beforeRenderCallbacks = [];

  /* ---- mouse-follow camera ---- */
  let mouseX = 0, mouseY = 0;
  let smoothX = 0, smoothY = 0;

  container.addEventListener('mousemove', (e) => {
    const rect = container.getBoundingClientRect();
    mouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseY = ((e.clientY - rect.top) / rect.height) * 2 - 1;
  });

  container.addEventListener('mouseleave', () => {
    mouseX = 0;
    mouseY = 0;
  });

  function animate() {
    requestAnimationFrame(animate);
    smoothX += (mouseX - smoothX) * 0.05;
    smoothY += (mouseY - smoothY) * 0.05;

    camera.position.x = smoothX * config.rangeX;
    camera.position.y = 3.5 - smoothY * config.rangeY;
    camera.position.z = config.baseZ;
    camera.lookAt(0, 1.5, 0);

    // Run registered callbacks
    for (const cb of beforeRenderCallbacks) cb();

    renderer.render(scene, camera);
  }
  animate();

  /* ---- resize (debounced) ---- */
  let resizeTimer = null;
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      config = getResponsiveConfig();
      camera.fov = config.fov;
      camera.position.z = config.baseZ;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    }, 150);
  }
  window.addEventListener('resize', onResize);

  return {
    scene,
    camera,
    renderer,
    onBeforeRender: (cb) => beforeRenderCallbacks.push(cb),
  };
}
