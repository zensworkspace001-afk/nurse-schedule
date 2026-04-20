import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

const PALETTE = [
  0xF44336, 0xE91E63, 0x9C27B0, 0x673AB7,
  0x3F51B5, 0x2196F3, 0x03A9F4, 0x00BCD4,
  0x009688, 0x4CAF50, 0x8BC34A, 0xCDDC39,
  0xFFEB3B, 0xFFC107, 0xFF9800, 0xFF5722,
];

const WORLD_HEIGHT = 40;
const SPAWN_INTERVAL = 0.016;         // ~60/s — twice as fast as before
const FILL_STABLE_TARGET = 0.3;
const PAUSE_DURATION = 0.35;
const FALL_HARD_CAP = 4;
const GRAVITY = -90;                   // heavier fall
const SPAWN_VY_MIN = -12;
const SPAWN_VY_MAX = -18;
const SPHERE_R_MIN = 0.7;              // smaller min packs tighter gaps
const SPHERE_R_MAX = 2.1;

// Sphere budget for 90% screen coverage.
//
//   N = (worldArea × FILL_TARGET × PACKING_DENSITY) / avgSphereArea
//
// worldArea comes from the orthographic camera: WORLD_HEIGHT maps to
// viewport height, so worldArea = WORLD_HEIGHT² × aspect. Packing
// density 0.62 ≈ gravity-dropped polydisperse 2D circles. We spawn
// ~30% beyond the target so the "stack reaches the top" fill check
// triggers reliably even with small gaps.
const SCREEN_FILL_TARGET = 0.9;
const PACKING_DENSITY = 0.62;
const computeSphereBudget = () => {
  const aspect = window.innerWidth / window.innerHeight;
  const worldArea = WORLD_HEIGHT * WORLD_HEIGHT * aspect;
  const rAvg = (SPHERE_R_MIN + SPHERE_R_MAX) / 2;
  const sphereArea = Math.PI * rAvg * rAvg;
  const target = Math.ceil((worldArea * SCREEN_FILL_TARGET * PACKING_DENSITY) / sphereArea);
  const max = Math.max(80, Math.min(1200, Math.round(target * 1.3)));
  const fillMin = Math.max(40, target);
  return { max, fillMin };
};

export default function SphereDropTransition({ onScreenFilled, onComplete }) {
  const containerRef = useRef(null);
  // Keep callbacks fresh without retriggering the effect.
  const onFilledRef = useRef(onScreenFilled);
  const onCompleteRef = useRef(onComplete);
  onFilledRef.current = onScreenFilled;
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const { max: MAX_SPHERES, fillMin: FILL_MIN } = computeSphereBudget();

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    // Hazy backdrop — a semi-transparent tint + blur hides the swap
    // without the hard "black screen" cut. Dashboard stays faintly
    // visible through the frosted layer while spheres drop.
    container.style.backgroundColor = 'rgba(13, 13, 18, 0)';
    container.style.backdropFilter = 'blur(0px)';
    container.style.webkitBackdropFilter = 'blur(0px)';
    container.style.transition = 'background-color 0.35s ease, backdrop-filter 0.35s ease, -webkit-backdrop-filter 0.35s ease';

    const scene = new THREE.Scene();

    let aspect = window.innerWidth / window.innerHeight;
    let worldWidth = WORLD_HEIGHT * aspect;
    const camera = new THREE.OrthographicCamera(
      -worldWidth / 2, worldWidth / 2,
      WORLD_HEIGHT / 2, -WORLD_HEIGHT / 2,
      0.1, 100,
    );
    camera.position.z = 30;

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(6, 10, 20);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbcd4ff, 0.45);
    rim.position.set(-8, -4, 12);
    scene.add(rim);

    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.allowSleep = true;
    world.defaultContactMaterial.restitution = 0.25;
    world.defaultContactMaterial.friction = 0.3;

    const sphereMat = new CANNON.Material('sphere');
    const wallMat = new CANNON.Material('wall');
    world.addContactMaterial(new CANNON.ContactMaterial(sphereMat, wallMat, {
      restitution: 0.2, friction: 0.25,
    }));
    world.addContactMaterial(new CANNON.ContactMaterial(sphereMat, sphereMat, {
      restitution: 0.15, friction: 0.35,
    }));

    const floorBody = new CANNON.Body({ mass: 0, material: wallMat });
    floorBody.addShape(new CANNON.Plane());
    floorBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    floorBody.position.set(0, -WORLD_HEIGHT / 2, 0);
    world.addBody(floorBody);

    const makeWall = (x, inwardSign) => {
      const body = new CANNON.Body({ mass: 0, material: wallMat });
      body.addShape(new CANNON.Plane());
      body.quaternion.setFromAxisAngle(
        new CANNON.Vec3(0, 1, 0),
        inwardSign > 0 ? Math.PI / 2 : -Math.PI / 2,
      );
      body.position.set(x, 0, 0);
      world.addBody(body);
      return body;
    };
    const leftWall = makeWall(-worldWidth / 2, 1);
    const rightWall = makeWall(worldWidth / 2, -1);

    const spheres = [];
    const geometries = [];
    const materials = [];

    const spawnSphere = () => {
      const r = SPHERE_R_MIN + Math.random() * (SPHERE_R_MAX - SPHERE_R_MIN);
      const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];

      const geo = new THREE.SphereGeometry(r, 24, 18);
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.12 });
      geometries.push(geo);
      materials.push(mat);

      const mesh = new THREE.Mesh(geo, mat);
      scene.add(mesh);

      const body = new CANNON.Body({
        mass: r * r,
        shape: new CANNON.Sphere(r),
        material: sphereMat,
        linearDamping: 0.04,
        angularDamping: 0.3,
        sleepSpeedLimit: 0.2,
        sleepTimeLimit: 0.5,
      });
      const xRange = worldWidth - r * 2 - 1;
      body.position.set((Math.random() - 0.5) * xRange, WORLD_HEIGHT / 2 + r + 2, 0);
      body.velocity.set(
        (Math.random() - 0.5) * 3,
        SPAWN_VY_MIN + Math.random() * (SPAWN_VY_MAX - SPAWN_VY_MIN),
        0,
      );
      world.addBody(body);

      spheres.push({ mesh, body });
    };

    const topOfStack = () => {
      let maxY = -Infinity;
      for (const { body } of spheres) {
        const top = body.position.y + body.shapes[0].radius;
        if (top > maxY) maxY = top;
      }
      return maxY;
    };

    const FALL_CUTOFF_Y = -WORLD_HEIGHT / 2 - 8;
    const pruneFallen = () => {
      for (let i = spheres.length - 1; i >= 0; i--) {
        const { mesh, body } = spheres[i];
        if (body.position.y < FALL_CUTOFF_Y) {
          scene.remove(mesh);
          world.removeBody(body);
          spheres.splice(i, 1);
        }
      }
    };

    let phase = 'spawning';
    let spawnAcc = 0;
    let fillStable = 0;
    let pauseElapsed = 0;
    let fallElapsed = 0;
    let disposed = false;
    let rafId = null;

    const onResize = () => {
      aspect = window.innerWidth / window.innerHeight;
      worldWidth = WORLD_HEIGHT * aspect;
      camera.left = -worldWidth / 2;
      camera.right = worldWidth / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      leftWall.position.x = -worldWidth / 2;
      rightWall.position.x = worldWidth / 2;
    };
    window.addEventListener('resize', onResize);

    const clock = new THREE.Clock();

    const tick = () => {
      if (disposed) return;
      const dt = Math.min(clock.getDelta(), 1 / 30);

      if (phase === 'spawning') {
        spawnAcc += dt;
        while (spawnAcc >= SPAWN_INTERVAL && spheres.length < MAX_SPHERES) {
          spawnSphere();
          spawnAcc -= SPAWN_INTERVAL;
        }
        const full = topOfStack() >= WORLD_HEIGHT / 2 - 0.8 && spheres.length >= FILL_MIN;
        const enterPausing = () => {
          phase = 'pausing';
          pauseElapsed = 0;
          container.style.backgroundColor = 'rgba(13, 13, 18, 0.55)';
          container.style.backdropFilter = 'blur(14px)';
          container.style.webkitBackdropFilter = 'blur(14px)';
          try { onFilledRef.current?.(); } catch (err) { console.error(err); }
        };
        if (full) {
          fillStable += dt;
          if (fillStable >= FILL_STABLE_TARGET) enterPausing();
        } else {
          fillStable = 0;
        }
        if (spheres.length >= MAX_SPHERES && phase === 'spawning') enterPausing();
      } else if (phase === 'pausing') {
        pauseElapsed += dt;
        if (pauseElapsed >= PAUSE_DURATION) {
          phase = 'falling';
          world.removeBody(floorBody);
          for (const { body } of spheres) body.wakeUp();
          // Backdrop stays opaque through the fall so the dashboard
          // underneath stays hidden until every sphere is out of view.
        }
      } else if (phase === 'falling') {
        fallElapsed += dt;
        pruneFallen();
        if (spheres.length === 0 || fallElapsed >= FALL_HARD_CAP) {
          phase = 'revealing';
          // Drop any lingering spheres so we don't leave a frozen frame.
          for (const { mesh, body } of spheres) {
            scene.remove(mesh);
            world.removeBody(body);
          }
          spheres.length = 0;
          renderer.render(scene, camera);
          // Short backdrop fade → clean reveal of the dashboard, then unmount.
          container.style.backgroundColor = 'rgba(13, 13, 18, 0)';
          container.style.backdropFilter = 'blur(0px)';
          container.style.webkitBackdropFilter = 'blur(0px)';
          setTimeout(() => {
            try { onCompleteRef.current?.(); } catch (err) { console.error(err); }
          }, 280);
          return;
        }
      }

      world.step(1 / 60, dt, 3);

      for (const { mesh, body } of spheres) {
        body.position.z = 0;
        body.velocity.z = 0;
        mesh.position.copy(body.position);
        mesh.quaternion.copy(body.quaternion);
      }

      renderer.render(scene, camera);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);

      for (const { mesh, body } of spheres) {
        scene.remove(mesh);
        world.removeBody(body);
      }
      spheres.length = 0;
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="sphere-drop-transition"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 9999,
        pointerEvents: 'none',
      }}
      data-testid="sphere-drop-transition"
    />
  );
}
