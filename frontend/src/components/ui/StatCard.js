import React from 'react';

export default function StatCard({ title, value, icon: Icon, color }) {
  return (
    <div className="bg-[#111820] border border-white/10 rounded-xl p-4 sm:p-6 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-gray-400 text-xs sm:text-sm mb-1">{title}</p>
        <p className={`text-xl sm:text-2xl font-bold tabular-nums ${color || 'text-white'}`}>{value}</p>
      </div>
      {Icon && (
        <span className={`shrink-0 flex items-center justify-center w-9 h-9 rounded-lg bg-white/5 ${color || 'text-gray-500'}`}>
          <Icon size={16} />
        </span>
      )}
    </div>
  );
}
