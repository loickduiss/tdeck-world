import React from 'react';
import {
  ACT_NAMES,
  CARRY_NAMES,
  CONCEPT_NAMES,
  DAY_TICKS,
  N_CONCEPTS,
  Q_ACTIONS,
  WorldState,
} from '../sim/types';
import { decodeQState, getLifeStage, isMonster } from '../sim/engine';
import { RECORD_BYTES } from '../sim/memoryStore';
import { AIShapeIcon } from './AIShapeIcon';
import { PovRaycasterCanvas } from './PovRaycasterCanvas';
import { Crosshair, Maximize2 } from 'lucide-react';

interface SidePanelProps {
  worldRef: React.MutableRefObject<WorldState>;
  selectedAI: number;
  onSelectAI: (id: number) => void;
  onCenterSelected: () => void;
  onOpenInspector: (section?: string) => void;
}

export function SidePanel({
  worldRef,
  selectedAI,
  onSelectAI,
  onCenterSelected,
  onOpenInspector,
}: SidePanelProps) {
  const state = worldRef.current;
  const a = state.ais[selectedAI];

  if (!a) return null;

  const st = decodeQState(a.currentState);
  const stage = getLifeStage(a.age);
  const dirs = ['N', 'E', 'S', 'W'];

  // Top 4 Q actions for current state
  const topQ: { idx: number; val: number }[] = [];
  if (a.currentState >= 0) {
    for (let i = 0; i < Q_ACTIONS; i++) {
      topQ.push({ idx: i, val: a.qtable[a.currentState * Q_ACTIONS + i] / 10 });
    }
    topQ.sort((x, y) => y.val - x.val);
  }

  // Last heard decoding
  let heardStr = 'silent';
  if (a.lastHeardSound >= 0 && state.tick - a.lastHeardTick < 50) {
    let bestC = 0;
    for (let c = 1; c < N_CONCEPTS; c++) {
      if (
        a.ear[a.lastHeardSound * N_CONCEPTS + c] >
        a.ear[a.lastHeardSound * N_CONCEPTS + bestC]
      ) {
        bestC = c;
      }
    }
    heardStr = `${a.lastHeardFrom} S${a.lastHeardSound} → "${CONCEPT_NAMES[bestC]}"`;
  }

  // Top 3 relationships sorted by max(|trust|, loyalty)
  const topRels = [...a.relations]
    .sort((r1, r2) => Math.max(Math.abs(r2.trust), r2.loyalty) - Math.max(Math.abs(r1.trust), r1.loyalty))
    .slice(0, 3);

  const sdBytes = a.sdRecordCount * RECORD_BYTES;

  return (
    <aside className="w-[348px] shrink-0 h-full bg-[#0d121a] border-l border-slate-800/90 flex flex-col overflow-hidden">
      {/* Compact AI roster selector */}
      <div className="px-3 py-2.5 border-b border-slate-800/80 bg-[#0a0e15]">
        <div className="grid grid-cols-4 gap-1">
          {state.ais.slice(0, state.settings.paramPopulationCap).map((ai) => {
            const active = ai.id === selectedAI;
            return (
              <button
                key={ai.id}
                type="button"
                onClick={() => onSelectAI(ai.id)}
                className={`flex items-center justify-between gap-1 px-2 py-1 text-left font-mono text-[11px] tabular-nums transition-colors border ${
                  active
                    ? 'bg-slate-800/90 border-cyan-500/70 text-cyan-300'
                    : 'bg-[#0e141e] border-slate-800/70 text-slate-300 hover:border-slate-700 hover:text-white'
                } ${!ai.alive ? 'opacity-45' : ''}`}
                title={`${ai.name} · Soul ${ai.soul}`}
              >
                <span className="flex items-center gap-1 min-w-0">
                  <AIShapeIcon shape={ai.shape} color={ai.color} size={10} selected={active} />
                  <span className="truncate font-medium">{ai.name}</span>
                </span>
                <span className="text-[10px] text-slate-400">{ai.alive ? ai.soul : '×'}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Scrollable Inspector Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3.5 space-y-4">
        {/* Identity Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <AIShapeIcon shape={a.shape} color={a.color} size={18} />
              <h2 className={`font-mono text-xl font-semibold tracking-tight ${a.alive ? 'text-cyan-300' : 'text-rose-400'}`}>
                {a.name}
              </h2>
              <span className="font-mono text-xs text-slate-400">
                {!a.alive
                  ? 'Deceased'
                  : isMonster(a.soul)
                  ? 'Monster'
                  : a.isKing
                  ? `King (${a.followerCount})`
                  : a.kingName
                  ? `Loyal to ${a.kingName}`
                  : stage}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 font-mono text-xs tabular-nums text-slate-400">
              <span>Soul {a.soul}</span>
              <span className="text-slate-600">·</span>
              <span>{(a.age / DAY_TICKS).toFixed(2)}d</span>
              <span className="text-slate-600">·</span>
              <span>
                @{a.x},{a.y} {dirs[a.facing]}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={onCenterSelected}
              className="p-1.5 text-slate-400 hover:text-cyan-300 hover:bg-slate-800/80 border border-slate-800 transition-colors"
              title="Center camera on AI (Space)"
            >
              <Crosshair className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onOpenInspector('pov')}
              className="p-1.5 text-slate-400 hover:text-cyan-300 hover:bg-slate-800/80 border border-slate-800 transition-colors"
              title="Open deep inspector (R)"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Live First-Person POV Preview */}
        <button
          type="button"
          onClick={() => onOpenInspector('pov')}
          className="group relative block w-full h-28 border border-slate-800 overflow-hidden text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400"
          title="Click to open fullscreen first-person POV"
        >
          <PovRaycasterCanvas worldRef={worldRef} selectedAI={selectedAI} showHud={false} />
          <span className="absolute bottom-1.5 right-2 font-mono text-[10px] text-slate-300 bg-[#080b10]/80 px-1.5 py-0.5 opacity-80 group-hover:opacity-100 transition-opacity">
            Expand POV (R)
          </span>
        </button>

        {!a.alive ? (
          <div className="pt-2 border-t border-slate-800/70 font-mono text-xs text-slate-400 space-y-1">
            <div>Subject perished at age {(a.age / DAY_TICKS).toFixed(2)} days.</div>
            <div>
              Lifetime record: {a.kills} kills · {a.helps} helps · {a.trades} trades · {a.foodEaten} food
            </div>
          </div>
        ) : (
          <>
            {/* Lifetime metrics + Inventory */}
            <div className="grid grid-cols-4 gap-2 py-2 border-y border-slate-800/70 font-mono text-xs tabular-nums">
              <div>
                <div className="text-[10px] text-slate-500">Kills</div>
                <div className="text-slate-200 font-medium">{a.kills}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500">Helps</div>
                <div className="text-slate-200 font-medium">{a.helps}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500">Trades</div>
                <div className="text-slate-200 font-medium">{a.trades}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500">Carry</div>
                <div className={a.carrying ? 'text-amber-300 font-medium' : 'text-slate-500'}>
                  {CARRY_NAMES[a.carrying]}
                </div>
              </div>
            </div>

            {a.trapTick > 0 && (
              <div className="px-2.5 py-1.5 bg-rose-950/40 border border-rose-800/60 font-mono text-xs text-rose-300">
                Trapped in pit — must jump to escape
              </div>
            )}

            {/* Needs Bars */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="font-medium text-slate-300">Physiological Needs</span>
                <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                  FOV {a.fov} · Ear {a.hearing}
                </span>
              </div>
              {[
                { label: 'Hunger', val: a.hunger, col: 'bg-rose-500' },
                { label: 'Thirst', val: a.thirst, col: 'bg-sky-500' },
                { label: 'Energy', val: a.energy, col: 'bg-emerald-500' },
              ].map((bar) => (
                <div key={bar.label} className="flex items-center gap-2.5 font-mono text-xs tabular-nums">
                  <span className="w-12 text-slate-400">{bar.label}</span>
                  <div className="flex-1 h-1.5 bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full ${bar.col}`}
                      style={{ width: `${Math.round(bar.val * 100)}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-slate-300">{Math.round(bar.val * 100)}%</span>
                </div>
              ))}
              <div className="pt-1 flex items-center justify-between font-mono text-[11px] tabular-nums text-amber-300/90">
                <span>Agg {a.aggression.toFixed(2)}</span>
                <span>Cur {a.curiosity.toFixed(2)}</span>
                <span>Trs {a.trust.toFixed(2)}</span>
              </div>
            </div>

            {/* Q-Learning Brain & Current Action */}
            <div className="pt-3 border-t border-slate-800/70 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-300">Q-Learning Policy</span>
                <span className={`font-mono text-[11px] tabular-nums ${a.wasRandom ? 'text-fuchsia-400' : 'text-emerald-400'}`}>
                  ε {a.epsilon.toFixed(2)} · {a.wasRandom ? 'explore' : 'greedy'}
                </span>
              </div>

              <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                State #{a.currentState} · {st.need} · threat:{st.threat} · F{st.foodKnown ? '+' : '-'} W{st.waterKnown ? '+' : '-'}
              </div>

              <div className="bg-[#090d14] border border-slate-800/80 px-2.5 py-2 space-y-1 font-mono text-xs tabular-nums">
                <div className="flex items-center justify-between">
                  <span className="text-emerald-400 font-medium">&gt; {a.lastAction}</span>
                  <span className="text-slate-400 text-[11px] truncate max-w-[165px]">{a.lastReason}</span>
                </div>
                <div className="pt-1 border-t border-slate-800/70 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                  {topQ.slice(0, 4).map((q) => {
                    const picked = q.idx === a.chosenAction;
                    return (
                      <div
                        key={q.idx}
                        className={`flex items-center justify-between ${picked ? 'text-amber-300 font-medium' : 'text-slate-400'}`}
                      >
                        <span>
                          {picked ? '▸ ' : '  '}
                          {ACT_NAMES[q.idx]}
                        </span>
                        <span>{q.val >= 0 ? `+${q.val.toFixed(1)}` : q.val.toFixed(1)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Social Loyalty & Relationships */}
            <div className="pt-3 border-t border-slate-800/70 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-300">Social & Loyalty</span>
                <button
                  type="button"
                  onClick={() => onOpenInspector('relations')}
                  className="font-mono text-[11px] text-cyan-400 hover:text-cyan-300"
                >
                  All ({a.relations.length})
                </button>
              </div>
              {topRels.length === 0 ? (
                <div className="font-mono text-[11px] text-slate-500">No social bonds recorded yet</div>
              ) : (
                <div className="space-y-1 font-mono text-[11px] tabular-nums">
                  {topRels.map((rel) => (
                    <div key={rel.name} className="flex items-center justify-between">
                      <span className="text-slate-200">
                        {rel.name}
                        {a.kingName === rel.name && (
                          <span className="ml-1.5 text-amber-400">King</span>
                        )}
                      </span>
                      <span className="text-slate-400">
                        <span className={rel.trust >= 25 ? 'text-emerald-400' : rel.trust <= -25 ? 'text-rose-400' : 'text-slate-300'}>
                          trs {rel.trust >= 0 ? `+${rel.trust}` : rel.trust}
                        </span>
                        <span className="mx-1.5 text-slate-600">·</span>
                        <span className={rel.loyalty >= 55 ? 'text-amber-300' : 'text-slate-400'}>
                          loy {rel.loyalty}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Language & Quantized SD Memory */}
            <div className="pt-3 border-t border-slate-800/70 space-y-2 font-mono text-[11px] tabular-nums">
              <div className="flex items-center justify-between">
                <span className="font-sans text-xs font-medium text-slate-300">Language & SD Archive</span>
                <button
                  type="button"
                  onClick={() => onOpenInspector('memory')}
                  className="text-cyan-400 hover:text-cyan-300"
                >
                  memories/{a.name}.dat
                </button>
              </div>
              <div className="flex items-center justify-between text-slate-400">
                <span>Mouth</span>
                <span className="text-slate-200">
                  {Array.from(a.mouth).slice(0, 4).join('')}–{Array.from(a.mouth).slice(4).join('')}
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-400">
                <span>Heard</span>
                <span className="text-amber-300 truncate max-w-[190px]">{heardStr}</span>
              </div>
              <div className="flex items-center justify-between text-slate-400">
                <span>Quantized log</span>
                <span className="text-slate-200">
                  {a.sdRecordCount} rec · {sdBytes} B
                </span>
              </div>
              {a.lastRecallText && (
                <div className="text-[10px] text-cyan-300/90 truncate">
                  Recall: {a.lastRecallText}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
