import React, { useState } from 'react';
import { EventCategory, WorldState } from '../sim/types';
import { computeDialectConvergence, getKingdoms } from '../sim/engine';

interface ChronicleViewProps {
  worldRef: React.MutableRefObject<WorldState>;
  onJumpToAI: (id: number) => void;
}

const FILTERS: { id: 'all' | EventCategory; label: string }[] = [
  { id: 'all', label: 'All Events' },
  { id: 'kingdom', label: 'Kingdoms' },
  { id: 'trade', label: 'Trade' },
  { id: 'combat', label: 'Combat' },
  { id: 'birth', label: 'Births' },
  { id: 'death', label: 'Deaths' },
  { id: 'memorial', label: 'Memorials' },
  { id: 'unknown', label: '??? Unknown' },
];

export function ChronicleView({ worldRef, onJumpToAI }: ChronicleViewProps) {
  const [filter, setFilter] = useState<'all' | EventCategory>('all');
  const state = worldRef.current;
  const kingdoms = getKingdoms(state);
  const dialect = computeDialectConvergence(state);
  const activeMemorials = state.memorials.filter((m) => m.used);
  const filteredEvents =
    filter === 'all' ? state.events : state.events.filter((e) => e.category === filter);

  return (
    <div className="flex-1 overflow-y-auto bg-[#080b10] p-6">
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Columns: Filterable World Chronicle */}
        <div className="lg:col-span-2 bg-[#0d121a] border border-slate-800 flex flex-col max-h-[calc(100vh-140px)]">
          <div className="p-4 border-b border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">World Chronicle</h2>
              <span className="font-mono text-xs tabular-nums text-slate-400">
                {state.totalBirths} births · {state.totalDeaths} deaths · {state.totalTrades} trades
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors border ${
                    filter === f.id
                      ? 'bg-slate-800 text-cyan-300 border-cyan-500/50'
                      : 'bg-transparent text-slate-400 border-slate-800/80 hover:text-slate-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60 font-mono text-xs tabular-nums">
            {filteredEvents.length === 0 ? (
              <div className="p-6 text-slate-500">No recorded events in this category yet.</div>
            ) : (
              filteredEvents.map((ev) => (
                <div key={ev.id} className="px-4 py-2 flex items-center gap-3">
                  <span className="text-slate-500 w-16 shrink-0">t{String(ev.tick).padStart(5, '0')}</span>
                  <span style={{ color: ev.color }} className="flex-1">
                    {ev.text}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right Column: Kingdoms, Memorials, Dialect Convergence */}
        <div className="space-y-6">
          {/* Active Kingdoms */}
          <div className="bg-[#0d121a] border border-slate-800 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">
              Active Kingdoms ({kingdoms.length})
            </h3>
            {kingdoms.length === 0 ? (
              <div className="text-xs text-slate-500 leading-relaxed">
                No sovereign courts formed yet. A kingdom emerges when at least two AIs build loyalty ≥ 55 toward a leader through proximity, protection, gifts, or social proof.
              </div>
            ) : (
              <div className="space-y-3">
                {kingdoms.map((k) => (
                  <div key={k.kingName} className="p-3 bg-[#090d14] border border-slate-800 space-y-1.5 font-mono text-xs tabular-nums">
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => onJumpToAI(k.kingId)}
                        className="text-amber-300 font-semibold hover:underline"
                      >
                        King {k.kingName}
                      </button>
                      <span className="text-slate-400">Soul {k.kingSoul}</span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Dialect: <span className="text-slate-200">{k.dialectSignature}</span>
                    </div>
                    <div className="pt-1 border-t border-slate-800/70 space-y-1">
                      {k.followers.map((f) => (
                        <div key={f.name} className="flex items-center justify-between text-[11px]">
                          <button
                            type="button"
                            onClick={() => onJumpToAI(f.id)}
                            className="text-slate-300 hover:text-cyan-300"
                          >
                            {f.name}
                          </button>
                          <span className="text-amber-200/80">loyalty {f.loyalty}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Active Memorials */}
          <div className="bg-[#0d121a] border border-slate-800 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">
              Memorial Monuments ({activeMemorials.length})
            </h3>
            {activeMemorials.length === 0 ? (
              <div className="text-xs text-slate-500">
                Famous deceased AIs with a nearby witness leave golden memorials preserving Q-knowledge and phonemes.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-44 overflow-y-auto font-mono text-xs tabular-nums">
                {activeMemorials.map((m, idx) => (
                  <div
                    key={`${m.fromName}-${idx}`}
                    className="flex items-center justify-between py-1 border-b border-slate-800/60 last:border-0"
                  >
                    <span className="text-amber-300">
                      {m.fromName}
                      {m.wasKing ? ' (King)' : ''}
                    </span>
                    <span className="text-slate-400">
                      @{m.x},{m.y} · S{m.legacySoul} · k{m.legacyKills}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Dialect Convergence */}
          <div className="bg-[#0d121a] border border-slate-800 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">Population Dialect Alignment</h3>
            <div className="space-y-1.5 font-mono text-xs tabular-nums">
              {dialect.map((d) => (
                <div key={d.concept} className="flex items-center gap-2.5">
                  <span className="w-10 text-slate-400">{d.concept}</span>
                  <span className="w-6 text-amber-300">S{d.dominantSound}</span>
                  <div className="flex-1 h-1.5 bg-slate-800">
                    <div
                      className="h-full bg-cyan-500"
                      style={{ width: `${d.agreementPct}%` }}
                    />
                  </div>
                  <span className="w-9 text-right text-slate-300">{d.agreementPct}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
