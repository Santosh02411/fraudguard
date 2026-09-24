import { useEffect, useRef, useState } from 'react';

/**
 * Animates a displayed number from its previous value to `value` over
 * `duration` ms, instead of stat cards just snapping to the new figure
 * every time fresh data (or a WebSocket push) lands. Purely cosmetic —
 * the real value is always what gets returned once the animation settles.
 *
 * Non-finite/non-numeric input (e.g. still loading) passes straight
 * through with no animation, so callers don't need to guard against it.
 */
export default function useCountUp(value, duration = 600) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(null);
  const prefersReducedMotion = useRef(
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  );

  useEffect(() => {
    if (typeof value !== 'number' || !Number.isFinite(value) || prefersReducedMotion.current) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }

    const from = fromRef.current;
    const to = value;
    if (from === to) return;

    const start = performance.now();
    cancelAnimationFrame(rafRef.current);

    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      // Ease-out cubic — fast start, gentle settle, matches the rest of
      // the app's entrance animations (see index.css's cubic-bezier).
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = from + (to - from) * eased;
      setDisplay(progress >= 1 ? to : next);
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return display;
}
