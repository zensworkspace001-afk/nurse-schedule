import { useState, useCallback } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform, animate } from 'framer-motion';
import './LiquidToggle.css';

/* ─── Option definitions ─── */
const OPTIONS = [
  { id: 'sleep',    label: 'Sleep',           icon: '🌙' },
  { id: 'dnd',      label: 'Do Not Disturb',  icon: '🔕' },
  { id: 'personal', label: 'Personal',        icon: '👤' },
];

/* ─── Layout constants ─── */
const BTN_W       = 220;
const BTN_H       = 60;
const GAP         = 8;
const PAD         = 12;
const SLOT_H      = BTN_H + GAP;
const INDICATOR_H = 52;
const INDICATOR_W = BTN_W - 12;

/* Vertical center of the indicator inside slot i */
function yForIndex(i) {
  return PAD + i * SLOT_H + (BTN_H - INDICATOR_H) / 2;
}

/* ─── Color themes per state ─── */
const THEMES = {
  sleep:    { bg: 'rgba(59,130,246,0.7)',  glow: 'rgba(59,130,246,0.35)',  glowWide: 'rgba(59,130,246,0.1)' },
  dnd:      { bg: 'rgba(239,68,68,0.7)',   glow: 'rgba(239,68,68,0.35)',   glowWide: 'rgba(239,68,68,0.1)' },
  personal: { bg: 'rgba(245,158,11,0.7)',  glow: 'rgba(245,158,11,0.35)',  glowWide: 'rgba(245,158,11,0.1)' },
};

/* ─── Pill blob (used for buttons AND indicator in the goo layer) ─── */
function Blob({ y, width, height, color, className, style }) {
  return (
    <motion.div
      className={`lt-blob ${className || ''}`}
      style={{
        width,
        height,
        borderRadius: height / 2,
        background: color,
        y,
        ...style,
      }}
    />
  );
}

/* ═══════════════════════════════════════
   Main Component
   ═══════════════════════════════════════ */
export default function LiquidToggle() {
  const [active, setActive] = useState(0);
  const [, setDragging] = useState(false);

  /* Motion value for the indicator Y — drives both the goo blob and the glass overlay */
  const indicatorY = useMotionValue(yForIndex(0));

  /* Derived: which slot is closest right now (for live color transitions while dragging) */
  const closestIndex = useTransform(indicatorY, (y) => {
    let nearest = 0;
    let minDist = Infinity;
    for (let i = 0; i < OPTIONS.length; i++) {
      const d = Math.abs(y - yForIndex(i));
      if (d < minDist) { minDist = d; nearest = i; }
    }
    return nearest;
  });

  /* Animate indicator to a slot */
  const goToSlot = useCallback((i) => {
    setActive(i);
    animate(indicatorY, yForIndex(i), {
      type: 'spring',
      stiffness: 160,
      damping: 18,
      mass: 1.3,
    });
  }, [indicatorY]);

  /* Drag handlers */
  const handleDragStart = () => setDragging(true);

  const handleDrag = () => {
    /* Update active color in real-time based on closest slot */
    const nearest = closestIndex.get();
    if (nearest !== active) setActive(nearest);
  };

  const handleDragEnd = () => {
    setDragging(false);
    const nearest = closestIndex.get();
    setActive(nearest);
    /* Snap with spring */
    animate(indicatorY, yForIndex(nearest), {
      type: 'spring',
      stiffness: 200,
      damping: 20,
      mass: 1,
    });
  };

  const theme = THEMES[OPTIONS[active].id];
  const trackH = PAD * 2 + OPTIONS.length * BTN_H + (OPTIONS.length - 1) * GAP;

  return (
    <div className="lt">
      {/* ── SVG Goo Filter ── */}
      <svg className="lt__svg" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="goo">
            <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0
                      0 1 0 0 0
                      0 0 1 0 0
                      0 0 0 18 -7"
              result="goo"
            />
            {/* blend the goo back so edges stay smooth */}
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
        </defs>
      </svg>

      <div className="lt__wrapper">
        {/* ─── LAYER 1: Goo-filtered blobs (no text here!) ─── */}
        <div className="lt__goo" style={{ width: BTN_W + PAD * 2, height: trackH }}>
          {/* Static button blobs */}
          {OPTIONS.map((_, i) => (
            <Blob
              key={i}
              y={PAD + i * SLOT_H}
              width={BTN_W}
              height={BTN_H}
              color="rgba(255,255,255,0.05)"
              className="lt-blob--btn"
              style={{ position: 'absolute', left: PAD }}
            />
          ))}

          {/* Draggable indicator blob — this is the goo source */}
          <motion.div
            className="lt-blob lt-blob--indicator"
            style={{
              position: 'absolute',
              left: PAD + (BTN_W - INDICATOR_W) / 2,
              width: INDICATOR_W,
              height: INDICATOR_H,
              borderRadius: INDICATOR_H / 2,
              background: theme.bg,
              y: indicatorY,
              cursor: 'grab',
            }}
            drag="y"
            dragConstraints={{
              top: yForIndex(0),
              bottom: yForIndex(OPTIONS.length - 1),
            }}
            dragElastic={0.08}
            dragMomentum={false}
            onDragStart={handleDragStart}
            onDrag={handleDrag}
            onDragEnd={handleDragEnd}
            whileDrag={{ cursor: 'grabbing', scale: 1.04 }}
          />
        </div>

        {/* ─── LAYER 2: Glass track + labels (NOT filtered) ─── */}
        <div className="lt__glass-track" style={{ width: BTN_W + PAD * 2, height: trackH }}>
          {/* Glossy overlay on the indicator */}
          <motion.div
            className="lt__indicator-shine"
            style={{
              width: INDICATOR_W,
              height: INDICATOR_H,
              left: PAD + (BTN_W - INDICATOR_W) / 2,
              borderRadius: INDICATOR_H / 2,
              y: indicatorY,
              '--glow': theme.glow,
              '--glow-wide': theme.glowWide,
            }}
          />

          {/* Button labels */}
          {OPTIONS.map((opt, i) => (
            <button
              key={opt.id}
              className={`lt__btn ${i === active ? 'lt__btn--active' : ''}`}
              style={{
                top: PAD + i * SLOT_H,
                width: BTN_W,
                height: BTN_H,
              }}
              onClick={() => goToSlot(i)}
            >
              <span className="lt__icon">{opt.icon}</span>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Status text ─── */}
      <AnimatePresence mode="wait">
        <motion.p
          key={active}
          className="lt__status"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
          style={{ color: theme.glow }}
        >
          {OPTIONS[active].icon}  {OPTIONS[active].label}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}
