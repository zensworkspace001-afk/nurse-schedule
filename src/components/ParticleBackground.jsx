import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/*
  Combined dynamic background:
  1. Aurora-style flowing gradient (via a full-screen shader plane)
  2. 3D particle field with depth, connections, and gentle camera sway
*/

/* ─── Config ─── */
const PARTICLE_COUNT = 200;
const LINK_DIST = 1.8;
const DRIFT = 0.002;
const MOUSE_RADIUS = 3;
const MOUSE_FORCE = 0.008;

/* ─── Aurora fragment shader ─── */
const AURORA_FRAG = `
  uniform float uTime;
  uniform vec2  uResolution;
  varying vec2  vUv;

  // simplex-ish noise (compact)
  vec3 mod289(vec3 x){ return x - floor(x*(1.0/289.0))*289.0; }
  vec2 mod289(vec2 x){ return x - floor(x*(1.0/289.0))*289.0; }
  vec3 permute(vec3 x){ return mod289(((x*34.0)+1.0)*x); }

  float snoise(vec2 v){
    const vec4 C = vec4(0.211324865405,0.366025403784,-0.577350269189,0.024390243902);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0,0.0) : vec2(0.0,1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0*fract(p*C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314*(a0*a0+h*h);
    vec3 g;
    g.x = a0.x*x0.x + h.x*x0.y;
    g.yz = a0.yz*x12.xz + h.yz*x12.yw;
    return 130.0*dot(m, g);
  }

  void main(){
    vec2 uv = vUv;
    float t = uTime * 0.08;

    // layered noise for aurora bands
    float n1 = snoise(vec2(uv.x * 1.5 + t, uv.y * 0.8 - t * 0.5));
    float n2 = snoise(vec2(uv.x * 2.5 - t * 0.7, uv.y * 1.2 + t * 0.3));
    float n3 = snoise(vec2(uv.x * 0.8 + t * 0.4, uv.y * 2.0 - t * 0.6));

    // cold palette colours
    vec3 col1 = vec3(0.53, 0.61, 0.66);  // #879ca8
    vec3 col2 = vec3(0.29, 0.36, 0.42);  // #4a5c6a
    vec3 col3 = vec3(0.35, 0.50, 0.65);  // steel blue accent
    vec3 col4 = vec3(0.45, 0.55, 0.60);  // silver

    // blend
    float blend = (n1 + n2 * 0.5 + n3 * 0.3) * 0.5 + 0.5;
    vec3 color = mix(col2, col1, uv.y);
    color = mix(color, col3, smoothstep(0.35, 0.65, blend) * 0.4);
    color = mix(color, col4, smoothstep(0.5, 0.8, n2 * 0.5 + 0.5) * 0.25);

    // subtle vignette
    float vig = 1.0 - 0.3 * length(uv - 0.5);
    color *= vig;

    gl_FragColor = vec4(color, 1.0);
  }
`;

const AURORA_VERT = `
  varying vec2 vUv;
  void main(){
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

/* ─── Helpers ─── */
function rand(min, max) { return Math.random() * (max - min) + min; }

export default function ParticleBackground() {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /* ─── Renderer ─── */
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    /* ─── Scene & Camera ─── */
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 8);

    /* ─── Aurora background (full-screen quad) ─── */
    const auroraMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      },
      vertexShader: AURORA_VERT,
      fragmentShader: AURORA_FRAG,
      depthWrite: false,
    });
    const auroraGeo = new THREE.PlaneGeometry(2, 2);
    const auroraMesh = new THREE.Mesh(auroraGeo, auroraMat);
    auroraMesh.frustumCulled = false;

    // Render aurora in a separate background scene
    const bgScene = new THREE.Scene();
    bgScene.add(auroraMesh);
    const bgCamera = new THREE.Camera();

    /* ─── 3D Particles ─── */
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const velocities = [];
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const sizes = new Float32Array(PARTICLE_COUNT);

    const palette = [
      [0.7, 0.78, 0.86],   // cool silver
      [0.47, 0.63, 0.78],   // muted blue
      [0.63, 0.71, 0.76],   // slate
      [0.39, 0.55, 0.71],   // steel blue
      [0.6, 0.7, 0.8],      // light blue
    ];

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;
      positions[i3]     = rand(-8, 8);
      positions[i3 + 1] = rand(-5, 5);
      positions[i3 + 2] = rand(-4, 4);

      velocities.push(
        rand(-DRIFT, DRIFT),
        rand(-DRIFT, DRIFT),
        rand(-DRIFT, DRIFT)
      );

      const c = palette[Math.floor(Math.random() * palette.length)];
      colors[i3]     = c[0];
      colors[i3 + 1] = c[1];
      colors[i3 + 2] = c[2];

      sizes[i] = rand(2, 5);
    }

    const particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particleGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    particleGeo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    // Circular dot texture
    const dotCanvas = document.createElement('canvas');
    dotCanvas.width = 64;
    dotCanvas.height = 64;
    const dctx = dotCanvas.getContext('2d');
    const grad = dctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,0.8)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.3)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    dctx.fillStyle = grad;
    dctx.fillRect(0, 0, 64, 64);
    const dotTexture = new THREE.CanvasTexture(dotCanvas);

    const particleMat = new THREE.PointsMaterial({
      size: 0.08,
      map: dotTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    const points = new THREE.Points(particleGeo, particleMat);
    scene.add(points);

    /* ─── Connection lines ─── */
    const MAX_LINES = PARTICLE_COUNT * 6;
    const linePositions = new Float32Array(MAX_LINES * 6);
    const lineColors = new Float32Array(MAX_LINES * 6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    lineGeo.setAttribute('color', new THREE.BufferAttribute(lineColors, 3));
    lineGeo.setDrawRange(0, 0);

    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    scene.add(lines);

    /* ─── Mouse tracking (projected to 3D) ─── */
    const mouse3D = new THREE.Vector3(9999, 9999, 0);
    function onMouseMove(e) {
      mouse3D.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse3D.y = -(e.clientY / window.innerHeight) * 2 + 1;
      mouse3D.z = 0;
      mouse3D.unproject(camera);
      const dir = mouse3D.sub(camera.position).normalize();
      const dist = -camera.position.z / dir.z;
      mouse3D.copy(camera.position).add(dir.multiplyScalar(dist));
    }
    function onMouseLeave() { mouse3D.set(9999, 9999, 0); }

    /* ─── Animation ─── */
    const timer = new THREE.Timer();
    let animId;

    function animate() {
      animId = requestAnimationFrame(animate);
      timer.update();
      const t = timer.getElapsed();
      const pos = particleGeo.attributes.position.array;

      // Update aurora time
      auroraMat.uniforms.uTime.value = t;

      // Gentle camera sway
      camera.position.x = Math.sin(t * 0.15) * 0.5;
      camera.position.y = Math.cos(t * 0.1) * 0.3;
      camera.lookAt(0, 0, 0);

      // Update particles
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const i3 = i * 3;

        // Mouse repulsion
        const dx = pos[i3] - mouse3D.x;
        const dy = pos[i3 + 1] - mouse3D.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < MOUSE_RADIUS * MOUSE_RADIUS && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const f = (MOUSE_RADIUS - d) / MOUSE_RADIUS * MOUSE_FORCE;
          velocities[i3] += (dx / d) * f;
          velocities[i3 + 1] += (dy / d) * f;
        }

        // Drift
        pos[i3]     += velocities[i3];
        pos[i3 + 1] += velocities[i3 + 1];
        pos[i3 + 2] += velocities[i3 + 2];

        // Dampen
        velocities[i3]     *= 0.997;
        velocities[i3 + 1] *= 0.997;
        velocities[i3 + 2] *= 0.997;

        // Wrap
        if (pos[i3] < -9) pos[i3] = 9;
        if (pos[i3] > 9) pos[i3] = -9;
        if (pos[i3 + 1] < -6) pos[i3 + 1] = 6;
        if (pos[i3 + 1] > 6) pos[i3 + 1] = -6;
        if (pos[i3 + 2] < -5) pos[i3 + 2] = 5;
        if (pos[i3 + 2] > 5) pos[i3 + 2] = -5;
      }
      particleGeo.attributes.position.needsUpdate = true;

      // Update lines
      let lineIdx = 0;
      const linkDist2 = LINK_DIST * LINK_DIST;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const i3 = i * 3;
        for (let j = i + 1; j < PARTICLE_COUNT; j++) {
          const j3 = j * 3;
          const dx = pos[i3] - pos[j3];
          const dy = pos[i3 + 1] - pos[j3 + 1];
          const dz = pos[i3 + 2] - pos[j3 + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < linkDist2) {
            const alpha = 1 - Math.sqrt(d2) / LINK_DIST;
            const li = lineIdx * 6;
            linePositions[li]     = pos[i3];
            linePositions[li + 1] = pos[i3 + 1];
            linePositions[li + 2] = pos[i3 + 2];
            linePositions[li + 3] = pos[j3];
            linePositions[li + 4] = pos[j3 + 1];
            linePositions[li + 5] = pos[j3 + 2];

            const c = alpha * 0.5;
            lineColors[li]     = 0.55 + c * 0.2;
            lineColors[li + 1] = 0.65 + c * 0.15;
            lineColors[li + 2] = 0.75 + c * 0.1;
            lineColors[li + 3] = lineColors[li];
            lineColors[li + 4] = lineColors[li + 1];
            lineColors[li + 5] = lineColors[li + 2];

            lineIdx++;
            if (lineIdx >= MAX_LINES) break;
          }
        }
        if (lineIdx >= MAX_LINES) break;
      }
      lineGeo.setDrawRange(0, lineIdx * 2);
      lineGeo.attributes.position.needsUpdate = true;
      lineGeo.attributes.color.needsUpdate = true;

      // Render
      renderer.autoClear = false;
      renderer.clear();
      renderer.render(bgScene, bgCamera);   // aurora first
      renderer.render(scene, camera);        // 3D particles on top
    }

    animate();

    /* ─── Resize ─── */
    function onResize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      auroraMat.uniforms.uResolution.value.set(w, h);
    }

    window.addEventListener('resize', onResize);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
