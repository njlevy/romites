/**
 * gallery3d.js — Populates the Three.js room with artist avatar planes.
 *
 * Avatars stand upright on the floor, facing the camera (4th wall).
 * Positions are loaded from avatar-positions.json (keyed by slug).
 * Artists not in the JSON get a default grid position.
 *
 * Editor mode (?editor=1): drag avatars to reposition, then save JSON.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.163.0/build/three.module.js';
import { toSlug } from './data.js';

/* ================================================================
   CONFIG
   ================================================================ */
const AVATAR_H = 1.4;

/** Hover effect config — editable via ?editor=1 panel, saved to JSON */
const hoverConfig = {
  glowSize:       1.5,   // glow plane multiplier relative to avatar size
  glowOpacity:    1.0,   // peak glow intensity (0–1)
  scaleGrowth:    1.08,  // hovered avatar scale multiplier (1 = no growth)
  dimOpacity:     0.3,   // opacity of non-hovered avatars (0–1)
  pulseSpeed:     1.8,   // glow animation speed
  pulseAmount:    0.25,  // glow pulse amplitude (0 = steady, 0.5 = dramatic)
  pixelGrid:      24.0,  // pixel grid resolution (fewer = bigger squares)
  pixelSpread:    0.4,   // how far pixels drift outward from silhouette (0–1)
  pixelSpeed:     1.2,   // speed pixels travel outward
  pixelSizeVar:   0.5,   // size variation between pixels (0 = uniform, 1 = very varied)
  pixelDensity:   0.6,   // fraction of grid cells that emit (0–1)
  pixelFade:      0.5,   // how much pixels fade as they drift (0 = no fade, 1 = full)
  pixelBright:    2.0,   // brightness multiplier for pixel emission (1 = normal, 3 = very bright)
};

/* ================================================================
   POSITION LOADING
   ================================================================ */
async function loadPositions() {
  try {
    const r = await fetch('./js/avatar-positions.json?' + Date.now());
    if (!r.ok) return {};
    const data = await r.json();
    // Restore hover config if saved
    if (data.__hoverConfig) {
      Object.assign(hoverConfig, data.__hoverConfig);
      delete data.__hoverConfig;
    }
    return data;
  } catch { return {}; }
}

/** Fallback: arrange in a grid if no saved position */
function gridFallback(index, total) {
  const cols = Math.ceil(Math.sqrt(total));
  const spacing = 2.2;
  const col = index % cols;
  const row = Math.floor(index / cols);
  const offsetX = -(cols - 1) * spacing / 2;
  const offsetZ = -(Math.ceil(total / cols) - 1) * spacing / 2;
  return { x: offsetX + col * spacing, z: offsetZ + row * spacing };
}

function getPosition(slug, index, total, savedPositions) {
  const base = savedPositions[slug] || gridFallback(index, total);
  return { x: base.x || 0, z: base.z || 0, y: base.y || 0, scale: base.scale || 1 };
}

/* ================================================================
   TEXTURE LOADING
   ================================================================ */
function driveToLh3(url) {
  if (!url) return '';
  // If already a proxy URL, use as-is
  if (url.startsWith('/img-proxy')) return url;
  let directUrl = '';
  if (url.includes('lh3.googleusercontent.com')) {
    directUrl = url;
  } else {
    const m = url.match(/[?&]id=([^&]+)/);
    if (m) directUrl = `https://lh3.googleusercontent.com/d/${m[1]}=w800`;
    const m2 = url.match(/\/d\/([^/?]+)/);
    if (!directUrl && m2) directUrl = `https://lh3.googleusercontent.com/d/${m2[1]}=w800`;
    if (!directUrl) directUrl = url;
  }
  return `/img-proxy?url=${encodeURIComponent(directUrl)}`;
}

function loadTextureFromURL(url, retries = 5) {
  const lh3Url = driveToLh3(url);
  if (!lh3Url) return Promise.resolve(null);

  function attempt(n, delay) {
    return new Promise((resolve) => {
      const img = new Image();
      // No crossOrigin needed for local proxy URLs
      if (!lh3Url.startsWith('/')) img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        const aspect = img.naturalWidth / img.naturalHeight;
        resolve({ tex, aspect, img });
      };
      img.onerror = () => {
        if (n > 1) {
          setTimeout(() => {
            attempt(n - 1, delay * 1.5).then(resolve);
          }, delay);
        } else {
          resolve(null);
        }
      };
      // For proxy URLs, use & since they already have ?url=
      const sep = lh3Url.includes('?') ? '&' : '?';
      if (n === retries) {
        img.src = lh3Url;
      } else {
        img.src = lh3Url + sep + '_t=' + Date.now();
      }
    });
  }

  return attempt(retries, 1000);
}

/* ================================================================
   GLOW MAP + MATERIAL
   ================================================================ */
function generateGlowMap(img) {
  try {
    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;

    // 1. Copy image to a fresh canvas to avoid tainting the original
    const copyCanvas = document.createElement('canvas');
    copyCanvas.width = srcW; copyCanvas.height = srcH;
    const copyCtx = copyCanvas.getContext('2d');
    copyCtx.drawImage(img, 0, 0);

    // 2. White silhouette — keep alpha, set RGB to white
    let imgData;
    try {
      imgData = copyCtx.getImageData(0, 0, srcW, srcH);
    } catch {
      // CORS tainted — fall back to simple blurred copy (no silhouette extraction)
      return generateGlowMapFallback(img);
    }
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = 255;
    }
    copyCtx.putImageData(imgData, 0, 0);

    // 3. Pixelate by drawing to a tiny canvas
    const pixW = 32;
    const pixH = Math.round(32 * (srcH / srcW));
    const pixCanvas = document.createElement('canvas');
    pixCanvas.width = pixW; pixCanvas.height = pixH;
    const pixCtx = pixCanvas.getContext('2d');
    pixCtx.imageSmoothingEnabled = true;
    pixCtx.drawImage(copyCanvas, 0, 0, pixW, pixH);

    // 4. Upscale with nearest-neighbor + blur for soft glow spread
    const outW = 128;
    const outH = Math.round(128 * (srcH / srcW));
    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW; outCanvas.height = outH;
    const outCtx = outCanvas.getContext('2d');
    outCtx.imageSmoothingEnabled = false;
    // First pass: full-opacity base
    outCtx.globalAlpha = 1.0;
    outCtx.drawImage(pixCanvas, 0, 0, outW, outH);
    // Additional blur passes to spread the glow
    if (typeof outCtx.filter !== 'undefined') {
      outCtx.filter = 'blur(4px)';
    }
    for (let pass = 0; pass < 3; pass++) {
      outCtx.globalAlpha = 0.7;
      outCtx.drawImage(outCanvas, 0, 0);
    }
    outCtx.filter = 'none';
    outCtx.globalAlpha = 1.0;

    const tex = new THREE.CanvasTexture(outCanvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    return tex;
  } catch {
    return null;
  }
}

/** Fallback if getImageData fails (CORS) — just blur the image directly */
function generateGlowMapFallback(img) {
  const outW = 128;
  const outH = Math.round(128 * (img.naturalHeight / img.naturalWidth));
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW; outCanvas.height = outH;
  const outCtx = outCanvas.getContext('2d');
  outCtx.imageSmoothingEnabled = false;
  // Full-opacity base
  outCtx.globalAlpha = 1.0;
  outCtx.drawImage(img, 0, 0, outW, outH);
  // Blur passes
  if (typeof outCtx.filter !== 'undefined') {
    outCtx.filter = 'blur(6px)';
  }
  for (let pass = 0; pass < 3; pass++) {
    outCtx.globalAlpha = 0.7;
    outCtx.drawImage(outCanvas, 0, 0);
  }
  outCtx.filter = 'none';
  outCtx.globalAlpha = 1.0;
  const tex = new THREE.CanvasTexture(outCanvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  return tex;
}

function createGlowMaterial(glowMapTex, hexColor) {
  const c = new THREE.Color(hexColor);
  return new THREE.ShaderMaterial({
    uniforms: {
      glowMap:       { value: glowMapTex },
      glowColor:     { value: new THREE.Vector3(c.r, c.g, c.b) },
      glowIntensity: { value: 0.0 },
      time:          { value: 0.0 },
      pulseSpeed:    { value: hoverConfig.pulseSpeed },
      pulseAmount:   { value: hoverConfig.pulseAmount },
      pixelGrid:     { value: hoverConfig.pixelGrid },
      pixelSpread:   { value: hoverConfig.pixelSpread },
      pixelSpeed:    { value: hoverConfig.pixelSpeed },
      pixelSizeVar:  { value: hoverConfig.pixelSizeVar },
      pixelDensity:  { value: hoverConfig.pixelDensity },
      pixelFade:     { value: hoverConfig.pixelFade },
      pixelBright:   { value: hoverConfig.pixelBright },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D glowMap;
      uniform vec3 glowColor;
      uniform float glowIntensity;
      uniform float time;
      uniform float pulseSpeed;
      uniform float pulseAmount;
      uniform float pixelGrid;
      uniform float pixelSpread;
      uniform float pixelSpeed;
      uniform float pixelSizeVar;
      uniform float pixelDensity;
      uniform float pixelFade;
      uniform float pixelBright;

      varying vec2 vUv;

      // Hash functions for pseudo-random per-cell values
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float hash2(vec2 p) {
        return fract(sin(dot(p, vec2(269.5, 183.3))) * 27163.8291);
      }

      void main() {
        // Base silhouette alpha from glow map
        float silhouette = texture2D(glowMap, vUv).a;

        // --- Pixel grid ---
        vec2 gridUv = vUv * pixelGrid;
        vec2 cellId = floor(gridUv);
        vec2 cellUv = fract(gridUv);

        // Per-cell random values
        float rnd      = hash(cellId);           // density gate + phase
        float rndSize  = hash2(cellId);           // size variation
        float rndPhase = hash(cellId + 42.0);     // time phase offset
        float rndDir   = hash2(cellId + 17.0);    // drift direction variation

        // Density: only some cells emit pixels
        float cellActive = step(1.0 - pixelDensity, rnd);

        // Sample silhouette at cell center to know if this cell is near the shape
        vec2 cellCenter = (cellId + 0.5) / pixelGrid;
        float cellSilhouette = texture2D(glowMap, cellCenter).a;

        // Per-pixel size: varies between 0.3 and 1.0 of the cell
        float sizeMin = 1.0 - pixelSizeVar * 0.7;
        float pixSize = mix(sizeMin, 1.0, rndSize);

        // Square mask: is the fragment inside this cell's pixel?
        float halfPix = pixSize * 0.5;
        vec2 dist = abs(cellUv - 0.5);
        float inSquare = step(dist.x, halfPix) * step(dist.y, halfPix);

        // --- Outward drift animation ---
        // Direction: from center of plane outward
        vec2 center = vec2(0.5);
        vec2 dirFromCenter = normalize(cellCenter - center + vec2(0.001));
        // Add per-cell angle jitter
        float angle = (rndDir - 0.5) * 1.2;
        vec2 driftDir = vec2(
          dirFromCenter.x * cos(angle) - dirFromCenter.y * sin(angle),
          dirFromCenter.x * sin(angle) + dirFromCenter.y * cos(angle)
        );

        // Time offset per cell for staggered animation
        float t = time * pixelSpeed + rndPhase * 6.28;
        float driftCycle = fract(t * 0.15);  // 0→1 repeating cycle

        // Drift amount: pixels near silhouette edge travel outward
        float driftDist = driftCycle * pixelSpread;

        // Sample silhouette at the un-drifted position (where the pixel came from)
        vec2 sourceUv = cellCenter - driftDir * driftDist;
        float sourceSilhouette = texture2D(glowMap, sourceUv).a;

        // Boost: treat any silhouette alpha > 0.05 as fully solid for pixel emission
        float emitStrength = smoothstep(0.05, 0.15, sourceSilhouette) * cellActive;

        // Fade as pixels travel outward
        float fadeFactor = 1.0 - driftCycle * pixelFade;
        fadeFactor = max(fadeFactor, 0.0);

        // Pulse modulation
        float pulse = (1.0 - pulseAmount) + pulseAmount * sin(t * pulseSpeed + cellId.y * 0.5);

        // Final alpha: pixel squares only, boosted by brightness
        float pixelAlpha = emitStrength * inSquare * fadeFactor * pulse * pixelBright;
        float finalAlpha = clamp(pixelAlpha * glowIntensity, 0.0, 1.0);

        gl_FragColor = vec4(glowColor, finalAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/* ================================================================
   LOGO PLANE
   ================================================================ */
function createLogoPlane() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Transparent background with bold text
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = '700 80px "Space Grotesk", system-ui, sans-serif';
  ctx.fillStyle = '#222';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ROMITES', 256, 128);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;

  const aspect = canvas.width / canvas.height;
  const h = 1.6;
  const w = h * aspect;
  const geo = new THREE.PlaneGeometry(w, h);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, 4.5, 0);
  return mesh;
}

/* ================================================================
   TOOLTIP
   ================================================================ */
function createTooltip(container) {
  const el = document.createElement('div');
  el.className = 'room-tooltip';
  el.style.display = 'none';
  container.appendChild(el);
  return el;
}

/* ================================================================
   EDITOR MODE
   ================================================================ */
function isEditorMode() {
  return new URLSearchParams(window.location.search).has('editor');
}

function buildEditorPanel(container, avatarStates, camera, savedPositions, renderer) {
  const panel = document.createElement('div');
  panel.className = 'gallery-editor';
  panel.innerHTML = `
    <div class="gallery-editor-header">
      <h3>Avatar Positions</h3>
      <div class="gallery-editor-buttons">
        <button id="ge-save" class="ge-btn">Save JSON</button>
        <button id="ge-reset" class="ge-btn ge-btn-secondary">Reset</button>
      </div>
    </div>
    <div class="ge-hover-section" id="ge-hover-section">
      <div class="ge-hover-title">Hover Effects</div>
      <div class="ge-hover-grid">
        <label class="ge-hover-label">Glow Size
          <input type="range" min="1" max="3" step="0.05" class="ge-range" id="ge-glowSize" value="${hoverConfig.glowSize}" />
          <span class="ge-range-val" id="ge-glowSize-val">${hoverConfig.glowSize}</span>
        </label>
        <label class="ge-hover-label">Glow Opacity
          <input type="range" min="0" max="1" step="0.05" class="ge-range" id="ge-glowOpacity" value="${hoverConfig.glowOpacity}" />
          <span class="ge-range-val" id="ge-glowOpacity-val">${hoverConfig.glowOpacity}</span>
        </label>
        <label class="ge-hover-label">Scale Growth
          <input type="range" min="1" max="1.5" step="0.01" class="ge-range" id="ge-scaleGrowth" value="${hoverConfig.scaleGrowth}" />
          <span class="ge-range-val" id="ge-scaleGrowth-val">${hoverConfig.scaleGrowth}</span>
        </label>
        <label class="ge-hover-label">Dim Opacity
          <input type="range" min="0" max="1" step="0.05" class="ge-range" id="ge-dimOpacity" value="${hoverConfig.dimOpacity}" />
          <span class="ge-range-val" id="ge-dimOpacity-val">${hoverConfig.dimOpacity}</span>
        </label>
        <label class="ge-hover-label">Pulse Speed
          <input type="range" min="0" max="5" step="0.1" class="ge-range" id="ge-pulseSpeed" value="${hoverConfig.pulseSpeed}" />
          <span class="ge-range-val" id="ge-pulseSpeed-val">${hoverConfig.pulseSpeed}</span>
        </label>
        <label class="ge-hover-label">Pulse Amount
          <input type="range" min="0" max="0.8" step="0.05" class="ge-range" id="ge-pulseAmount" value="${hoverConfig.pulseAmount}" />
          <span class="ge-range-val" id="ge-pulseAmount-val">${hoverConfig.pulseAmount}</span>
        </label>
      </div>
      <div class="ge-hover-title" style="margin-top:.6rem">Pixel Emission
        <label class="ge-preview-toggle"><input type="checkbox" id="ge-previewHover" /> Preview</label>
      </div>
      <div class="ge-hover-grid">
        <label class="ge-hover-label">Grid Size
          <input type="range" min="6" max="64" step="1" class="ge-range" id="ge-pixelGrid" value="${hoverConfig.pixelGrid}" />
          <span class="ge-range-val" id="ge-pixelGrid-val">${hoverConfig.pixelGrid}</span>
        </label>
        <label class="ge-hover-label">Spread
          <input type="range" min="0" max="1" step="0.02" class="ge-range" id="ge-pixelSpread" value="${hoverConfig.pixelSpread}" />
          <span class="ge-range-val" id="ge-pixelSpread-val">${hoverConfig.pixelSpread}</span>
        </label>
        <label class="ge-hover-label">Speed
          <input type="range" min="0" max="4" step="0.1" class="ge-range" id="ge-pixelSpeed" value="${hoverConfig.pixelSpeed}" />
          <span class="ge-range-val" id="ge-pixelSpeed-val">${hoverConfig.pixelSpeed}</span>
        </label>
        <label class="ge-hover-label">Size Var
          <input type="range" min="0" max="1" step="0.05" class="ge-range" id="ge-pixelSizeVar" value="${hoverConfig.pixelSizeVar}" />
          <span class="ge-range-val" id="ge-pixelSizeVar-val">${hoverConfig.pixelSizeVar}</span>
        </label>
        <label class="ge-hover-label">Density
          <input type="range" min="0" max="1" step="0.05" class="ge-range" id="ge-pixelDensity" value="${hoverConfig.pixelDensity}" />
          <span class="ge-range-val" id="ge-pixelDensity-val">${hoverConfig.pixelDensity}</span>
        </label>
        <label class="ge-hover-label">Fade
          <input type="range" min="0" max="1" step="0.05" class="ge-range" id="ge-pixelFade" value="${hoverConfig.pixelFade}" />
          <span class="ge-range-val" id="ge-pixelFade-val">${hoverConfig.pixelFade}</span>
        </label>
        <label class="ge-hover-label">Brightness
          <input type="range" min="0.5" max="5" step="0.1" class="ge-range" id="ge-pixelBright" value="${hoverConfig.pixelBright}" />
          <span class="ge-range-val" id="ge-pixelBright-val">${hoverConfig.pixelBright}</span>
        </label>
      </div>
    </div>
    <div class="gallery-editor-list" id="ge-list"></div>
  `;
  container.appendChild(panel);

  // --- Wire hover controls ---
  const hoverKeys = ['glowSize', 'glowOpacity', 'scaleGrowth', 'dimOpacity', 'pulseSpeed', 'pulseAmount',
                     'pixelGrid', 'pixelSpread', 'pixelSpeed', 'pixelSizeVar', 'pixelDensity', 'pixelFade', 'pixelBright'];
  const shaderUniformKeys = new Set(['pulseSpeed', 'pulseAmount', 'pixelGrid', 'pixelSpread', 'pixelSpeed', 'pixelSizeVar', 'pixelDensity', 'pixelFade', 'pixelBright']);
  for (const key of hoverKeys) {
    const input = panel.querySelector(`#ge-${key}`);
    const valSpan = panel.querySelector(`#ge-${key}-val`);
    if (!input) continue;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      hoverConfig[key] = v;
      valSpan.textContent = v.toFixed(2);

      // Live-update glow material uniforms
      if (shaderUniformKeys.has(key)) {
        for (const s of avatarStates) {
          if (s.glowMat && s.glowMat.uniforms[key]) {
            s.glowMat.uniforms[key].value = v;
          }
        }
      }

      // Live-update glow plane size
      if (key === 'glowSize') {
        for (const s of avatarStates) {
          if (s.glowMesh && s.mesh.geometry) {
            const params = s.mesh.geometry.parameters;
            if (params) {
              s.glowMesh.geometry.dispose();
              s.glowMesh.geometry = new THREE.PlaneGeometry(
                params.width * hoverConfig.glowSize,
                params.height * hoverConfig.glowSize
              );
            }
          }
        }
      }
    });
  }

  const list = panel.querySelector('#ge-list');
  let selectedIdx = -1;

  // Build list items
  avatarStates.forEach((state, i) => {
    const artist = state.mesh.userData.artist;
    const slug = state.mesh.userData.slug;
    const row = document.createElement('div');
    row.className = 'gallery-editor-item';
    row.dataset.index = i;
    row.innerHTML = `
      <div class="ge-item-name" style="color:${artist.hex || '#333'}">${artist.name}</div>
      <div class="ge-item-coords">
        <label>X <input type="number" step="0.01" class="ge-input ge-x" value="${state.mesh.position.x.toFixed(2)}" /></label>
        <label>Z <input type="number" step="0.01" class="ge-input ge-z" value="${state.mesh.position.z.toFixed(2)}" /></label>
      </div>
      <div class="ge-item-coords">
        <label>Y <input type="number" step="0.01" min="0" class="ge-input ge-y" value="${(state.yOffset || 0).toFixed(2)}" /></label>
        <label>S <input type="number" step="0.01" min="0.1" class="ge-input ge-s" value="${(state.baseScale || 1).toFixed(2)}" /></label>
      </div>
    `;
    list.appendChild(row);

    // Click name to select
    row.querySelector('.ge-item-name').addEventListener('click', () => selectAvatar(i));

    // Input changes
    row.querySelector('.ge-x').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value) || 0;
      updateAvatar(i, { x: val });
    });
    row.querySelector('.ge-z').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value) || 0;
      updateAvatar(i, { z: val });
    });
    row.querySelector('.ge-y').addEventListener('input', (e) => {
      const val = Math.max(0, parseFloat(e.target.value) || 0);
      e.target.value = val.toFixed(2);
      updateAvatar(i, { y: val });
    });
    row.querySelector('.ge-s').addEventListener('input', (e) => {
      const val = Math.max(0.1, parseFloat(e.target.value) || 1);
      e.target.value = val.toFixed(2);
      updateAvatar(i, { scale: val });
    });
  });

  function selectAvatar(idx) {
    selectedIdx = idx;
    list.querySelectorAll('.gallery-editor-item').forEach((el, j) => {
      el.classList.toggle('active', j === idx);
    });
    // Highlight in scene
    avatarStates.forEach((s, j) => {
      s.targetOpacity = s.textureLoaded ? (j === idx ? 1 : 0.4) : 0;
      s.targetScale = j === idx ? 1.1 : 1;
    });
  }

  function updateAvatar(idx, changes) {
    const s = avatarStates[idx];
    if ('x' in changes) {
      s.mesh.position.x = changes.x;
    }
    if ('z' in changes) {
      s.mesh.position.z = changes.z;
    }
    if ('y' in changes) {
      const y = Math.max(0, changes.y);
      s.yOffset = y;
      s.mesh.position.y = (AVATAR_H / 2) * (s.baseScale || 1) + y;
    }
    if ('scale' in changes) {
      const sc = Math.max(0.1, changes.scale);
      s.baseScale = sc;
      s.targetScale = sc;
      s.currentScale = sc;
      s.mesh.scale.setScalar(sc);
      // Anchor scale from bottom: adjust Y so bottom edge stays at yOffset
      s.mesh.position.y = (AVATAR_H / 2) * sc + (s.yOffset || 0);
      if (s.glowMesh) s.glowMesh.scale.setScalar(sc);
    }
    // Update input fields
    const row = list.children[idx];
    if (row) {
      row.querySelector('.ge-x').value = s.mesh.position.x.toFixed(2);
      row.querySelector('.ge-z').value = s.mesh.position.z.toFixed(2);
      row.querySelector('.ge-y').value = (s.yOffset || 0).toFixed(2);
      row.querySelector('.ge-s').value = (s.baseScale || 1).toFixed(2);
    }
  }

  // --- 3D dragging ---
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y = 0
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let dragging = false;
  let dragIdx = -1;

  const domEl = renderer.domElement;

  domEl.addEventListener('pointerdown', (e) => {
    updatePointer(e);
    raycaster.setFromCamera(pointer, camera);
    const meshes = avatarStates.map(s => s.mesh);
    const hits = raycaster.intersectObjects(meshes);
    if (hits.length > 0) {
      const hitMesh = hits[0].object;
      dragIdx = avatarStates.findIndex(s => s.mesh === hitMesh);
      if (dragIdx >= 0) {
        dragging = true;
        selectAvatar(dragIdx);
        domEl.style.cursor = 'grabbing';
      }
    }
  });

  domEl.addEventListener('pointermove', (e) => {
    if (!dragging || dragIdx < 0) return;
    updatePointer(e);
    raycaster.setFromCamera(pointer, camera);
    const intersection = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(floorPlane, intersection)) {
      updateAvatar(dragIdx, {
        x: Math.round(intersection.x * 100) / 100,
        z: Math.round(intersection.z * 100) / 100,
      });
    }
  });

  domEl.addEventListener('pointerup', () => {
    dragging = false;
    dragIdx = -1;
    domEl.style.cursor = '';
  });

  function updatePointer(e) {
    const rect = domEl.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  // --- Save ---
  const saveBtn = panel.querySelector('#ge-save');
  saveBtn.addEventListener('click', async () => {
    const data = {};
    avatarStates.forEach(s => {
      const slug = s.mesh.userData.slug;
      data[slug] = {
        x: Math.round(s.mesh.position.x * 100) / 100,
        z: Math.round(s.mesh.position.z * 100) / 100,
        y: Math.round((s.yOffset || 0) * 100) / 100,
        scale: Math.round((s.baseScale || 1) * 100) / 100,
      };
    });
    // Include hover config in saved data
    data.__hoverConfig = { ...hoverConfig };

    saveBtn.textContent = 'Saving\u2026';
    try {
      const resp = await fetch('/save-positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (resp.ok) {
        saveBtn.textContent = 'Saved!';
        setTimeout(() => { saveBtn.textContent = 'Save JSON'; }, 1500);
      } else {
        throw new Error('Server error');
      }
    } catch {
      // Fallback: download file if dev server doesn't support POST
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'avatar-positions.json';
      a.click();
      URL.revokeObjectURL(a.href);
      saveBtn.textContent = 'Downloaded';
      setTimeout(() => { saveBtn.textContent = 'Save JSON'; }, 1500);
    }
  });

  // --- Reset ---
  panel.querySelector('#ge-reset').addEventListener('click', () => {
    avatarStates.forEach((s, i) => {
      const slug = s.mesh.userData.slug;
      const pos = getPosition(slug, i, avatarStates.length, savedPositions);
      updateAvatar(i, { x: pos.x, z: pos.z, y: pos.y, scale: pos.scale });
    });
  });

  // --- Preview hover checkbox ---
  const previewCheckbox = panel.querySelector('#ge-previewHover');
  const editorState = { previewHover: false };
  previewCheckbox.addEventListener('change', () => {
    editorState.previewHover = previewCheckbox.checked;
    if (!previewCheckbox.checked) {
      // Clear the forced hover
      for (const s of avatarStates) {
        s.targetOpacity = s.textureLoaded ? 1 : 0;
        s.targetScale = s.baseScale || 1;
        s.targetGlowIntensity = 0;
      }
    }
  });

  return { selectAvatar, updateAvatar, editorState };
}

/* ================================================================
   MAIN EXPORT
   ================================================================ */
export async function populateGallery(scene, camera, renderer, container, artists, onBeforeRender) {
  if (!artists.length) return;

  const editorMode = isEditorMode();
  const savedPositions = await loadPositions();

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(-999, -999);
  const avatarMeshes = [];
  const avatarStates = [];

  // Floating logo in the air
  const logoMesh = createLogoPlane();
  scene.add(logoMesh);

  const tooltip = editorMode ? null : createTooltip(container);
  let hoveredMesh = null;
  let lockedMesh = null;   // click-locked artist: hover stays until unlocked
  let lastTappedMesh = null;

  const domEl = renderer.domElement;

  // Create avatar groups
  for (let i = 0; i < artists.length; i++) {
    const artist = artists[i];
    const slug = toSlug(artist.name);
    const pos = getPosition(slug, i, artists.length, savedPositions);
    const imgUrl = artist.avatarLink || artist.profilePic;

    // Default geometry
    let avatarGeo = new THREE.PlaneGeometry(AVATAR_H * 0.8, AVATAR_H);

    // --- Avatar plane (always transparent background) ---
    const avatarMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0,
      side: THREE.DoubleSide,
    });
    const avatarMesh = new THREE.Mesh(avatarGeo, avatarMat);
    const yOffset = pos.y || 0;
    const initScale = pos.scale || 1;
    // Anchor from bottom: Y = half-height * scale + yOffset
    avatarMesh.position.set(pos.x, (AVATAR_H / 2) * initScale + yOffset, pos.z);
    avatarMesh.scale.setScalar(initScale);
    avatarMesh.userData = { artist, slug };
    scene.add(avatarMesh);
    avatarMeshes.push(avatarMesh);

    const stateIndex = avatarStates.length;
    avatarStates.push({
      mesh: avatarMesh,
      glowMesh: null,
      glowMat: null,
      targetGlowIntensity: 0, currentGlowIntensity: 0,
      targetOpacity: 0, currentOpacity: 0,
      targetScale: pos.scale || 1, currentScale: pos.scale || 1,
      baseScale: pos.scale || 1,
      yOffset,
      textureLoaded: false,
    });

    // If no image URL, show label immediately (no avatar to show)
    if (!imgUrl) {
      avatarStates[stateIndex].textureLoaded = true;
      avatarStates[stateIndex].targetOpacity = 1;
    }

    // Stagger texture loads to avoid Google rate-limiting
    if (imgUrl) {
      const idx = i; // capture loop index for stagger delay
      setTimeout(() => {
        loadTextureFromURL(imgUrl).then(result => {
          if (!result) return;
          const { tex, aspect, img } = result;

          avatarMat.map = tex;
          avatarMat.needsUpdate = true;

          // Fade in now that texture is ready
          avatarStates[stateIndex].textureLoaded = true;
          avatarStates[stateIndex].targetOpacity = 1;

          const w = AVATAR_H * aspect;
          avatarMesh.geometry.dispose();
          avatarMesh.geometry = new THREE.PlaneGeometry(w, AVATAR_H);

          // --- Glow plane (behind avatar) ---
          // Load a separate copy of the image for glow map to avoid tainting the avatar texture
          const glowImg = new Image();
          if (!img.src.startsWith(window.location.origin) && !img.src.startsWith('/')) {
            glowImg.crossOrigin = 'anonymous';
          }
          glowImg.onload = () => {
            try {
              const glowMapTex = generateGlowMap(glowImg);
              if (glowMapTex) {
                const glowMat = createGlowMaterial(glowMapTex, artist.hex || '#ffffff');
                const glowGeo = new THREE.PlaneGeometry(w * hoverConfig.glowSize, AVATAR_H * hoverConfig.glowSize);
                const glowMesh = new THREE.Mesh(glowGeo, glowMat);
                glowMesh.position.copy(avatarMesh.position);
                glowMesh.position.z -= 0.01;
                glowMesh.scale.copy(avatarMesh.scale);
                glowMesh.visible = false;
                scene.add(glowMesh);

                avatarStates[stateIndex].glowMesh = glowMesh;
                avatarStates[stateIndex].glowMat = glowMat;
              }
            } catch (err) {
              console.warn('[gallery3d] glow map error for', artist.name, err);
            }
          };
          glowImg.onerror = () => {
            console.warn('[gallery3d] glow image failed to load for', artist.name);
          };
          glowImg.src = img.src; // reuse same URL — will load from browser cache
        });
      }, idx * 150); // 150ms stagger per avatar
    }
  }

  /* ---- EDITOR MODE ---- */
  if (editorMode) {
    const { editorState } = buildEditorPanel(container, avatarStates, camera, savedPositions, renderer);

    // Editor hover preview: track pointer for raycasting
    const editorRaycaster = new THREE.Raycaster();
    const editorPointer = new THREE.Vector2(-999, -999);
    let editorHoveredMesh = null;
    const editorClock = new THREE.Clock();

    domEl.addEventListener('pointermove', (e) => {
      const rect = domEl.getBoundingClientRect();
      editorPointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      editorPointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    });
    domEl.addEventListener('pointerleave', () => {
      editorPointer.set(-999, -999);
      editorHoveredMesh = null;
      if (!editorState.previewHover) {
        for (const s of avatarStates) {
          s.targetOpacity = s.textureLoaded ? 1 : 0;
          s.targetScale = s.baseScale || 1;
          s.targetGlowIntensity = 0;
        }
      }
    });

    onBeforeRender(() => {
      const elapsed = editorClock.getElapsedTime();

      // Preview hover: force artist[0] as hovered
      if (editorState.previewHover) {
        for (let i = 0; i < avatarStates.length; i++) {
          const s = avatarStates[i];
          if (i === 0) {
            s.targetOpacity = s.textureLoaded ? 1 : 0;
            s.targetScale = (s.baseScale || 1) * hoverConfig.scaleGrowth;
            s.targetGlowIntensity = hoverConfig.glowOpacity;
          } else {
            s.targetOpacity = s.textureLoaded ? hoverConfig.dimOpacity : 0;
            s.targetScale = s.baseScale || 1;
            s.targetGlowIntensity = 0;
          }
        }
      } else if (editorPointer.x > -10) {
        // Raycast hover preview (only when not in preview mode)
        editorRaycaster.setFromCamera(editorPointer, camera);
        const hits = editorRaycaster.intersectObjects(avatarMeshes, false);
        if (hits.length > 0) {
          const hit = hits[0].object;
          if (editorHoveredMesh !== hit) {
            editorHoveredMesh = hit;
            for (const s of avatarStates) {
              if (s.mesh === hit) {
                s.targetOpacity = s.textureLoaded ? 1 : 0;
                s.targetScale = (s.baseScale || 1) * hoverConfig.scaleGrowth;
                s.targetGlowIntensity = hoverConfig.glowOpacity;
              } else {
                s.targetOpacity = s.textureLoaded ? hoverConfig.dimOpacity : 0;
                s.targetScale = s.baseScale || 1;
                s.targetGlowIntensity = 0;
              }
            }
          }
        } else if (editorHoveredMesh) {
          editorHoveredMesh = null;
          for (const s of avatarStates) {
            s.targetOpacity = s.textureLoaded ? 1 : 0;
            s.targetScale = s.baseScale || 1;
            s.targetGlowIntensity = 0;
          }
        }
      }

      // Smooth lerp + glow
      for (const state of avatarStates) {
        state.currentOpacity += (state.targetOpacity - state.currentOpacity) * 0.12;
        state.currentScale += (state.targetScale - state.currentScale) * 0.12;
        state.currentGlowIntensity += (state.targetGlowIntensity - state.currentGlowIntensity) * 0.08;

        state.mesh.material.opacity = state.currentOpacity;
        state.mesh.scale.setScalar(state.currentScale);
        // Anchor scale from bottom
        state.mesh.position.y = (AVATAR_H / 2) * state.currentScale + (state.yOffset || 0);

        // Glow plane
        if (state.glowMesh && state.glowMat) {
          state.glowMat.uniforms.glowIntensity.value = state.currentGlowIntensity;
          state.glowMat.uniforms.time.value = elapsed;
          state.glowMesh.position.x = state.mesh.position.x;
          state.glowMesh.position.y = state.mesh.position.y;
          state.glowMesh.position.z = state.mesh.position.z - 0.01;
          state.glowMesh.scale.setScalar(state.currentScale);
          state.glowMesh.visible = state.currentGlowIntensity > 0.01;
        }
      }
    });
    return;
  }

  /* ---- NORMAL MODE: pointer tracking ---- */
  domEl.addEventListener('pointermove', (e) => {
    const rect = domEl.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  });

  domEl.addEventListener('pointerleave', () => {
    pointer.set(-999, -999);
    if (!lockedMesh) clearHover();
  });

  /* ---- hover helpers ---- */
  function setHover(mesh, locked) {
    const changed = hoveredMesh !== mesh;
    hoveredMesh = mesh;
    domEl.style.cursor = 'pointer';

    for (const state of avatarStates) {
      if (state.mesh === mesh) {
        state.targetOpacity = state.textureLoaded ? 1 : 0;
        state.targetScale = (state.baseScale || 1) * hoverConfig.scaleGrowth;
        state.targetGlowIntensity = hoverConfig.glowOpacity;
      } else {
        state.targetOpacity = state.textureLoaded ? hoverConfig.dimOpacity : 0;
        state.targetScale = state.baseScale || 1;
        state.targetGlowIntensity = 0.0;
      }
    }

    const artist = mesh.userData.artist;
    const slug = mesh.userData.slug;
    const viewBtn = locked
      ? `<a class="room-tooltip-view" href="#artist/${slug}">View ${artist.name} &rarr;</a>`
      : '';
    tooltip.innerHTML = `
      <div class="room-tooltip-name" style="color:${artist.hex}">${artist.name}</div>
      <div class="room-tooltip-desc">${artist.description}</div>
      ${viewBtn}
    `;
    tooltip.classList.toggle('locked', !!locked);

    if (changed) {
      tooltip.style.display = 'block';
      tooltip.classList.remove('blink-open');
      void tooltip.offsetWidth;
      tooltip.classList.add('blink-open');
    } else if (locked) {
      // Same artist, just locked — update content without re-blinking
      tooltip.style.display = 'block';
    }
  }

  function clearHover() {
    hoveredMesh = null;
    lockedMesh = null;
    domEl.style.cursor = '';
    if (tooltip) {
      tooltip.style.display = 'none';
      tooltip.classList.remove('blink-open');
      tooltip.classList.remove('locked');
    }
    for (const state of avatarStates) {
      state.targetOpacity = state.textureLoaded ? 1 : 0;
      state.targetScale = state.baseScale || 1;
      state.targetGlowIntensity = 0.0;
    }
  }

  /* ---- click / tap: lock hover effect ---- */
  domEl.addEventListener('click', () => {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(avatarMeshes);
    if (hits.length > 0) {
      const hit = hits[0].object;
      if (lockedMesh === hit) {
        // Clicking the same locked artist unlocks
        clearHover();
      } else {
        // Lock onto this artist
        lockedMesh = hit;
        setHover(hit, true);
      }
    } else {
      // Clicking empty space clears lock
      if (lockedMesh) {
        clearHover();
      }
    }
  });

  domEl.addEventListener('touchend', (e) => {
    const touch = e.changedTouches[0];
    const rect = domEl.getBoundingClientRect();
    pointer.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(avatarMeshes);

    if (hits.length > 0) {
      const hit = hits[0].object;
      if (lockedMesh === hit) {
        // Tapping the locked artist unlocks
        clearHover();
      } else {
        // Lock onto this artist
        lockedMesh = hit;
        setHover(hit, true);
        e.preventDefault();
      }
    } else {
      if (lockedMesh) {
        clearHover();
      }
    }
  }, { passive: false });

  /* ---- Escape key clears hover/lock ---- */
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (hoveredMesh || lockedMesh)) {
      clearHover();
    }
  });

  /* ---- per-frame update ---- */
  const clock = new THREE.Clock();

  onBeforeRender(() => {
    try {
      const elapsed = clock.getElapsedTime();

      // Raycast hover (skip when an artist is click-locked)
      if (!lockedMesh && pointer.x > -10) {
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(avatarMeshes, false);

        if (hits.length > 0) {
          setHover(hits[0].object);
        } else if (hoveredMesh) {
          clearHover();
        }
      }

      // Smooth lerp
      for (const state of avatarStates) {
        state.currentOpacity += (state.targetOpacity - state.currentOpacity) * 0.12;
        state.currentScale += (state.targetScale - state.currentScale) * 0.12;
        state.currentGlowIntensity += (state.targetGlowIntensity - state.currentGlowIntensity) * 0.08;

        state.mesh.material.opacity = state.currentOpacity;
        state.mesh.scale.setScalar(state.currentScale);
        // Anchor scale from bottom: keep bottom edge at yOffset
        state.mesh.position.y = (AVATAR_H / 2) * state.currentScale + (state.yOffset || 0);

        // Glow plane
        if (state.glowMesh && state.glowMat) {
          state.glowMat.uniforms.glowIntensity.value = state.currentGlowIntensity;
          state.glowMat.uniforms.time.value = elapsed;
          state.glowMesh.position.x = state.mesh.position.x;
          state.glowMesh.position.y = state.mesh.position.y;
          state.glowMesh.position.z = state.mesh.position.z - 0.01;
          state.glowMesh.scale.setScalar(state.currentScale);
          state.glowMesh.visible = state.currentGlowIntensity > 0.01;
        }
      }

      // Tooltip position — beside the avatar, toward the center of the screen
      if (hoveredMesh && tooltip && tooltip.style.display !== 'none') {
        const hState = avatarStates.find(s => s.mesh === hoveredMesh);
        const sc = hState ? hState.currentScale : 1;

        // Project avatar center (vertically centered on the avatar)
        const centerPos = hoveredMesh.position.clone();
        centerPos.project(camera);

        const rect = container.getBoundingClientRect();
        const cx = (centerPos.x * 0.5 + 0.5) * rect.width;
        const cy = (-centerPos.y * 0.5 + 0.5) * rect.height;

        // Project a point at the avatar's side edge to get pixel offset
        const sidePos = hoveredMesh.position.clone();
        const geo = hoveredMesh.geometry;
        const avatarW = geo.parameters ? geo.parameters.width : AVATAR_H * 0.8;
        const halfW = (avatarW / 2) * sc + 0.15; // half width + small gap
        const avatarRightOfCenter = cx > rect.width / 2;
        // Offset toward center: if avatar is right of center, tooltip goes left (negative X)
        sidePos.x += avatarRightOfCenter ? -halfW : halfW;
        sidePos.project(camera);

        const sx = (sidePos.x * 0.5 + 0.5) * rect.width;

        tooltip.style.left = `${sx}px`;
        tooltip.style.top = `${cy}px`;
        // Anchor tooltip away from avatar: if avatar is right of center, tooltip is to the left
        tooltip.style.transform = avatarRightOfCenter
          ? 'translate(-100%, -50%)'
          : 'translate(0%, -50%)';
      }
    } catch (err) {
      console.error('[gallery3d] render error:', err);
    }
  });
}
