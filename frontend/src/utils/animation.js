/**
 * Inline style for the Nth item in a staggered entrance (see
 * `.animate-row-in` in index.css). Delay is capped at `maxDelayMs` so a
 * long table/list doesn't leave later rows visibly waiting in a queue —
 * everything past the cap just animates together at the cap's delay.
 */
export function staggerDelay(index, { stepMs = 25, maxDelayMs = 300 } = {}) {
  return { animationDelay: `${Math.min(index * stepMs, maxDelayMs)}ms` };
}
