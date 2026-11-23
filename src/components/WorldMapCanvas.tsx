import React, { useEffect, useRef, useState } from 'react';
import {
  AI,
  CONCEPT_COLORS,
  SPEED_MS,
  Tile,
  TILE_COLORS,
  TILE_NAMES,
  WORLD_H,
  WORLD_W,
  WorldState,
  ZOOM_LEVELS,
} from '../sim/types';
import { aiHasSeen, getRelTrust, idxOf, isMonster, nightFactor } from '../sim/engine';

interface WorldMapCanvasProps {
  worldRef: React.MutableRefObject<WorldState>;
  selectedAI: number;
  camRef: React.MutableRefObject<{ x: number; y: number }>;
  onSelectAI: (id: number) => void;
  onAdjustZoom: (delta: number) => void;
}

function darkenHex(hex: string, factor: number): string {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.round(((num >> 16) & 255) * (1 - factor)));
  const g = Math.max(0, Math.round(((num >> 8) & 255) * (1 - factor)));
  const b = Math.max(0, Math.round((num & 255) * (1 - factor)));
  return `rgb(${r},${g},${b})`;
}

function drawAIShapeCanvas(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  shape: number,
  color: string,
  selected: boolean
): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = selected ? '#facc15' : '#090c11';
  ctx.lineWidth = selected ? 2.2 : 1.2;

  ctx.beginPath();
  switch (shape) {
    case 0: // circle
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    case 1: // square
      ctx.rect(cx - r, cy - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();
      break;
    case 2: // triangle up
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx - r, cy + r);
      ctx.lineTo(cx + r, cy + r);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    case 3: // diamond
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    case 4: // triangle down
      ctx.moveTo(cx - r, cy - r);
      ctx.lineTo(cx + r, cy - r);
      ctx.lineTo(cx, cy + r);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    case 5: {
      // cross
      const a = r * 0.45;
      ctx.moveTo(cx - a, cy - r);
      ctx.lineTo(cx + a, cy - r);
      ctx.lineTo(cx + a, cy - a);
      ctx.lineTo(cx + r, cy - a);
      ctx.lineTo(cx + r, cy + a);
      ctx.lineTo(cx + a, cy + a);
      ctx.lineTo(cx + a, cy + r);
      ctx.lineTo(cx - a, cy + r);
      ctx.lineTo(cx - a, cy + a);
      ctx.lineTo(cx - r, cy + a);
      ctx.lineTo(cx - r, cy - a);
      ctx.lineTo(cx - a, cy - a);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 6: // ring
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = '#090c11';
      ctx.arc(cx, cy, Math.max(1.5, r * 0.42), 0, Math.PI * 2);
      ctx.fill();
      break;
    case 7: // pentagon
      for (let i = 0; i < 5; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI * 2) / 5;
        const px = cx + Math.cos(ang) * r;
        const py = cy + Math.sin(ang) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
  }
}

export function WorldMapCanvas({
  worldRef,
  selectedAI,
  camRef,
  onSelectAI,
  onAdjustZoom,
}: WorldMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    camStartX: number;
    camStartY: number;
  }>({ active: false, moved: false, startX: 0, startY: 0, camStartX: 0, camStartY: 0 });
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; tile: Tile; aiName?: string } | null>(null);

  useEffect(() => {
    let rafId = 0;

    const draw = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) {
        rafId = requestAnimationFrame(draw);
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw > 0 && ch > 0 && (canvas.width !== Math.floor(cw * dpr) || canvas.height !== Math.floor(ch * dpr))) {
        canvas.width = Math.floor(cw * dpr);
        canvas.height = Math.floor(ch * dpr);
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        rafId = requestAnimationFrame(draw);
        return;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#070a0f';
      ctx.fillRect(0, 0, cw, ch);

      const state = worldRef.current;
      const vtx = Math.min(WORLD_W, ZOOM_LEVELS[state.settings.zoomIdx] ?? 40);
      const tileSize = Math.max(cw / vtx, ch / WORLD_H);
      const vty = Math.min(WORLD_H, Math.ceil(ch / tileSize));
      const ppx = cw / vtx;
      const ppy = ch / Math.min(WORLD_H, Math.max(1, ch / ppx));

      // Follow mode smoothly locks camera on selected AI
      const selAI: AI | undefined = state.ais[selectedAI];
      if (state.settings.followMode && selAI && selAI.alive) {
        camRef.current.x = selAI.x - vtx / 2;
        camRef.current.y = selAI.y - vty / 2;
      }

      const maxCamX = Math.max(0, WORLD_W - vtx);
      const maxCamY = Math.max(0, WORLD_H - ch / ppx);
      camRef.current.x = Math.max(0, Math.min(maxCamX, camRef.current.x));
      camRef.current.y = Math.max(0, Math.min(maxCamY, camRef.current.y));

      const camX = camRef.current.x;
      const camY = camRef.current.y;
      const nf = nightFactor(state.tick);
      const darkAmt = nf * 0.48;
      const now = performance.now();

      const startX = Math.max(0, Math.floor(camX));
      const endX = Math.min(WORLD_W - 1, Math.ceil(camX + vtx));
      const startY = Math.max(0, Math.floor(camY));
      const endY = Math.min(WORLD_H - 1, Math.ceil(camY + ch / ppy) + 1);

      // 1. Render Terrain Tiles
      for (let wy = startY; wy <= endY; wy++) {
        const sy = Math.floor((wy - camY) * ppy);
        const sh = Math.ceil((wy + 1 - camY) * ppy) - sy;
        for (let wx = startX; wx <= endX; wx++) {
          const sx = Math.floor((wx - camX) * ppx);
          const sw = Math.ceil((wx + 1 - camX) * ppx) - sx;
          const t = state.tiles[idxOf(wx, wy)] as Tile;

          // Subtle natural tile variation for grass/forest/water
          const hash = ((wx * 73856093) ^ (wy * 19349663)) & 15;
          let shade = darkAmt;
          if (t === Tile.GRASS) shade += (hash % 3) * 0.025;
          else if (t === Tile.WATER) shade += ((hash + Math.floor(state.tick / 14)) % 4 === 0 ? -0.05 : 0.02);

          ctx.fillStyle = darkenHex(TILE_COLORS[t], Math.max(0, Math.min(0.85, shade)));
          ctx.fillRect(sx, sy, sw, sh);

          // Crisp micro-details when zoomed in enough
          if (ppx >= 10) {
            if (t === Tile.FOREST) {
              ctx.fillStyle = darkenHex('#112a1a', darkAmt);
              ctx.beginPath();
              ctx.arc(sx + sw * 0.5, sy + sh * 0.5, sw * 0.34, 0, Math.PI * 2);
              ctx.fill();
            } else if (t === Tile.FOOD) {
              // Grass base + berry cluster
              ctx.fillStyle = darkenHex(TILE_COLORS[Tile.GRASS], darkAmt);
              ctx.fillRect(sx, sy, sw, sh);
              ctx.fillStyle = darkenHex('#ef4444', darkAmt * 0.5);
              const br = Math.max(2, sw * 0.16);
              ctx.beginPath();
              ctx.arc(sx + sw * 0.38, sy + sh * 0.42, br, 0, Math.PI * 2);
              ctx.arc(sx + sw * 0.62, sy + sh * 0.52, br, 0, Math.PI * 2);
              ctx.arc(sx + sw * 0.48, sy + sh * 0.66, br, 0, Math.PI * 2);
              ctx.fill();
            } else if (t === Tile.BUILT) {
              ctx.strokeStyle = darkenHex('#cbd5e1', darkAmt);
              ctx.lineWidth = 1;
              ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
            } else if (t === Tile.MEMORIAL) {
              const pulse = 0.72 + Math.sin(now * 0.005 + wx + wy) * 0.28;
              ctx.fillStyle = `rgba(250, 204, 21, ${pulse * (1 - darkAmt * 0.4)})`;
              ctx.fillRect(sx + sw * 0.22, sy + sh * 0.18, sw * 0.56, sh * 0.64);
              ctx.strokeStyle = '#fef08a';
              ctx.lineWidth = 1;
              ctx.strokeRect(sx + sw * 0.22, sy + sh * 0.18, sw * 0.56, sh * 0.64);
            } else if (t === Tile.PIT) {
              ctx.fillStyle = '#07080a';
              ctx.beginPath();
              ctx.ellipse(sx + sw * 0.5, sy + sh * 0.54, sw * 0.36, sh * 0.28, 0, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }

      // Subtle grid hairlines at high zoom
      if (ppx >= 22) {
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        for (let wx = startX; wx <= endX; wx++) {
          const sx = Math.floor((wx - camX) * ppx) + 0.5;
          ctx.beginPath();
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, ch);
          ctx.stroke();
        }
        for (let wy = startY; wy <= endY; wy++) {
          const sy = Math.floor((wy - camY) * ppy) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, sy);
          ctx.lineTo(cw, sy);
          ctx.stroke();
        }
      }

      // 2. Fog of War (for selected AI)
      if (state.settings.showFog && selAI && selAI.alive) {
        ctx.fillStyle = 'rgba(6, 9, 14, 0.78)';
        for (let wy = startY; wy <= endY; wy++) {
          const sy = Math.floor((wy - camY) * ppy);
          const sh = Math.ceil((wy + 1 - camY) * ppy) - sy;
          for (let wx = startX; wx <= endX; wx++) {
            if (!aiHasSeen(selAI, wx, wy)) {
              const sx = Math.floor((wx - camX) * ppx);
              const sw = Math.ceil((wx + 1 - camX) * ppx) - sx;
              ctx.fillRect(sx, sy, sw, sh);
            }
          }
        }
      }

      // Helper for interpolated AI screen position
      const tickMs = SPEED_MS[state.settings.speedIdx] ?? 250;
      const getAIScreenPos = (ai: AI) => {
        let frac = 1;
        if (tickMs > 0) {
          frac = Math.max(0, Math.min(1, (now - ai.moveStartMs) / tickMs));
        }
        const fx = ai.prevX + (ai.x - ai.prevX) * frac;
        const fy = ai.prevY + (ai.y - ai.prevY) * frac;
        return {
          cx: (fx - camX + 0.5) * ppx,
          cy: (fy - camY + 0.5) * ppy,
        };
      };

      // 3. Superstition taboo/shrine zones
      if (state.settings.showSuperstitions) {
        for (const a of state.ais) {
          if (!a.alive) continue;
          for (const z of a.superstitions) {
            const sx = (z.x - camX + 0.5) * ppx;
            const sy = (z.y - camY + 0.5) * ppy;
            ctx.save();
            ctx.strokeStyle =
              z.kind === 'taboo' ? 'rgba(192, 132, 252, 0.55)' : 'rgba(56, 189, 248, 0.55)';
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.arc(sx, sy, ppx * 1.45, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      // 4. Hearing radius & FOV cone for selected AI
      if (selAI && selAI.alive) {
        const { cx, cy } = getAIScreenPos(selAI);
        if (state.settings.showHearing) {
          ctx.save();
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
          ctx.setLineDash([5, 4]);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(cx, cy, selAI.hearing * ppx, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        if (state.settings.showFOV) {
          const dpx = selAI.fov * ppx;
          const dpy = selAI.fov * ppy;
          let x1 = cx;
          let y1 = cy;
          let x2 = cx;
          let y2 = cy;
          if (selAI.facing === 0) {
            x1 = cx - dpx;
            y1 = cy - dpy;
            x2 = cx + dpx;
            y2 = cy - dpy;
          } else if (selAI.facing === 1) {
            x1 = cx + dpx;
            y1 = cy - dpy;
            x2 = cx + dpx;
            y2 = cy + dpy;
          } else if (selAI.facing === 2) {
            x1 = cx - dpx;
            y1 = cy + dpy;
            x2 = cx + dpx;
            y2 = cy + dpy;
          } else {
            x1 = cx - dpx;
            y1 = cy - dpy;
            x2 = cx - dpx;
            y2 = cy + dpy;
          }
          ctx.save();
          ctx.fillStyle = 'rgba(250, 204, 21, 0.08)';
          ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }

      // 5. Trust & Royal Loyalty bonds
      if (state.settings.showBonds) {
        for (let i = 0; i < state.ais.length; i++) {
          const a = state.ais[i];
          if (!a.alive) continue;
          const posA = getAIScreenPos(a);

          // Royal allegiance tether (follower -> king)
          if (a.kingName) {
            const king = state.ais.find((k) => k.alive && k.name === a.kingName);
            if (king) {
              const posK = getAIScreenPos(king);
              ctx.save();
              ctx.strokeStyle = 'rgba(251, 191, 36, 0.65)';
              ctx.lineWidth = 1.6;
              ctx.beginPath();
              ctx.moveTo(posA.cx, posA.cy);
              ctx.lineTo(posK.cx, posK.cy);
              ctx.stroke();
              ctx.restore();
            }
          }

          // Mutual trust lines
          for (let j = i + 1; j < state.ais.length; j++) {
            const b = state.ais[j];
            if (!b.alive) continue;
            const t1 = getRelTrust(a, b.name);
            const t2 = getRelTrust(b, a.name);
            if (t1 < 35 || t2 < 35) continue;
            const posB = getAIScreenPos(b);
            ctx.save();
            ctx.strokeStyle =
              t1 >= 70 && t2 >= 70 ? 'rgba(52, 211, 153, 0.65)' : 'rgba(148, 163, 184, 0.35)';
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(posA.cx, posA.cy);
            ctx.lineTo(posB.cx, posB.cy);
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      // 6. Render AIs
      for (const a of state.ais) {
        if (!a.alive) continue;
        const { cx, cy } = getAIScreenPos(a);
        if (cx < -30 || cx > cw + 30 || cy < -30 || cy > ch + 30) continue;

        const rMax = Math.max(4, Math.min(ppx, ppy) * 0.56);
        const r = Math.max(3.5, Math.min(rMax, 3 + a.soul / 15));
        const isSel = a.id === selectedAI;

        // Sound ring animation
        if (state.settings.showSound && a.lastEmittedTick >= 0) {
          const age = state.tick - a.lastEmittedTick;
          if (age >= 0 && age < 4) {
            const ringR = (age + 1) * Math.min(ppx, ppy) * 0.85;
            const col = CONCEPT_COLORS[a.lastEmittedConcept] ?? '#38bdf8';
            ctx.save();
            ctx.strokeStyle = col;
            ctx.globalAlpha = Math.max(0.15, 0.85 - age * 0.22);
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
        }

        // Monster pulsing aura
        if (isMonster(a.soul)) {
          const pulse = ((state.tick / 3) % 4) + 3;
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(cx, cy, r + pulse, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Selection halo
        if (isSel) {
          ctx.strokeStyle = 'rgba(250, 204, 21, 0.8)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }

        drawAIShapeCanvas(ctx, cx, cy, r, a.shape, a.color, isSel);

        // King crown glyph
        if (a.isKing) {
          ctx.fillStyle = '#facc15';
          const crY = cy - r - 3;
          ctx.beginPath();
          ctx.moveTo(cx - 5, crY);
          ctx.lineTo(cx - 5, crY - 5);
          ctx.lineTo(cx - 2, crY - 2);
          ctx.lineTo(cx, crY - 6);
          ctx.lineTo(cx + 2, crY - 2);
          ctx.lineTo(cx + 5, crY - 5);
          ctx.lineTo(cx + 5, crY);
          ctx.closePath();
          ctx.fill();
        }

        // Health bar pip beneath AI
        const hpCol = a.soul > 50 ? '#22c55e' : a.soul > 20 ? '#eab308' : '#ef4444';
        ctx.fillStyle = hpCol;
        ctx.fillRect(cx - 5, cy + r + 2, 10, 2);

        // Facing tick for selected AI
        if (isSel) {
          let fx = cx;
          let fy = cy;
          if (a.facing === 0) fy -= r + 7;
          else if (a.facing === 1) fx += r + 7;
          else if (a.facing === 2) fy += r + 7;
          else fx -= r + 7;
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(fx, fy);
          ctx.stroke();
        }

        // Name label
        if (ppx >= 11) {
          ctx.font = '600 10px "IBM Plex Mono", monospace';
          ctx.textAlign = 'center';
          const labelY = cy - r - (a.isKing ? 10 : 5);
          ctx.fillStyle = 'rgba(7, 10, 15, 0.78)';
          ctx.fillRect(cx - 14, labelY - 9, 28, 11);
          ctx.fillStyle = isSel ? '#facc15' : '#e2e8f0';
          ctx.fillText(a.name, cx, labelY);
        }
      }

      ctx.restore();
      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [worldRef, selectedAI, camRef]);

  const getTileFromClient = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const state = worldRef.current;
    const vtx = Math.min(WORLD_W, ZOOM_LEVELS[state.settings.zoomIdx] ?? 40);
    const ppx = rect.width / vtx;
    const ppy = rect.height / Math.min(WORLD_H, Math.max(1, rect.height / ppx));
    const wx = Math.floor(camRef.current.x + mx / ppx);
    const wy = Math.floor(camRef.current.y + my / ppy);
    return { wx, wy, ppx, ppy };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    dragRef.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      camStartX: camRef.current.x,
      camStartY: camRef.current.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const pos = getTileFromClient(e.clientX, e.clientY);
    if (pos && pos.wx >= 0 && pos.wx < WORLD_W && pos.wy >= 0 && pos.wy < WORLD_H) {
      const state = worldRef.current;
      const hitAI = state.ais.find(
        (a) => a.alive && Math.abs(a.x - pos.wx) <= 1 && Math.abs(a.y - pos.wy) <= 1
      );
      setHoverInfo({
        x: pos.wx,
        y: pos.wy,
        tile: state.tiles[idxOf(pos.wx, pos.wy)] as Tile,
        aiName: hitAI?.name,
      });
    } else {
      setHoverInfo(null);
    }

    if (!dragRef.current.active || !pos) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      dragRef.current.moved = true;
      camRef.current.x = dragRef.current.camStartX - dx / pos.ppx;
      camRef.current.y = dragRef.current.camStartY - dy / pos.ppy;
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const wasMoved = dragRef.current.moved;
    dragRef.current.active = false;
    if (!wasMoved) {
      const pos = getTileFromClient(e.clientX, e.clientY);
      if (pos) {
        const state = worldRef.current;
        // Find nearest alive AI within 1.5 tiles
        let bestId = -1;
        let bestD2 = 3.2;
        for (const a of state.ais) {
          if (!a.alive) continue;
          const d2 = (a.x - pos.wx) ** 2 + (a.y - pos.wy) ** 2;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestId = a.id;
          }
        }
        if (bestId >= 0) {
          onSelectAI(bestId);
        }
      }
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) onAdjustZoom(+1);
    else if (e.deltaY > 0) onAdjustZoom(-1);
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-[#070a0f] select-none cursor-crosshair"
    >
      <canvas
        ref={canvasRef}
        className="block w-full h-full"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => {
          dragRef.current.active = false;
          setHoverInfo(null);
        }}
        onWheel={handleWheel}
      />

      {/* Coordinate crosshair probe (top-left of canvas) */}
      {hoverInfo && (
        <div className="pointer-events-none absolute top-3 left-3 bg-[#090d14]/90 border border-slate-800 px-2.5 py-1 text-[11px] font-mono tabular-nums text-slate-300">
          <span>
            @{hoverInfo.x},{hoverInfo.y}
          </span>
          <span className="mx-1.5 text-slate-600">·</span>
          <span className="text-slate-200">{TILE_NAMES[hoverInfo.tile]}</span>
          {hoverInfo.aiName && (
            <>
              <span className="mx-1.5 text-slate-600">·</span>
              <span className="text-cyan-400 font-semibold">{hoverInfo.aiName}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
