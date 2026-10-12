import React from 'react';
import useCountUp from '../hooks/useCountUp';

/**
 * A single stat tile: label, a big number, and an icon badge. The number
 * animates toward its new value (via useCountUp) instead of snapping —
 * noticeable on first load and again on every live WebSocket update.
 *
 * `value` should be the raw number; `format` turns the in-flight animated
 * number into the string actually shown (currency, %, thousands commas,
 * etc). If `value` isn't numeric (e.g. still loading), it's shown as-is
 * with no animation.
 */
export default function StatCard({ title, value, format, icon: Icon, color }) {
  const isNumeric = typeof value === 'number' && Number.isFinite(value);
  const animated = useCountUp(isNumeric ? value : 0);
  const display = isNumeric ? (format ? format(animated) : Math.round(animated).toLocaleString()) : value;

  return (
    <div className="hover-lift group bg-[#111820] border border-white/10 rounded-xl p-6 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-gray-400 text-sm mb-1">{title}</p>
        <p className={`text-2xl font-bold tabular-nums ${color || 'text-white'}`}>{display}</p>
      </div>
      {Icon && (
        <span
          className={`shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-white/5 transition-transform duration-300 group-hover:scale-110 group-hover:bg-white/10 ${color || 'text-gray-500'}`}
        >
          <Icon size={16} />
        </span>
      )}
    </div>
  );
}
