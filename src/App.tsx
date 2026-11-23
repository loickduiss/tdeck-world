/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  ChevronDown,
  ChevronUp,
  Cpu,
  Globe,
  Orbit,
  Pause,
  Play,
  Smartphone,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  DAY_TICKS,
  SPEED_LABELS,
  SPEED_MS,
  WORLD_H,
  WORLD_W,
  WorldState,
  ZOOM_LEVELS,
} from './sim/types';
import {
  createInitialWorld,
  getKingdoms,
  isNight,
  killAI,
  worldTick,
} from './sim/engine';
import {
  clearWorldSD,
  loadWorldFromSD,
  RECORD_BYTES,
  saveWorldToSD,
} from './sim/memoryStore';
import { R_SECTION_NAMES, TDeckUIState } from './sim/tdeckScreenRenderer';
import {
  CameraMode,
  TDeckSceneStage,
  TDeckStageBridge,
} from './three/TDeckSceneStage';
import { tdeckAudio } from './sim/audio';
import { FirmwareModal } from './components/FirmwareModal';

type GamePhase = 'title' | 'playing';
type PlayCamera = 'handheld' | 'world3d' | 'orbit';

interface HudSnapshot {
  tick: number;
  day: number;
  night: boolean;
  aliveCount: number;
  kingdomCount: number;
  sdBytes: number;
  speedIdx: number;
  selectedName: string;
  selectedColor: string;
  selectedSoul: number;
  selectedRole: string;
  selectedAction: string;
  screenMode: TDeckUIState['mode'];
  rSectionIdx: number;
  panelOpen: boolean;
  latestEventText: string;
  latestEventColor: string;
}

function buildHudSnapshot(state: WorldState, ui: TDeckUIState): HudSnapshot {
  const aliveCount = state.ais.filter((ai) => ai.alive).length;
  const kingdoms = getKingdoms(state);
  let sdRecords = 0;
  for (const ai of state.ais) sdRecords += ai.sdRecordCount;

  const sel = state.ais[ui.selectedAI] ?? state.ais[0];
  const role = !sel
    ? 'NONE'
    : !sel.alive
    ? 'FALLEN'
    : sel.isKing
    ? `KING (${sel.followerCount})`
    : sel.kingName
    ? `LOYAL → ${sel.kingName}`
    : 'FREE';

  const latest = state.events[0];
  return {
    tick: state.tick,
    day: Math.floor(state.tick / DAY_TICKS) + 1,
    night: isNight(state.tick),
    aliveCount,
    kingdomCount: kingdoms.length,
    sdBytes: sdRecords * RECORD_BYTES,
    speedIdx: state.settings.speedIdx,
    selectedName: sel?.name ?? '---',
    selectedColor: sel?.color ?? '#38bdf8',
    selectedSoul: sel?.soul ?? 0,
    selectedRole: role,
    selectedAction: sel?.lastAction ?? 'idle',
    screenMode: ui.mode,
    rSectionIdx: ui.rSectionIdx,
    panelOpen: ui.panelOpen,
    latestEventText: latest?.text ?? 'Continent initialized.',
    latestEventColor: latest?.color ?? '#94a3b8',
  };
}

function TDeckTitleEmblem() {
  return (
    <svg
      width="320"
      height="74"
      viewBox="0 0 320 74"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="select-none"
      aria-label="T-DECK WORLD"
    >
      {/* Bespoke geometric T-Deck silhouette + live continent circuit icon */}
      <rect
        x="2"
        y="8"
        width="48"
        height="58"
        rx="6"
        fill="#0d1420"
        stroke="#38bdf8"
        strokeWidth="1.5"
      />
      {/* Antenna stub */}
      <rect x="40" y="1" width="4" height="7" rx="1.5" fill="#94a3b8" />
      {/* Mini ST7789 screen */}
      <rect x="7" y="14" width="38" height="24" rx="2" fill="#07131f" stroke="#22d3ee" strokeWidth="1" />
      <path d="M11 31 L18 22 L25 27 L33 18 L41 25" stroke="#4ade80" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="33" cy="18" r="2" fill="#facc15" />
      {/* Trackball + QWERTY micro-dots */}
      <circle cx="26" cy="45" r="3.2" fill="#e2e8f0" stroke="#38bdf8" strokeWidth="0.9" />
      <rect x="9" y="53" width="6" height="3" rx="0.8" fill="#475569" />
      <rect x="17" y="53" width="6" height="3" rx="0.8" fill="#475569" />
      <rect x="25" y="53" width="6" height="3" rx="0.8" fill="#475569" />
      <rect x="33" y="53" width="10" height="3" rx="0.8" fill="#38bdf8" />
      <rect x="9" y="58" width="10" height="3" rx="0.8" fill="#334155" />
      <rect x="21" y="58" width="12" height="3" rx="0.8" fill="#334155" />
      <rect x="35" y="58" width="8" height="3" rx="0.8" fill="#334155" />

      {/* Title Wordmark */}
      <text
        x="64"
        y="36"
        fill="#f8fafc"
        fontFamily="Plus Jakarta Sans, system-ui, sans-serif"
        fontWeight="700"
        fontSize="28"
        letterSpacing="0.04em"
      >
        T-DECK WORLD
      </text>
      <text
        x="65"
        y="55"
        fill="#38bdf8"
        fontFamily="IBM Plex Mono, monospace"
        fontWeight="500"
        fontSize="10.5"
        letterSpacing="0.14em"
      >
        LILYGO ESP32-S3 · EMERGENT SIM
      </text>
    </svg>
  );
}

export default function App() {
  const worldRef = useRef<WorldState>(createInitialWorld());
  const uiRef = useRef<TDeckUIState>({
    mode: 'map',
    selectedAI: 0,
    panelOpen: true,
    rSectionIdx: 0,
    rSectionFull: false,
    settingsIdx: 0,
    camX: 14,
    camY: 16,
  });
  const stageBridgeRef = useRef<TDeckStageBridge | null>(null);
  const heldKeysRef = useRef<Set<string>>(new Set());
  const lastEventIdRef = useRef<number>(-1);
  const lastSoundMsRef = useRef<number>(0);

  const [gamePhase, setGamePhase] = useState<GamePhase>('title');
  const [playCamera, setPlayCamera] = useState<PlayCamera>('handheld');
  const [showFirmwareModal, setShowFirmwareModal] = useState<boolean>(false);
  const [dockOpen, setDockOpen] = useState<boolean>(true);
  const [muted, setMuted] = useState<boolean>(false);
  const [hud, setHud] = useState<HudSnapshot>(() =>
    buildHudSnapshot(worldRef.current, uiRef.current)
  );

  const syncHudNow = useCallback(() => {
    setHud(buildHudSnapshot(worldRef.current, uiRef.current));
  }, []);

  // Load persisted SD world from IndexedDB on startup
  useEffect(() => {
    let active = true;
    loadWorldFromSD().then((saved) => {
      if (!active || !saved) return;
      worldRef.current = saved;
      const aliveIdx = saved.ais.findIndex((a) => a.alive);
      if (aliveIdx >= 0) uiRef.current.selectedAI = aliveIdx;
      lastEventIdRef.current = saved.events[0]?.id ?? -1;
      syncHudNow();
    });
    return () => {
      active = false;
    };
  }, [syncHudNow]);

  const adjustSettingRow = useCallback((idx: number, dir: number) => {
    const s = worldRef.current.settings;
    switch (idx) {
      case 0:
        s.zoomIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, s.zoomIdx + dir));
        break;
      case 1:
        s.speedIdx = Math.max(0, Math.min(SPEED_MS.length - 1, s.speedIdx + dir));
        break;
      case 2:
        s.followMode = !s.followMode;
        break;
      case 3:
        s.showFOV = !s.showFOV;
        break;
      case 4:
        s.showFog = !s.showFog;
        break;
      case 5:
        s.showHearing = !s.showHearing;
        break;
      case 6:
        s.showSound = !s.showSound;
        break;
      case 7:
        s.showBonds = !s.showBonds;
        break;
      case 8:
        s.learningEnabled = !s.learningEnabled;
        break;
      case 9:
        s.langEnabled = !s.langEnabled;
        break;
      case 10:
        s.socialEnabled = !s.socialEnabled;
        break;
      case 11:
        s.reproEnabled = !s.reproEnabled;
        break;
      default:
        break;
    }
  }, []);

  const cycleSelectedAI = useCallback((dir: number) => {
    const ais = worldRef.current.ais;
    if (ais.length === 0) return;
    const ui = uiRef.current;
    for (let step = 1; step <= ais.length; step++) {
      const next = (ui.selectedAI + dir * step + ais.length) % ais.length;
      if (ais[next].alive) {
        ui.selectedAI = next;
        return;
      }
    }
    ui.selectedAI = (ui.selectedAI + dir + ais.length) % ais.length;
  }, []);

  const centerOnSelectedAI = useCallback(() => {
    const state = worldRef.current;
    const ui = uiRef.current;
    const a = state.ais[ui.selectedAI];
    if (!a) return;
    const vtx = Math.min(WORLD_W, ZOOM_LEVELS[state.settings.zoomIdx] ?? 40);
    ui.camX = Math.max(0, Math.min(WORLD_W - vtx, a.x - vtx / 2));
    ui.camY = Math.max(0, Math.min(WORLD_H - vtx * 0.75, a.y - (vtx * 0.75) / 2));
  }, []);

  // Unified hardware key handler (invoked by physical keyboard, 3D raycasted QWERTY keycaps, and dock buttons)
  const handleTDeckInput = useCallback(
    (rawKey: string, from3DClick = false) => {
      tdeckAudio.unlock();
      if (rawKey === '__tab__') {
        tdeckAudio.keyClick(1.18);
        syncHudNow();
        return;
      }

      const state = worldRef.current;
      const ui = uiRef.current;
      const key = rawKey;
      const lower = key.toLowerCase();

      if (!from3DClick) {
        const visualKey =
          key === ' '
            ? 'SPACE'
            : key === 'Enter'
            ? 'ENT'
            : key === 'Backspace'
            ? 'DEL'
            : lower;
        stageBridgeRef.current?.triggerKey(visualKey);
      }

      // Universal speed keys 0..5
      if (key >= '0' && key <= '5') {
        state.settings.speedIdx = Number(key);
        tdeckAudio.keyClick(0.9 + Number(key) * 0.08);
        syncHudNow();
        return;
      }

      // SETTINGS MODE
      if (ui.mode === 'settings') {
        if (lower === 'm' || key === 'Escape') {
          ui.mode = 'map';
          tdeckAudio.keyClick(0.85);
        } else if (lower === 'w' || key === 'ArrowUp') {
          ui.settingsIdx = (ui.settingsIdx + 11) % 12;
          stageBridgeRef.current?.nudgeTrackball(0, -1);
          tdeckAudio.trackballTick();
        } else if (lower === 's' || key === 'ArrowDown') {
          ui.settingsIdx = (ui.settingsIdx + 1) % 12;
          stageBridgeRef.current?.nudgeTrackball(0, 1);
          tdeckAudio.trackballTick();
        } else if (lower === 'a' || key === 'ArrowLeft') {
          adjustSettingRow(ui.settingsIdx, -1);
          tdeckAudio.keyClick(0.95);
        } else if (lower === 'd' || key === 'ArrowRight' || key === 'Enter' || key === ' ') {
          adjustSettingRow(ui.settingsIdx, 1);
          tdeckAudio.keyClick(1.12);
        }
        syncHudNow();
        return;
      }

      // EXPANDED R-VIEW (7 hardware diagnostic tabs)
      if (ui.mode === 'expanded') {
        if (lower === 'r') {
          ui.mode = 'map';
          tdeckAudio.keyClick(0.88);
        } else if (lower === 'm') {
          ui.panelOpen = true;
          ui.mode = 'settings';
          tdeckAudio.keyClick(1.05);
        } else if (lower === 'a' || key === 'ArrowLeft') {
          ui.rSectionIdx = (ui.rSectionIdx + 6) % 7;
          stageBridgeRef.current?.nudgeTrackball(-1, 0);
          tdeckAudio.keyClick(1.08);
        } else if (lower === 'd' || key === 'ArrowRight') {
          ui.rSectionIdx = (ui.rSectionIdx + 1) % 7;
          stageBridgeRef.current?.nudgeTrackball(1, 0);
          tdeckAudio.keyClick(1.15);
        } else if (key === 'P') {
          cycleSelectedAI(-1);
          tdeckAudio.keyClick(0.92);
        } else if (lower === 'p') {
          cycleSelectedAI(1);
          tdeckAudio.keyClick(1.04);
        }
        syncHudNow();
        return;
      }

      // MAP MODE
      const panStep = 3;
      if (lower === 'w' || key === 'ArrowUp') {
        state.settings.followMode = false;
        ui.camY = Math.max(0, ui.camY - panStep);
        stageBridgeRef.current?.nudgeTrackball(0, -1);
        tdeckAudio.trackballTick();
      } else if (lower === 's' || key === 'ArrowDown') {
        state.settings.followMode = false;
        ui.camY = Math.min(WORLD_H - 8, ui.camY + panStep);
        stageBridgeRef.current?.nudgeTrackball(0, 1);
        tdeckAudio.trackballTick();
      } else if (lower === 'a' || key === 'ArrowLeft') {
        state.settings.followMode = false;
        ui.camX = Math.max(0, ui.camX - panStep);
        stageBridgeRef.current?.nudgeTrackball(-1, 0);
        tdeckAudio.trackballTick();
      } else if (lower === 'd' || key === 'ArrowRight') {
        state.settings.followMode = false;
        ui.camX = Math.min(WORLD_W - 8, ui.camX + panStep);
        stageBridgeRef.current?.nudgeTrackball(1, 0);
        tdeckAudio.trackballTick();
      } else if (key === ' ' || key === 'SPACE') {
        state.settings.followMode = !state.settings.followMode;
        centerOnSelectedAI();
        tdeckAudio.keyClick(1.0);
      } else if (lower === 'e') {
        ui.panelOpen = !ui.panelOpen;
        tdeckAudio.keyClick(0.96);
      } else if (key === 'P') {
        cycleSelectedAI(-1);
        if (state.settings.followMode) centerOnSelectedAI();
        tdeckAudio.keyClick(0.94);
      } else if (lower === 'p') {
        cycleSelectedAI(1);
        if (state.settings.followMode) centerOnSelectedAI();
        tdeckAudio.keyClick(1.08);
      } else if (lower === 'r') {
        ui.mode = 'expanded';
        tdeckAudio.keyClick(1.16);
      } else if (lower === 'm') {
        ui.panelOpen = true;
        ui.mode = 'settings';
        tdeckAudio.keyClick(1.1);
      } else if (key === '+' || key === '=' || key === 'z') {
        state.settings.zoomIdx = Math.min(ZOOM_LEVELS.length - 1, state.settings.zoomIdx + 1);
        tdeckAudio.keyClick(1.2);
      } else if (key === '-' || key === '_') {
        state.settings.zoomIdx = Math.max(0, state.settings.zoomIdx - 1);
        tdeckAudio.keyClick(0.84);
      } else if (lower === 'f') {
        state.settings.showFog = !state.settings.showFog;
        tdeckAudio.keyClick(1.02);
      } else if (lower === 'v') {
        state.settings.showFOV = !state.settings.showFOV;
        tdeckAudio.keyClick(1.02);
      } else if (lower === 'b') {
        state.settings.showBonds = !state.settings.showBonds;
        tdeckAudio.keyClick(1.02);
      } else if (lower === 'k') {
        const target = state.ais[ui.selectedAI];
        if (target && target.alive) {
          killAI(state, target, 'user cull');
          tdeckAudio.playEvent('combat');
        }
      } else if (lower === 't' && state.settings.speedIdx === 0) {
        worldTick(state);
        tdeckAudio.keyClick(1.05);
      }
      syncHudNow();
    },
    [adjustSettingRow, centerOnSelectedAI, cycleSelectedAI, syncHudNow]
  );

  const handleTrackballClick = useCallback(() => {
    tdeckAudio.unlock();
    tdeckAudio.trackballTick();
    const ui = uiRef.current;
    if (ui.mode === 'settings') {
      adjustSettingRow(ui.settingsIdx, 1);
    } else if (ui.mode === 'expanded') {
      ui.rSectionIdx = (ui.rSectionIdx + 1) % 7;
    } else {
      worldRef.current.settings.followMode = !worldRef.current.settings.followMode;
      centerOnSelectedAI();
    }
    syncHudNow();
  }, [adjustSettingRow, centerOnSelectedAI, syncHudNow]);

  const handleSelectAI = useCallback(
    (aiId: number) => {
      tdeckAudio.unlock();
      tdeckAudio.keyClick(1.12);
      uiRef.current.selectedAI = aiId;
      if (worldRef.current.settings.followMode) centerOnSelectedAI();
      syncHudNow();
    },
    [centerOnSelectedAI, syncHudNow]
  );

  const handleBootGame = useCallback(() => {
    tdeckAudio.unlock();
    tdeckAudio.playEvent('boot');
    setGamePhase('playing');
    syncHudNow();
  }, [syncHudNow]);

  const handleResetWorld = useCallback(() => {
    tdeckAudio.unlock();
    tdeckAudio.playEvent('boot');
    clearWorldSD();
    worldRef.current = createInitialWorld();
    uiRef.current = {
      mode: 'map',
      selectedAI: 0,
      panelOpen: true,
      rSectionIdx: 0,
      rSectionFull: false,
      settingsIdx: 0,
      camX: 14,
      camY: 16,
    };
    lastEventIdRef.current = worldRef.current.events[0]?.id ?? -1;
    syncHudNow();
  }, [syncHudNow]);

  const handleToggleMute = useCallback(() => {
    const next = !muted;
    tdeckAudio.muted = next;
    setMuted(next);
    if (!next) {
      tdeckAudio.unlock();
      tdeckAudio.keyClick(1.1);
    }
  }, [muted]);

  // Global keyboard handler + window blur key cleanup
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      heldKeysRef.current.add(e.key);

      if (showFirmwareModal) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowFirmwareModal(false);
        }
        return;
      }

      if (gamePhase === 'title') {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleBootGame();
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (uiRef.current.mode !== 'map') {
          uiRef.current.mode = 'map';
          tdeckAudio.keyClick(0.85);
          syncHudNow();
        } else {
          setShowFirmwareModal(true);
        }
        return;
      }

      if (e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setDockOpen((prev) => !prev);
        return;
      }

      if (
        e.key === ' ' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight'
      ) {
        e.preventDefault();
      }

      handleTDeckInput(e.key, false);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      heldKeysRef.current.delete(e.key);
    };

    const onBlur = () => {
      heldKeysRef.current.clear();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [gamePhase, showFirmwareModal, handleBootGame, handleTDeckInput, syncHudNow]);

  // Main Simulation Tick Loop (clamped delta-time, IndexedDB SD auto-save + LED pulse)
  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();
    let tickAccumMs = 0;
    let hudAccumMs = 0;
    let lastSavedTick = worldRef.current.tick;

    const loop = (now: number) => {
      const rawDtMs = now - lastTime;
      lastTime = now;
      const dtMs = Math.min(rawDtMs, 50);

      const state = worldRef.current;
      const tickInterval = SPEED_MS[state.settings.speedIdx] ?? 250;

      if (!showFirmwareModal && tickInterval > 0) {
        tickAccumMs += dtMs;
        let stepped = 0;
        while (tickAccumMs >= tickInterval && stepped < 4) {
          tickAccumMs -= tickInterval;
          worldTick(state);
          stepped++;
        }

        if (stepped > 0) {
          // Trigger subtle audio cue for major emergent chronicle milestones
          const latest = state.events[0];
          if (latest && latest.id !== lastEventIdRef.current) {
            lastEventIdRef.current = latest.id;
            if (gamePhase === 'playing' && now - lastSoundMsRef.current > 420) {
              if (latest.category === 'kingdom') {
                tdeckAudio.playEvent('kingdom');
                lastSoundMsRef.current = now;
              } else if (latest.category === 'trade') {
                tdeckAudio.playEvent('trade');
                lastSoundMsRef.current = now;
              } else if (latest.category === 'unknown') {
                tdeckAudio.playEvent('unknown');
                lastSoundMsRef.current = now;
              } else if (latest.category === 'memorial') {
                tdeckAudio.playEvent('memorial');
                lastSoundMsRef.current = now;
              } else if (latest.category === 'combat') {
                tdeckAudio.playEvent('combat');
                lastSoundMsRef.current = now;
              }
            }
          }

          // Persist to browser SD (IndexedDB) every 30 ticks and pulse 3D SD card LED
          if (state.tick - lastSavedTick >= 30) {
            lastSavedTick = state.tick;
            stageBridgeRef.current?.pulseSD();
            saveWorldToSD(state);
          }
        }
      }

      hudAccumMs += dtMs;
      if (hudAccumMs >= 180) {
        hudAccumMs = 0;
        setHud(buildHudSnapshot(state, uiRef.current));
      }

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [gamePhase, showFirmwareModal]);

  const activeCameraMode: CameraMode = gamePhase === 'title' ? 'title' : playCamera;
  const sdKb = (hud.sdBytes / 1024).toFixed(1);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0a0e16] text-slate-100 select-none">
      {/* Full-Bleed Permanent Three.js Hardware & Diorama Stage */}
      <TDeckSceneStage
        worldRef={worldRef}
        uiRef={uiRef}
        cameraMode={activeCameraMode}
        stageBridgeRef={stageBridgeRef}
        onHardwareKey={(k) => handleTDeckInput(k, true)}
        onTrackballClick={handleTrackballClick}
        onSelectAI={handleSelectAI}
      />

      {/* ==================== TITLE SCREEN OVERLAY ==================== */}
      {gamePhase === 'title' && (
        <div className="fixed inset-0 z-20 pointer-events-none flex items-center">
          <div className="pointer-events-auto ml-8 sm:ml-14 max-w-md">
            <TDeckTitleEmblem />

            <p className="mt-4 text-sm leading-relaxed text-slate-300 max-w-sm">
              Eight autonomous Q-learning AIs on a 64×64 living continent with emergent
              language, sticky royal dynasties, and 16-byte quantized MicroSD memories —
              built to run natively on your LilyGO T-Deck Plus.
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleBootGame}
                className="px-6 py-3 bg-cyan-400 text-slate-950 font-semibold text-sm tracking-wide hover:bg-cyan-300 transition-colors cursor-pointer"
              >
                Boot T-Deck
              </button>
              <button
                type="button"
                onClick={() => {
                  tdeckAudio.unlock();
                  setShowFirmwareModal(true);
                }}
                className="flex items-center gap-2 px-4 py-3 bg-[#0e1522] text-slate-200 border border-slate-700 hover:border-cyan-400/70 text-sm font-mono transition-colors cursor-pointer"
              >
                <Cpu className="w-4 h-4 text-cyan-400" />
                ESP32 Firmware (.zip)
              </button>
            </div>

            <div className="mt-6 font-mono text-[11px] text-slate-400 tracking-wide">
              WASD Pan · Space Center · P Cycle AI · R Detail · M Settings · Esc Firmware
            </div>
          </div>
        </div>
      )}

      {/* ==================== PLAYING HUD (PERIMETER ONLY) ==================== */}
      {gamePhase === 'playing' && (
        <>
          {/* Top-Left Minimal Hardware Telemetry Readout (solid opaque-tinted surface, no backdrop-filter) */}
          <div className="fixed top-4 left-4 z-20 pointer-events-none max-w-md">
            <div className="bg-[#090d14]/92 border border-slate-800 px-3.5 py-2.5">
              <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-slate-300">
                <span className="text-cyan-400 font-semibold">
                  T{String(hud.tick).padStart(5, '0')}
                </span>
                <span>D{hud.day}</span>
                <span className={hud.night ? 'text-sky-400' : 'text-amber-300'}>
                  {hud.night ? 'NIGHT' : 'DAY'}
                </span>
                <span>POP {hud.aliveCount}</span>
                <span>KINGS {hud.kingdomCount}</span>
                <span className="text-slate-400">SD {sdKb}KB</span>
              </div>

              <div className="mt-1.5 flex items-center gap-2 font-mono text-xs tabular-nums">
                <span
                  className="inline-block w-2.5 h-2.5 shrink-0 border border-slate-950"
                  style={{ backgroundColor: hud.selectedColor }}
                />
                <span className="font-semibold text-white">{hud.selectedName}</span>
                <span className="text-amber-300">SOUL {hud.selectedSoul}</span>
                <span className="text-slate-400">{hud.selectedRole}</span>
                <span className="text-emerald-400">› {hud.selectedAction}</span>
              </div>

              <div
                className="mt-1 font-mono text-[11px] truncate max-w-[360px]"
                style={{ color: hud.latestEventColor }}
              >
                {hud.latestEventText}
              </div>
            </div>
          </div>

          {/* Top-Right Compact Action Controls */}
          <div className="fixed top-4 right-4 z-20 flex items-center gap-2">
            <button
              type="button"
              onClick={handleToggleMute}
              className="p-2.5 bg-[#090d14]/92 border border-slate-800 text-slate-300 hover:text-white hover:border-slate-600 transition-colors cursor-pointer"
              title={muted ? 'Unmute audio' : 'Mute audio'}
              aria-label={muted ? 'Unmute audio' : 'Mute audio'}
            >
              {muted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4 text-cyan-400" />}
            </button>

            <button
              type="button"
              onClick={() => {
                tdeckAudio.unlock();
                setShowFirmwareModal(true);
              }}
              className="flex items-center gap-2 px-3.5 py-2 bg-[#090d14]/92 border border-cyan-500/50 text-cyan-300 hover:bg-[#111a28] text-xs font-mono transition-colors cursor-pointer"
            >
              <Cpu className="w-3.5 h-3.5" />
              ESP32 Firmware
              <span className="text-slate-500">[Esc]</span>
            </button>
          </div>

          {/* Collapsible Single-Row Floating Bottom Control Dock */}
          <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1.5 max-w-[96vw]">
            {dockOpen && hud.screenMode === 'expanded' && (
              <div className="bg-[#090d14]/94 border border-slate-800 px-1.5 py-1 flex items-center gap-1">
                {R_SECTION_NAMES.map((sec, idx) => {
                  const active = hud.rSectionIdx === idx;
                  return (
                    <button
                      key={sec}
                      type="button"
                      onClick={() => {
                        tdeckAudio.unlock();
                        tdeckAudio.keyClick(1.14);
                        uiRef.current.rSectionIdx = idx;
                        syncHudNow();
                      }}
                      className={`px-2 py-0.5 text-[10px] font-mono transition-colors cursor-pointer ${
                        active
                          ? 'bg-cyan-400 text-slate-950 font-semibold'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {sec}
                    </button>
                  );
                })}
              </div>
            )}

            {!dockOpen ? (
              <button
                type="button"
                onClick={() => setDockOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#090d14]/92 border border-slate-800 text-xs font-mono text-slate-300 hover:text-white hover:border-slate-600 transition-colors cursor-pointer"
              >
                <ChevronUp className="w-3.5 h-3.5 text-cyan-400" />
                Controls [H]
              </button>
            ) : (
              <div className="bg-[#090d14]/94 border border-slate-800 px-2.5 py-1.5 flex items-center gap-2 overflow-x-auto whitespace-nowrap">
                {/* Camera Presets */}
                <div className="flex items-center gap-1 pr-2 border-r border-slate-800">
                  {(
                    [
                      { id: 'handheld', label: 'T-Deck', icon: Smartphone },
                      { id: 'world3d', label: '3D World', icon: Globe },
                      { id: 'orbit', label: 'Orbit', icon: Orbit },
                    ] as const
                  ).map(({ id, label, icon: Icon }) => {
                    const active = playCamera === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => {
                          tdeckAudio.unlock();
                          tdeckAudio.keyClick(1.06);
                          setPlayCamera(id);
                        }}
                        className={`flex items-center gap-1 px-2 py-1 text-[11px] font-mono transition-colors cursor-pointer ${
                          active
                            ? 'bg-cyan-400 text-slate-950 font-semibold'
                            : 'bg-[#101724] text-slate-300 hover:text-white border border-slate-800'
                        }`}
                      >
                        <Icon className="w-3 h-3" />
                        {label}
                      </button>
                    );
                  })}
                </div>

                {/* Simulation Speed */}
                <div className="flex items-center gap-1 pr-2 border-r border-slate-800">
                  <button
                    type="button"
                    onClick={() =>
                      handleTDeckInput(hud.speedIdx === 0 ? '2' : '0', false)
                    }
                    className={`p-1 text-[11px] font-mono border transition-colors cursor-pointer ${
                      hud.speedIdx === 0
                        ? 'bg-amber-400 text-slate-950 border-amber-400'
                        : 'bg-[#101724] text-slate-300 border-slate-800 hover:text-white'
                    }`}
                    title={hud.speedIdx === 0 ? 'Resume' : 'Pause'}
                  >
                    {hud.speedIdx === 0 ? (
                      <Play className="w-3 h-3" />
                    ) : (
                      <Pause className="w-3 h-3" />
                    )}
                  </button>
                  {[2, 3, 4, 5].map((idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleTDeckInput(String(idx), false)}
                      className={`px-1.5 py-1 text-[11px] font-mono tabular-nums transition-colors cursor-pointer ${
                        hud.speedIdx === idx
                          ? 'bg-slate-200 text-slate-950 font-semibold'
                          : 'bg-[#101724] text-slate-400 hover:text-white border border-slate-800'
                      }`}
                    >
                      {SPEED_LABELS[idx]}
                    </button>
                  ))}
                </div>

                {/* Direct T-Deck Hardware Key Triggers */}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleTDeckInput('p', false)}
                    className="px-2 py-1 bg-[#101724] border border-slate-800 text-[11px] font-mono text-slate-200 hover:border-cyan-500/60 transition-colors cursor-pointer"
                  >
                    P: AI
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTDeckInput('r', false)}
                    className={`px-2 py-1 border text-[11px] font-mono transition-colors cursor-pointer ${
                      hud.screenMode === 'expanded'
                        ? 'bg-cyan-950 text-cyan-300 border-cyan-500/70'
                        : 'bg-[#101724] text-slate-200 border-slate-800 hover:border-cyan-500/60'
                    }`}
                  >
                    R: {hud.screenMode === 'expanded' ? 'Map' : 'Detail'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTDeckInput('m', false)}
                    className={`px-2 py-1 border text-[11px] font-mono transition-colors cursor-pointer ${
                      hud.screenMode === 'settings'
                        ? 'bg-amber-950 text-amber-300 border-amber-500/70'
                        : 'bg-[#101724] text-slate-200 border-slate-800 hover:border-cyan-500/60'
                    }`}
                  >
                    M: Set
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTDeckInput('e', false)}
                    className="px-2 py-1 bg-[#101724] border border-slate-800 text-[11px] font-mono text-slate-300 hover:text-white transition-colors cursor-pointer"
                    title="Toggle side panel"
                  >
                    E
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTDeckInput(' ', false)}
                    className="px-2 py-1 bg-[#101724] border border-slate-800 text-[11px] font-mono text-slate-300 hover:text-white transition-colors cursor-pointer"
                    title="Center & follow selected AI"
                  >
                    <Box className="w-3 h-3 inline mr-1 -mt-0.5 text-cyan-400" />
                    Center
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTDeckInput('+', false)}
                    className="px-1.5 py-1 bg-[#101724] border border-slate-800 text-[11px] font-mono text-slate-300 hover:text-white transition-colors cursor-pointer"
                    title="Zoom in"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTDeckInput('-', false)}
                    className="px-1.5 py-1 bg-[#101724] border border-slate-800 text-[11px] font-mono text-slate-300 hover:text-white transition-colors cursor-pointer"
                    title="Zoom out"
                  >
                    -
                  </button>
                </div>

                {/* Collapse Dock for Cinema Mode */}
                <button
                  type="button"
                  onClick={() => setDockOpen(false)}
                  className="p-1 text-slate-500 hover:text-slate-200 transition-colors cursor-pointer"
                  title="Collapse dock [H]"
                  aria-label="Collapse dock"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* ==================== PAUSE / ESP32 FIRMWARE EXPORT MODAL ==================== */}
      {showFirmwareModal && (
        <FirmwareModal
          worldRef={worldRef}
          selectedAI={uiRef.current.selectedAI}
          onClose={() => setShowFirmwareModal(false)}
          onResetWorld={handleResetWorld}
        />
      )}
    </div>
  );
}
