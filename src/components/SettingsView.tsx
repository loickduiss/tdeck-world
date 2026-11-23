import React from 'react';
import {
  MAX_AI,
  SPEED_LABELS,
  WorldSettings,
  ZOOM_LABELS,
} from '../sim/types';

interface SettingsViewProps {
  settings: WorldSettings;
  sdBytesTotal: number;
  lastSavedText: string;
  onUpdateSettings: (patch: Partial<WorldSettings>) => void;
  onSaveNow: () => void;
  onResetAIs: () => void;
  onResetWorld: () => void;
  onKillSelected: () => void;
  onResetDefaults: () => void;
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-slate-800/70 last:border-0 gap-4">
      <div>
        <div className="text-sm text-slate-200">{label}</div>
        {hint && <div className="text-xs text-slate-500">{hint}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`px-3 py-1 font-mono text-xs border transition-colors shrink-0 ${
          checked
            ? 'bg-cyan-500/15 border-cyan-500/60 text-cyan-300'
            : 'bg-[#090d14] border-slate-800 text-slate-400 hover:text-slate-200'
        }`}
      >
        {checked ? 'ON' : 'OFF'}
      </button>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="py-2.5 border-b border-slate-800/70 last:border-0 space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-200">{label}</span>
        <span className="font-mono text-xs tabular-nums text-cyan-300">
          {value} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-cyan-400 cursor-pointer"
      />
    </div>
  );
}

export function SettingsView({
  settings,
  sdBytesTotal,
  lastSavedText,
  onUpdateSettings,
  onSaveNow,
  onResetAIs,
  onResetWorld,
  onKillSelected,
  onResetDefaults,
}: SettingsViewProps) {
  return (
    <div className="flex-1 overflow-y-auto bg-[#080b10] p-6">
      <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Display & Overlays */}
        <section className="bg-[#0d121a] border border-slate-800 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-100">Display & Map Overlays</h2>

          <div className="py-2 border-b border-slate-800/70 space-y-2">
            <div className="text-xs text-slate-400">Zoom Level (+ / - / Z)</div>
            <div className="grid grid-cols-4 gap-1">
              {ZOOM_LABELS.map((lbl, idx) => (
                <button
                  key={lbl}
                  type="button"
                  onClick={() => onUpdateSettings({ zoomIdx: idx })}
                  className={`py-1.5 font-mono text-xs border transition-colors ${
                    settings.zoomIdx === idx
                      ? 'bg-slate-800 border-cyan-500/60 text-cyan-300'
                      : 'bg-[#090d14] border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <div className="py-2 border-b border-slate-800/70 space-y-2">
            <div className="text-xs text-slate-400">Simulation Speed (0–5)</div>
            <div className="grid grid-cols-6 gap-1">
              {SPEED_LABELS.map((lbl, idx) => (
                <button
                  key={lbl}
                  type="button"
                  onClick={() => onUpdateSettings({ speedIdx: idx })}
                  className={`py-1.5 font-mono text-xs border transition-colors ${
                    settings.speedIdx === idx
                      ? 'bg-slate-800 border-cyan-500/60 text-cyan-300'
                      : 'bg-[#090d14] border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <ToggleRow
            label="Follow Selected AI"
            checked={settings.followMode}
            onChange={(v) => onUpdateSettings({ followMode: v })}
          />
          <ToggleRow
            label="Vision Cone (FOV)"
            checked={settings.showFOV}
            onChange={(v) => onUpdateSettings({ showFOV: v })}
          />
          <ToggleRow
            label="Fog of War (Selected AI Memory)"
            checked={settings.showFog}
            onChange={(v) => onUpdateSettings({ showFog: v })}
          />
          <ToggleRow
            label="Hearing Radius"
            checked={settings.showHearing}
            onChange={(v) => onUpdateSettings({ showHearing: v })}
          />
          <ToggleRow
            label="Acoustic Sound Rings"
            checked={settings.showSound}
            onChange={(v) => onUpdateSettings({ showSound: v })}
          />
          <ToggleRow
            label="Trust & Royal Loyalty Bonds"
            checked={settings.showBonds}
            onChange={(v) => onUpdateSettings({ showBonds: v })}
          />
          <ToggleRow
            label="Superstition Taboo Zones"
            hint="Visualize tiles avoided by AIs after unexplained events"
            checked={settings.showSuperstitions}
            onChange={(v) => onUpdateSettings({ showSuperstitions: v })}
          />
        </section>

        {/* Simulation Systems & World Physics */}
        <div className="space-y-6">
          <section className="bg-[#0d121a] border border-slate-800 p-5">
            <h2 className="text-sm font-semibold text-slate-100 mb-2">Emergent Subsystems</h2>
            <ToggleRow
              label="Q-Learning Policy Updates"
              hint="Self-tuning TD(0) updates in RAM"
              checked={settings.learningEnabled}
              onChange={(v) => onUpdateSettings({ learningEnabled: v })}
            />
            <ToggleRow
              label="Emergent Language (Mouth / Ear)"
              hint="8 phonemes × 8 concepts co-occurrence & dialect drift"
              checked={settings.langEnabled}
              onChange={(v) => onUpdateSettings({ langEnabled: v })}
            />
            <ToggleRow
              label="Reproduction & Inheritance"
              hint="Mutual trust ≥ 30 breeds Q-table & phoneme offspring"
              checked={settings.reproEnabled}
              onChange={(v) => onUpdateSettings({ reproEnabled: v })}
            />
            <ToggleRow
              label="Trade, Loyalty & Kingship"
              hint="Item/intel exchange, sticky loyalty, social proof courts"
              checked={settings.socialEnabled}
              onChange={(v) => onUpdateSettings({ socialEnabled: v })}
            />
          </section>

          <section className="bg-[#0d121a] border border-slate-800 p-5">
            <h2 className="text-sm font-semibold text-slate-100 mb-2">World Physics</h2>
            <SliderRow
              label="Berry Regrowth Interval"
              value={settings.paramFoodRegrowRate}
              min={10}
              max={300}
              step={10}
              unit="ticks"
              onChange={(v) => onUpdateSettings({ paramFoodRegrowRate: v })}
            />
            <SliderRow
              label="Unexplained Hurt Chance"
              value={settings.paramRandomHurtRate}
              min={0}
              max={50}
              step={1}
              unit="/ 20k"
              onChange={(v) => onUpdateSettings({ paramRandomHurtRate: v })}
            />
            <SliderRow
              label="Memorial Decay Interval"
              value={settings.paramMemorialDecay}
              min={500}
              max={10000}
              step={500}
              unit="ticks"
              onChange={(v) => onUpdateSettings({ paramMemorialDecay: v })}
            />
            <SliderRow
              label="Active Population Cap"
              value={settings.paramPopulationCap}
              min={2}
              max={MAX_AI}
              step={1}
              unit="AIs"
              onChange={(v) => onUpdateSettings({ paramPopulationCap: v })}
            />
          </section>

          <section className="bg-[#0d121a] border border-slate-800 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Virtual SD Persistence & Actions</h2>
              <span className="font-mono text-xs tabular-nums text-slate-400">
                {(sdBytesTotal / 1024).toFixed(2)} KB · {lastSavedText}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={onSaveNow}
                className="px-3 py-2 text-xs font-medium bg-cyan-500/15 text-cyan-300 border border-cyan-500/50 hover:bg-cyan-500/25 transition-colors"
              >
                Save Snapshot to SD
              </button>
              <button
                type="button"
                onClick={onResetDefaults}
                className="px-3 py-2 text-xs font-medium bg-[#111824] text-slate-300 border border-slate-800 hover:border-slate-700 transition-colors"
              >
                Restore Defaults
              </button>
              <button
                type="button"
                onClick={onResetAIs}
                className="px-3 py-2 text-xs font-medium bg-[#111824] text-amber-300 border border-slate-800 hover:border-amber-500/50 transition-colors"
              >
                Reseed AIs
              </button>
              <button
                type="button"
                onClick={onKillSelected}
                className="px-3 py-2 text-xs font-medium bg-[#111824] text-rose-300 border border-slate-800 hover:border-rose-500/50 transition-colors"
              >
                Kill Selected AI
              </button>
            </div>
            <button
              type="button"
              onClick={onResetWorld}
              className="w-full px-3 py-2 text-xs font-medium bg-rose-950/40 text-rose-300 border border-rose-800/60 hover:bg-rose-950/70 transition-colors"
            >
              Regenerate Continent & Wipe SD Archive
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
