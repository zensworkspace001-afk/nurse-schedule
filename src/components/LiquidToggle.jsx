import { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import './LiquidToggle.css';

/* ─── Option definitions ─── */
const OPTIONS = [
  { id: 'sleep',    label: 'Sleep',           icon: '🌙', theme: 'sleep' },
  { id: 'dnd',      label: 'Do Not Disturb',  icon: '🔕', theme: 'dnd' },
  { id: 'personal', label: 'Personal',        icon: '👤', theme: 'personal' },
];

/* Height of each button + gap between them */
const BTN_H   = 56;
const GAP     = 6;
const STEP    = BTN_H + GAP;
const PAD_TOP = 10; // track padding

/* ─── Helpers ─── */
function yForIndex(i) {
  return PAD_TOP + i * STEP;
}

/* ─── Component ─── */
export default function LiquidToggle() {
  const [active, setActive] = useState(0);
  const trackRef = useRef(null);

  /* Drag handling — vertical only, snap to nearest slot */
  const handleDragEnd = (_e, info) => {
    const currentY = yForIndex(active) + info.offset.y;
    let nearest = 0;
    let minDist = Infinity;
    for (let i = 0; i < OPTIONS.length; i++) {
      const dist = Math.abs(currentY - yForIndex(i));
      if (dist < minDist) {
        minDist = dist;
        nearest = i;
      }
    }
    setActive(nearest);
  };

  const theme = OPTIONS[active].theme;

  return (
    <div className="liquid-toggle">
      {/* ── SVG Goo Filter Definition ── */}
      <svg className="liquid-toggle__filter" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="goo-filter">
            {/* Blur both the indicator and buttons so edges merge */}
            <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="blur" />
            {/* Bump alpha contrast so the blurred merge sharpens back into a solid */}
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0
                      0 1 0 0 0
                      0 0 1 0 0
                      0 0 0 20 -9"
              result="goo"
            />
            {/* Composite original source over goo for crisp text */}
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>

      <div>
        {/* ── Goo-filtered layer (buttons + indicator share the filter) ── */}
        <div className="liquid-toggle__goo-layer">
          <div className="liquid-toggle__track" ref={trackRef}>
            {/* Animated indicator pill */}
            <motion.div
              className={`liquid-toggle__indicator liquid-toggle__indicator--${theme}`}
              animate={{ y: yForIndex(active) }}
              transition={{
                type: 'spring',
                stiffness: 180,
                damping: 22,
                mass: 1.2,
              }}
              drag="y"
              dragConstraints={{
                top: yForIndex(0) - yForIndex(active),
                bottom: yForIndex(OPTIONS.length - 1) - yForIndex(active),
              }}
              dragElastic={0.15}
              onDragEnd={handleDragEnd}
              style={{ top: 0 }}
            >
              {/* Glass overlay — lives outside goo filter z-order trick */}
              <div
                className="liquid-toggle__indicator-glass"
                style={{ '--glow-color': undefined }}
              />
            </motion.div>

            {/* Buttons */}
            {OPTIONS.map((opt, i) => (
              <button
                key={opt.id}
                className={`liquid-toggle__btn ${i === active ? 'liquid-toggle__btn--active' : ''}`}
                onClick={() => setActive(i)}
              >
                <span className="liquid-toggle__icon">{opt.icon}</span>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Status label ── */}
        <AnimatePresence mode="wait">
          <motion.p
            key={active}
            className="liquid-toggle__status"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
          >
            {OPTIONS[active].icon}  {OPTIONS[active].label} mode active
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}
