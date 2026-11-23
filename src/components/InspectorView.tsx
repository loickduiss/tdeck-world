import React, { useState } from 'react';
import {
  ACT_NAMES,
  CARRY_NAMES,
  CONCEPT_NAMES,
  DAY_TICKS,
  N_CONCEPTS,
  N_SOUNDS,
  Q_ACTIONS,
  WorldState,
} from '../sim/types';
import { decodeQState, getLifeStage, isMonster } from '../sim/engine';
import {
  decodeAllMemories,
  downloadMemoryFile,
  formatMemorySummary,
  RECORD_BYTES,
} from '../sim/memoryStore';
import { AIShapeIcon } from './AIShapeIcon';
import { PovRaycasterCanvas } from './PovRaycasterCanvas';
import { GrowthDnaCanvas } from './GrowthDnaCanvas';
import { ChevronLeft, ChevronRight, Download, ArrowLeft } from 'lucide-react';

export type InspectorSection =
  | 'pov'
  | 'growth'
  | 'needs'
  | 'brain'
  | 'relations'
  | 'language'
  | 'memory';

interface InspectorViewProps {
  worldRef: React.MutableRefObject<WorldState>;
  selectedAI: number;
  activeSection: InspectorSection;
  onSelectSection: (s: InspectorSection) => void;
  onCycleAI: (dir: number) => void;
  onClose: () => void;
}

const SECTION_TABS: { id: InspectorSection; label: string }[] = [
  { id: 'pov', label: 'First-Person POV' },
  { id: 'growth', label: 'Neural Growth' },
  { id: 'needs', label: 'Needs & Senses' },
  { id: 'brain', label: 'Q-Table Brain' },
  { id: 'relations', label: 'Loyalty & Lineage' },
  { id: 'language', label: 'Language Matrix' },
  { id: 'memory', label: 'SD Memory (.dat)' },
];

function RadialGauge({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  const r = 42;
  const circ = 2 * Math.PI * r;
  const dash = circ * clamped;

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-28 h-28 flex items-center justify-center">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r={r} fill="none" stroke="#1e293b" strokeWidth="7" />
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="7"
            strokeDasharray={`${dash} ${circ}`}
            strokeLinecap="butt"
          />
        </svg>
        <span className="absolute font-mono text-lg font-semibold tabular-nums text-slate-100">
          {Math.round(clamped * 100)}%
        </span>
      </div>
      <span className="mt-2 font-mono text-xs text-slate-400">{label}</span>
    </div>
  );
}

export function InspectorView({
  worldRef,
  selectedAI,
  activeSection,
  onSelectSection,
  onCycleAI,
  onClose,
}: InspectorViewProps) {
  const [showHex, setShowHex] = useState(false);
  const state = worldRef.current;
  const a = state.ais[selectedAI];

  if (!a) return null;

  const st = decodeQState(a.currentState);
  const stage = getLifeStage(a.age);
  const memories = activeSection === 'memory' ? decodeAllMemories(a, 100) : [];
  const sdBytes = a.sdRecordCount * RECORD_BYTES;

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#080b10]">
      {/* Subject Header Banner */}
      <div className="px-6 py-3.5 bg-[#0d121a] border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-[#131a25] border border-slate-800 hover:border-slate-700 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Map (R)
          </button>

          <div className="flex items-center gap-2.5">
            <AIShapeIcon shape={a.shape} color={a.color} size={22} />
            <span className={`font-mono text-2xl font-semibold tracking-tight ${a.alive ? 'text-cyan-300' : 'text-rose-400'}`}>
              {a.name}
            </span>
          </div>

          <div className="flex items-center gap-2.5 font-mono text-xs tabular-nums text-slate-400">
            <span className="text-amber-300 font-medium">Soul {a.soul}</span>
            <span className="text-slate-600">·</span>
            <span>
              {(a.age / DAY_TICKS).toFixed(2)}d ({stage})
            </span>
            <span className="text-slate-600">·</span>
            <span>Carry: {CARRY_NAMES[a.carrying]}</span>
            {isMonster(a.soul) && (
              <>
                <span className="text-slate-600">·</span>
                <span className="text-rose-400 font-semibold">Monster</span>
              </>
            )}
            {a.isKing && (
              <>
                <span className="text-slate-600">·</span>
                <span className="text-amber-300 font-semibold">King ({a.followerCount} loyal)</span>
              </>
            )}
            {a.kingName && (
              <>
                <span className="text-slate-600">·</span>
                <span className="text-amber-200">Follower of {a.kingName}</span>
              </>
            )}
          </div>
        </div>

        {/* AI Switcher */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onCycleAI(-1)}
            className="px-2.5 py-1.5 text-xs font-mono text-slate-300 hover:text-white bg-[#131a25] border border-slate-800 hover:border-slate-700 flex items-center gap-1"
            title="Previous AI (P)"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            Prev
          </button>
          <button
            type="button"
            onClick={() => onCycleAI(+1)}
            className="px-2.5 py-1.5 text-xs font-mono text-slate-300 hover:text-white bg-[#131a25] border border-slate-800 hover:border-slate-700 flex items-center gap-1"
            title="Next AI (p)"
          >
            Next
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Section Tab Bar */}
      <div className="px-6 py-2 bg-[#0a0e15] border-b border-slate-800/80 flex items-center gap-1 overflow-x-auto">
        {SECTION_TABS.map((tab) => {
          const active = activeSection === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectSection(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors border ${
                active
                  ? 'bg-[#141c28] text-cyan-300 border-cyan-500/50'
                  : 'bg-transparent text-slate-400 border-transparent hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Active Section Canvas / Panel */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-5xl mx-auto h-full">
          {activeSection === 'pov' && (
            <div className="flex flex-col gap-3 h-[calc(100vh-220px)] min-h-[400px]">
              <div className="flex items-center justify-between font-mono text-xs text-slate-400">
                <span>First-Person Raycaster — 66° FOV DDA projection with Z-buffered billboards</span>
                <span>Use p / P to switch subjects</span>
              </div>
              <div className="flex-1 border border-slate-800 overflow-hidden">
                <PovRaycasterCanvas worldRef={worldRef} selectedAI={selectedAI} showHud={true} />
              </div>
            </div>
          )}

          {activeSection === 'growth' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 h-[420px] border border-slate-800 overflow-hidden">
                <GrowthDnaCanvas worldRef={worldRef} selectedAI={selectedAI} />
              </div>
              <div className="bg-[#0d121a] border border-slate-800 p-5 space-y-4">
                <h3 className="text-sm font-semibold text-slate-100">Organic Neural Topology</h3>
                <p className="text-xs leading-relaxed text-slate-400">
                  Deterministic RAM-cell geometry seeded from {a.name}&apos;s identity. Active node count
                  scales directly with accumulated soul mass, reflecting expanded sensory reach and working memory.
                </p>
                <div className="space-y-2.5 pt-2 border-t border-slate-800 font-mono text-xs tabular-nums">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Soul mass</span>
                    <span className="text-cyan-300">{a.soul}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Active RAM cells</span>
                    <span className="text-slate-200">{Math.max(2, Math.min(20, Math.floor(a.soul / 9) + 2))}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Vision depth</span>
                    <span className="text-slate-200">{a.fov} tiles</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Working memory buffer</span>
                    <span className="text-slate-200">{a.workingMemory.length} / 50 events</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">SD archive footprint</span>
                    <span className="text-slate-200">{sdBytes} bytes ({a.sdRecordCount} rec)</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Deep history recalls</span>
                    <span className="text-slate-200">{a.recalls}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'needs' && (
            <div className="space-y-6">
              <div className="bg-[#0d121a] border border-slate-800 p-6">
                <h3 className="text-sm font-semibold text-slate-100 mb-6">Metabolic Gauges</h3>
                <div className="grid grid-cols-3 gap-6">
                  <RadialGauge label="Hunger" value={a.hunger} color="#ef4444" />
                  <RadialGauge label="Thirst" value={a.thirst} color="#38bdf8" />
                  <RadialGauge label="Energy" value={a.energy} color="#22c55e" />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-[#0d121a] border border-slate-800 p-5 space-y-4">
                  <h3 className="text-sm font-semibold text-slate-100">Innate Dispositions</h3>
                  {[
                    { label: 'Aggression', v: a.aggression, col: 'bg-rose-500' },
                    { label: 'Curiosity', v: a.curiosity, col: 'bg-cyan-500' },
                    { label: 'Trust', v: a.trust, col: 'bg-emerald-500' },
                  ].map((d) => (
                    <div key={d.label} className="space-y-1">
                      <div className="flex justify-between font-mono text-xs tabular-nums">
                        <span className="text-slate-300">{d.label}</span>
                        <span className="text-slate-200">{d.v.toFixed(2)}</span>
                      </div>
                      <div className="h-1.5 bg-slate-800">
                        <div className={`h-full ${d.col}`} style={{ width: `${Math.round(d.v * 100)}%` }} />
                      </div>
                    </div>
                  ))}
                  <div className="pt-2 border-t border-slate-800 flex justify-between font-mono text-xs text-slate-400">
                    <span>Vision Cone: {a.fov} tiles</span>
                    <span>Hearing Radius: {a.hearing} tiles</span>
                  </div>
                </div>

                <div className="bg-[#0d121a] border border-slate-800 p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-100">
                    Superstitions & Taboo Zones ({a.superstitions.length})
                  </h3>
                  <p className="text-xs text-slate-400">
                    False spatial beliefs formed after unexplained random damage or mysterious soul boons.
                  </p>
                  {a.superstitions.length === 0 ? (
                    <div className="font-mono text-xs text-slate-500 pt-2">
                      No superstitious beliefs developed yet.
                    </div>
                  ) : (
                    <div className="space-y-1.5 font-mono text-xs tabular-nums pt-1">
                      {a.superstitions.map((z, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between py-1.5 border-b border-slate-800/70 last:border-0"
                        >
                          <span className={z.kind === 'taboo' ? 'text-purple-400' : 'text-sky-400'}>
                            {z.kind === 'taboo' ? 'Taboo (avoids)' : 'Lucky spot'} @({z.x},{z.y})
                          </span>
                          <span className="text-slate-400">
                            t{z.tick} · str {z.strength}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeSection === 'brain' && (
            <div className="space-y-6">
              <div className="bg-[#0d121a] border border-slate-800 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      Current State Q-Values (State #{a.currentState} of 48)
                    </h3>
                    <div className="mt-1 font-mono text-xs text-slate-400 tabular-nums">
                      Need: {st.need} · Threat: {st.threat} · Food known: {st.foodKnown ? 'yes' : 'no'} · Water known: {st.waterKnown ? 'yes' : 'no'} · ε {a.epsilon.toFixed(2)} ({a.wasRandom ? 'exploring' : 'greedy'})
                    </div>
                  </div>
                  <div className="font-mono text-xs text-emerald-400">
                    &gt; {a.lastAction} <span className="text-slate-400">({a.lastReason})</span>
                  </div>
                </div>

                {/* 14-Action Q Bar Chart */}
                <div className="grid grid-cols-7 sm:grid-cols-14 gap-1.5 pt-2">
                  {ACT_NAMES.map((name, idx) => {
                    const qv =
                      a.currentState >= 0 ? a.qtable[a.currentState * Q_ACTIONS + idx] / 10 : 0;
                    const picked = idx === a.chosenAction;
                    const pct = Math.min(50, Math.abs(qv) * 4.5);
                    return (
                      <div
                        key={name}
                        className={`flex flex-col items-center p-1.5 border ${
                          picked
                            ? 'border-amber-400/80 bg-slate-900'
                            : 'border-slate-800/70 bg-[#090d14]'
                        }`}
                      >
                        <div className="relative w-full h-28 flex items-center justify-center">
                          <div className="absolute inset-x-0 top-1/2 h-px bg-slate-700" />
                          {qv >= 0 ? (
                            <div
                              className="absolute bottom-1/2 w-3 bg-emerald-500/85"
                              style={{ height: `${pct}%` }}
                            />
                          ) : (
                            <div
                              className="absolute top-1/2 w-3 bg-rose-500/85"
                              style={{ height: `${pct}%` }}
                            />
                          )}
                        </div>
                        <span
                          className={`mt-1.5 font-mono text-[10px] ${
                            picked ? 'text-amber-300 font-semibold' : 'text-slate-400'
                          }`}
                        >
                          {name}
                        </span>
                        <span className="font-mono text-[10px] tabular-nums text-slate-300">
                          {qv >= 0 ? `+${qv.toFixed(1)}` : qv.toFixed(1)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Working Memory (RAM) */}
              <div className="bg-[#0d121a] border border-slate-800 p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-100">
                    Working Memory (RAM — Last {a.workingMemory.length} Events)
                  </h3>
                  <span className="font-mono text-xs text-slate-500">Full precision, fast decay</span>
                </div>
                {a.workingMemory.length === 0 ? (
                  <div className="font-mono text-xs text-slate-500">No recent working memory entries.</div>
                ) : (
                  <div className="max-h-56 overflow-y-auto divide-y divide-slate-800/60 font-mono text-xs tabular-nums">
                    {a.workingMemory.slice(0, 25).map((entry, idx) => (
                      <div key={idx} className="py-1.5 flex items-center justify-between gap-4">
                        <span className="text-slate-500 shrink-0">t{entry.tick}</span>
                        <span
                          className={`flex-1 ${
                            entry.category === 'unknown'
                              ? 'text-purple-400'
                              : entry.category === 'memory'
                              ? 'text-cyan-300'
                              : entry.category === 'social'
                              ? 'text-amber-200'
                              : 'text-slate-300'
                          }`}
                        >
                          {entry.summary}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeSection === 'relations' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 bg-[#0d121a] border border-slate-800 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-100">
                    Trust & Sticky Loyalty Map
                  </h3>
                  <span className="font-mono text-xs text-slate-400">
                    Follower threshold: Loyalty ≥ 55
                  </span>
                </div>

                {a.relations.length === 0 ? (
                  <div className="font-mono text-xs text-slate-500 py-6">
                    {a.name} has not formed social impressions yet.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {[...a.relations]
                      .sort((r1, r2) => r2.loyalty - r1.loyalty || Math.abs(r2.trust) - Math.abs(r1.trust))
                      .map((rel) => {
                        const tier =
                          rel.trust > 70
                            ? 'mate'
                            : rel.trust > 40
                            ? 'ally'
                            : rel.trust > 10
                            ? 'friend'
                            : rel.trust < -70
                            ? 'enemy'
                            : rel.trust < -30
                            ? 'rival'
                            : 'neutral';
                        return (
                          <div
                            key={rel.name}
                            className="p-3 bg-[#090d14] border border-slate-800/80 space-y-2 font-mono text-xs tabular-nums"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-slate-100">{rel.name}</span>
                                <span className="text-slate-400">· {tier}</span>
                                {a.kingName === rel.name && (
                                  <span className="text-amber-300 font-semibold">· Sovereign</span>
                                )}
                              </div>
                              <span className="text-slate-400">
                                {rel.trades} trades · seen t{rel.lastTick}
                              </span>
                            </div>

                            {/* Trust signed bar */}
                            <div className="flex items-center gap-3">
                              <span className="w-16 text-slate-400">Trust</span>
                              <div className="relative flex-1 h-2 bg-slate-800">
                                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-slate-500" />
                                {rel.trust >= 0 ? (
                                  <div
                                    className="absolute left-1/2 top-0 bottom-0 bg-emerald-500"
                                    style={{ width: `${rel.trust / 2}%` }}
                                  />
                                ) : (
                                  <div
                                    className="absolute top-0 bottom-0 bg-rose-500"
                                    style={{
                                      left: `${50 + rel.trust / 2}%`,
                                      width: `${Math.abs(rel.trust) / 2}%`,
                                    }}
                                  />
                                )}
                              </div>
                              <span className="w-10 text-right text-slate-200">
                                {rel.trust >= 0 ? `+${rel.trust}` : rel.trust}
                              </span>
                            </div>

                            {/* Loyalty 0..100 bar */}
                            <div className="flex items-center gap-3">
                              <span className="w-16 text-slate-400">Loyalty</span>
                              <div className="relative flex-1 h-2 bg-slate-800">
                                <div
                                  className="absolute left-[55%] top-0 bottom-0 w-px bg-amber-400/70"
                                  title="Follower threshold (55)"
                                />
                                <div
                                  className={`h-full ${rel.loyalty >= 55 ? 'bg-amber-400' : 'bg-cyan-500/80'}`}
                                  style={{ width: `${rel.loyalty}%` }}
                                />
                              </div>
                              <span className="w-10 text-right text-amber-300">{rel.loyalty}</span>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>

              {/* Lineage & Standing */}
              <div className="bg-[#0d121a] border border-slate-800 p-5 space-y-4">
                <h3 className="text-sm font-semibold text-slate-100">Lineage & Standing</h3>
                <div className="space-y-2.5 font-mono text-xs tabular-nums">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Origin</span>
                    <span className="text-slate-200">
                      {a.parent1 ? `${a.parent1} + ${a.parent2}` : 'First-gen soul pool'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Children bred</span>
                    <span className="text-slate-200">{a.numChildren}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Role</span>
                    <span className="text-amber-300">
                      {a.isKing
                        ? `King (${a.followerCount} followers)`
                        : a.kingName
                        ? `Follower of ${a.kingName}`
                        : 'Independent'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Trades completed</span>
                    <span className="text-emerald-400">{a.trades}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Kills / Helps</span>
                    <span className="text-slate-200">
                      {a.kills} / {a.helps}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Food eaten</span>
                    <span className="text-slate-200">{a.foodEaten}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'language' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 bg-[#0d121a] border border-slate-800 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-100">
                    Ear Co-Occurrence Matrix (Sound S0–S7 × Concept)
                  </h3>
                  <span className="font-mono text-xs text-amber-300">Gold border = Mouth output</span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse font-mono text-xs tabular-nums">
                    <thead>
                      <tr>
                        <th className="p-2 text-left text-slate-500 font-normal">Phoneme</th>
                        {CONCEPT_NAMES.map((c) => (
                          <th key={c} className="p-2 text-center text-slate-300 font-medium">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: N_SOUNDS }).map((_, snd) => (
                        <tr key={snd}>
                          <td className="p-2 text-slate-400 font-medium">S{snd}</td>
                          {Array.from({ length: N_CONCEPTS }).map((__, c) => {
                            const val = a.ear[snd * N_CONCEPTS + c];
                            const isMouth = a.mouth[c] === snd;
                            const alpha = Math.min(0.95, val / 35);
                            return (
                              <td key={c} className="p-1">
                                <div
                                  className={`h-9 flex items-center justify-center text-[11px] border ${
                                    isMouth ? 'border-amber-400 font-semibold text-white' : 'border-slate-800/80 text-slate-300'
                                  }`}
                                  style={{
                                    backgroundColor:
                                      val > 0
                                        ? `rgba(16, 185, 129, ${Math.max(0.12, alpha)})`
                                        : '#090d14',
                                  }}
                                >
                                  {val}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="bg-[#0d121a] border border-slate-800 p-5 space-y-4">
                <h3 className="text-sm font-semibold text-slate-100">Mouth Phoneme Map</h3>
                <div className="space-y-1.5 font-mono text-xs tabular-nums">
                  {CONCEPT_NAMES.map((c, idx) => (
                    <div
                      key={c}
                      className="flex items-center justify-between py-1 border-b border-slate-800/60 last:border-0"
                    >
                      <span className="text-slate-300">{c}</span>
                      <span className="text-amber-300">→ S{a.mouth[idx]}</span>
                    </div>
                  ))}
                </div>

                <div className="pt-3 border-t border-slate-800 font-mono text-xs space-y-1">
                  <div className="text-slate-400">Last Heard Signal</div>
                  {a.lastHeardSound >= 0 && state.tick - a.lastHeardTick < 80 ? (
                    <div className="text-cyan-300">
                      {a.lastHeardFrom} emitted S{a.lastHeardSound} (t{a.lastHeardTick})
                    </div>
                  ) : (
                    <div className="text-slate-500">No recent acoustic signal</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeSection === 'memory' && (
            <div className="bg-[#0d121a] border border-slate-800 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100 font-mono">
                    memories/{a.name}.dat
                  </h3>
                  <div className="mt-0.5 font-mono text-xs text-slate-400 tabular-nums">
                    {a.sdRecordCount} quantized records × 16 bytes = {sdBytes} bytes on virtual SD · {a.recalls} on-demand recalls
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowHex((v) => !v)}
                    className={`px-3 py-1.5 text-xs font-mono border transition-colors ${
                      showHex
                        ? 'bg-slate-800 text-cyan-300 border-cyan-500/50'
                        : 'bg-[#111824] text-slate-300 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    {showHex ? 'Hide Raw Hex' : 'Show 16B Hex'}
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadMemoryFile(a)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-950 bg-cyan-400 hover:bg-cyan-300 transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export .dat
                  </button>
                </div>
              </div>

              <div className="border border-slate-800/90 bg-[#080c12] max-h-[430px] overflow-y-auto divide-y divide-slate-800/60 font-mono text-xs tabular-nums">
                {memories.length === 0 ? (
                  <div className="p-4 text-slate-500">Archive empty.</div>
                ) : (
                  memories.map((rec, idx) => (
                    <div key={`${rec.tick}-${idx}`} className="px-3.5 py-2 space-y-1">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-slate-200">{formatMemorySummary(rec)}</span>
                        {rec.loyaltyDelta !== 0 && (
                          <span className={rec.loyaltyDelta > 0 ? 'text-amber-300' : 'text-rose-400'}>
                            loy {rec.loyaltyDelta > 0 ? `+${rec.loyaltyDelta}` : rec.loyaltyDelta}
                          </span>
                        )}
                      </div>
                      {showHex && (
                        <div className="text-[11px] text-slate-500 tracking-tight">
                          [{rec.rawHex}]
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
