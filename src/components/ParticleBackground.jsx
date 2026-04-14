import { useEffect, useRef } from 'react';

/*
  Lightweight Canvas particle field.
  - Floating dots drift slowly and connect with faint lines when close.
  - Mouse proximity gently repels nearby particles.
  - Colours match the app's cold blue-grey palette.
*/

const CONFIG = {
  /** particles per 10 000 px² of screen area */
  density: 0.35,
  maxParticles: 120,
  /** max connection distance (px) */
  linkDist: 140,
  /** line opacity at distance 0 */
  linkAlpha: 0.18,
  /** base particle radius range */
  radiusMin: 1,
  radiusMax: 2.5,
  /** drift speed range (px / frame) */
  speedMin: 0.15,
  speedMax: 0.45,
  /** mouse repel radius & strength */
  mouseRadius: 120,
  mouseForce: 0.025,
  /** palette — RGBA bases (alpha is set dynamically) */
  colors: [
    [180, 200, 220],   // cool silver
    [120, 160, 200],   // muted blue
    [160, 180, 195],   // slate
    [100, 140, 180],   // steel blue
  ],
};

function rand(min, max) { return Math.random() * (max - min) + min; }

function createParticle(w, h) {
  const c = CONFIG.colors[Math.floor(Math.random() * CONFIG.colors.length)];
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx: rand(-CONFIG.speedMax, CONFIG.speedMax) || CONFIG.speedMin,
    vy: rand(-CONFIG.speedMax, CONFIG.speedMax) || CONFIG.speedMin,
    r: rand(CONFIG.radiusMin, CONFIG.radiusMax),
    color: c,
    alpha: rand(0.3, 0.7),
  };
}

export default function ParticleBackground() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let w, h, particles, animId;
    const mouse = { x: -9999, y: -9999 };

    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
      const count = Math.min(
        Math.floor((w * h) / 10000 * CONFIG.density),
        CONFIG.maxParticles
      );
      /* keep existing particles, add/remove to match count */
      if (!particles) particles = [];
      while (particles.length < count) particles.push(createParticle(w, h));
      particles.length = count;
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);

      const linkDist2 = CONFIG.linkDist * CONFIG.linkDist;

      /* update + draw particles */
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        /* mouse repulsion */
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < CONFIG.mouseRadius * CONFIG.mouseRadius && dist2 > 0) {
          const dist = Math.sqrt(dist2);
          const force = (CONFIG.mouseRadius - dist) / CONFIG.mouseRadius * CONFIG.mouseForce;
          p.vx += (dx / dist) * force;
          p.vy += (dy / dist) * force;
        }

        /* drift */
        p.x += p.vx;
        p.y += p.vy;

        /* dampen velocity back toward base speed */
        p.vx *= 0.998;
        p.vy *= 0.998;

        /* wrap edges */
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10;
        if (p.y > h + 10) p.y = -10;

        /* draw dot */
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color[0]},${p.color[1]},${p.color[2]},${p.alpha})`;
        ctx.fill();

        /* draw links to nearby particles (only forward to avoid duplicates) */
        for (let j = i + 1; j < particles.length; j++) {
          const q = particles[j];
          const lx = p.x - q.x;
          const ly = p.y - q.y;
          const ld2 = lx * lx + ly * ly;
          if (ld2 < linkDist2) {
            const alpha = CONFIG.linkAlpha * (1 - Math.sqrt(ld2) / CONFIG.linkDist);
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.strokeStyle = `rgba(180,200,220,${alpha})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }

      animId = requestAnimationFrame(draw);
    }

    function onMouseMove(e) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    }
    function onMouseLeave() {
      mouse.x = -9999;
      mouse.y = -9999;
    }

    resize();
    draw();

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
