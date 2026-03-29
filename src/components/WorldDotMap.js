import React from 'react';
import * as THREE from 'three';
import { feature } from 'topojson-client';
import { geoEquirectangular, geoPath } from 'd3-geo';
import world from 'world-atlas/land-110m.json';

// Rasterise the land topojson onto a canvas so we can do fast lat/lon → land/water
// lookups without any runtime d3 projection during the dot-sampling loop.
const MAP_W = 3600;
const MAP_H = 1800;

function buildLandMask() {
  const canvas = document.createElement('canvas');
  canvas.width = MAP_W;
  canvas.height = MAP_H;
  const ctx = canvas.getContext('2d');

  const land = feature(world, world.objects.land); // FeatureCollection
  const proj = geoEquirectangular()
    .scale(MAP_W / (2 * Math.PI))
    .translate([MAP_W / 2, MAP_H / 2]);
  const path = geoPath(proj, ctx);

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  path(land);
  ctx.fill();

  return ctx.getImageData(0, 0, MAP_W, MAP_H).data;
}

function isLand(pixels, lat, lon) {
  const x = Math.min(MAP_W - 1, Math.max(0, Math.floor((lon + 180) / 360 * MAP_W)));
  const y = Math.min(MAP_H - 1, Math.max(0, Math.floor((90 - lat) / 180 * MAP_H)));
  return pixels[(y * MAP_W + x) * 4] > 128;
}

// Convert geographic coords → point on unit sphere
function latLonToVec3(lat, lon, r) {
  const phi   = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return [
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  ];
}

// ── Shaders ────────────────────────────────────────────────────────────────────
// Vertex: scale point size with perspective depth so near dots aren't huge
// Fragment: crisp circular dot with slight per-dot brightness variation
const VERT = `
  attribute float aBrightness;
  varying  float vBrightness;
  uniform  float uDPR;
  void main() {
    vBrightness = aBrightness;
    vec4 mvPos   = modelViewMatrix * vec4(position, 1.0);
    gl_Position  = projectionMatrix * mvPos;
    // ~4 CSS-px dot at camera distance 2.8; scales with depth
    gl_PointSize = uDPR * 4.2 * (1.4 / -mvPos.z);
  }
`;

const FRAG = `
  varying float vBrightness;
  void main() {
    vec2  uv    = gl_PointCoord - 0.5;
    float r     = length(uv) * 2.0;               // 0 = centre, 1 = rim
    // smoothstep(0.38, 0.50) → hard, crisp edge (no soft glow)
    float alpha = 1.0 - smoothstep(0.38, 0.50, r);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(vBrightness, vBrightness, vBrightness, alpha);
  }
`;

class WorldDotMap extends React.Component {
  componentDidMount() {
    const el  = this.container;
    const W   = el.clientWidth;
    const H   = el.clientHeight;
    const DPR = window.devicePixelRatio || 1;

    // ── Scene ──────────────────────────────────────────────────────────────────
    const scene    = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0d0d);

    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
    camera.position.z = 2.8;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(DPR);
    el.appendChild(renderer.domElement);

    // ── Build dots ────────────────────────────────────────────────────────────
    const pixels = buildLandMask();

    const GRID = 1.5; // degrees — yields ~6 200 land dots
    const R    = 1.0;
    const posArr  = [];
    const brtArr  = [];

    for (let lat = -90 + GRID / 2; lat < 90; lat += GRID) {
      for (let lon = -180 + GRID / 2; lon < 180; lon += GRID) {
        if (!isLand(pixels, lat, lon)) continue;
        const [x, y, z] = latLonToVec3(lat, lon, R);
        posArr.push(x, y, z);
        // Brightness range 0.82 – 1.0 for a slightly sparkly, non-uniform look
        brtArr.push(0.82 + Math.random() * 0.18);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',    new THREE.Float32BufferAttribute(posArr, 3));
    geo.setAttribute('aBrightness', new THREE.Float32BufferAttribute(brtArr, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms:       { uDPR: { value: DPR } },
      vertexShader:   VERT,
      fragmentShader: FRAG,
      transparent:    true,
    });

    const dots = new THREE.Points(geo, mat);
    scene.add(dots);

    // ── Horizontal-only interaction ────────────────────────────────────────────
    // Polar angle is never touched — the globe only spins on its Y axis.
    let dragging = false;
    let prevX    = 0;
    let rotY     = 0;

    const onDown = (e) => {
      dragging = true;
      prevX = e.touches ? e.touches[0].clientX : e.clientX;
    };
    const onMove = (e) => {
      if (!dragging) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      rotY += (x - prevX) * 0.005;
      prevX = x;
    };
    const onUp = () => { dragging = false; };

    renderer.domElement.addEventListener('mousedown',  onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    renderer.domElement.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('touchmove',  onMove, { passive: true });
    window.addEventListener('touchend',   onUp);

    // ── Animation loop ─────────────────────────────────────────────────────────
    let last = performance.now();
    const animate = () => {
      this._raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt  = (now - last) / 1000;
      last = now;

      if (!dragging) rotY += dt * 0.12; // ~7°/s auto-rotate
      dots.rotation.y = rotY;

      renderer.render(scene, camera);
    };
    animate();

    // ── Resize ─────────────────────────────────────────────────────────────────
    const onResize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    // ── Cleanup ────────────────────────────────────────────────────────────────
    this._dispose = () => {
      cancelAnimationFrame(this._raf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend',  onUp);
      window.removeEventListener('resize',    onResize);
      geo.dispose();
      mat.dispose();
      renderer.dispose();
    };
  }

  componentWillUnmount() {
    if (this._dispose) this._dispose();
  }

  render() {
    return (
      <div
        ref={el => { this.container = el; }}
        style={{
          width:    '100vw',
          height:   '100vh',
          overflow: 'hidden',
          background: '#0d0d0d',
          cursor: 'grab',
        }}
      />
    );
  }
}

export default WorldDotMap;
