import React, { useEffect, useRef } from 'react';
import {
  ACT_ICONS,
  CONCEPT_NAMES,
  DAY_TICKS,
  N_CONCEPTS,
  Q_ACTIONS,
  Tile,
  WORLD_H,
  WORLD_W,
  WorldState,
} from '../sim/types';
import { decodeQState, idxOf, isNight, isSolid, nightFactor } from '../sim/engine';

interface PovRaycasterCanvasProps {
  worldRef: React.MutableRefObject<WorldState>;
  selectedAI: number;
  showHud?: boolean;
  className?: string;
}

function shadeRGB(r: number, g: number, b: number, factor: number): string {
  const f = Math.max(0.08, Math.min(1, factor));
  return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
}

export function PovRaycasterCanvas({
  worldRef,
  selectedAI,
  showHud = false,
  className = '',
}: PovRaycasterCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let rafId = 0;

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        rafId = requestAnimationFrame(render);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(120, Math.floor(rect.width));
      const h = Math.max(80, Math.floor(rect.height));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        rafId = requestAnimationFrame(render);
        return;
      }

      const state = worldRef.current;
      const a = state.ais[selectedAI];
      if (!a || !a.alive) {
        ctx.fillStyle = '#090d14';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#64748b';
        ctx.font = '12px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Signal lost — subject deceased', w / 2, h / 2);
        rafId = requestAnimationFrame(render);
        return;
      }

      const nf = nightFactor(state.tick);
      const nightMul = 1 - nf * 0.62;
      const horizon = Math.floor(h * 0.5);

      // Sky gradient
      const skyGrad = ctx.createLinearGradient(0, 0, 0, horizon);
      skyGrad.addColorStop(0, shadeRGB(19, 34, 58, nightMul));
      skyGrad.addColorStop(1, shadeRGB(46, 76, 114, nightMul));
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, w, horizon);

      // Ground gradient
      const gndGrad = ctx.createLinearGradient(0, horizon, 0, h);
      gndGrad.addColorStop(0, shadeRGB(26, 48, 30, nightMul));
      gndGrad.addColorStop(1, shadeRGB(58, 102, 64, nightMul));
      ctx.fillStyle = gndGrad;
      ctx.fillRect(0, horizon, w, h - horizon);

      // Facing vector (0=N, 1=E, 2=S, 3=W)
      let dirX = 0;
      let dirY = -1;
      if (a.facing === 1) {
        dirX = 1;
        dirY = 0;
      } else if (a.facing === 2) {
        dirX = 0;
        dirY = 1;
      } else if (a.facing === 3) {
        dirX = -1;
        dirY = 0;
      }

      const planeX = -dirY * 0.66;
      const planeY = dirX * 0.66;
      const posX = a.x + 0.5;
      const posY = a.y + 0.5;

      const colStep = w > 420 ? 2 : 1;
      const zBuffer = new Float32Array(w).fill(1e9);

      // Cast rays for walls
      for (let x = 0; x < w; x += colStep) {
        const cameraX = (2 * x) / w - 1;
        const rayDirX = dirX + planeX * cameraX;
        const rayDirY = dirY + planeY * cameraX;
        let mapX = Math.floor(posX);
        let mapY = Math.floor(posY);

        const deltaDistX = rayDirX === 0 ? 1e30 : Math.abs(1 / rayDirX);
        const deltaDistY = rayDirY === 0 ? 1e30 : Math.abs(1 / rayDirY);
        let sideDistX: number;
        let sideDistY: number;
        let stepX: number;
        let stepY: number;

        if (rayDirX < 0) {
          stepX = -1;
          sideDistX = (posX - mapX) * deltaDistX;
        } else {
          stepX = 1;
          sideDistX = (mapX + 1.0 - posX) * deltaDistX;
        }
        if (rayDirY < 0) {
          stepY = -1;
          sideDistY = (posY - mapY) * deltaDistY;
        } else {
          stepY = 1;
          sideDistY = (mapY + 1.0 - posY) * deltaDistY;
        }

        let hit = false;
        let side = 0;
        let hitTile: Tile = Tile.GRASS;
        let steps = 22;

        while (!hit && steps-- > 0) {
          if (sideDistX < sideDistY) {
            sideDistX += deltaDistX;
            mapX += stepX;
            side = 0;
          } else {
            sideDistY += deltaDistY;
            mapY += stepY;
            side = 1;
          }
          if (mapX < 0 || mapX >= WORLD_W || mapY < 0 || mapY >= WORLD_H) break;
          const t = state.tiles[idxOf(mapX, mapY)] as Tile;
          if (isSolid(t)) {
            hit = true;
            hitTile = t;
          }
        }

        if (hit) {
          const perpDist = Math.max(
            0.05,
            side === 0 ? sideDistX - deltaDistX : sideDistY - deltaDistY
          );
          for (let k = 0; k < colStep && x + k < w; k++) zBuffer[x + k] = perpDist;

          const lineH = Math.min(h, Math.floor(h / perpDist));
          const drawStart = Math.max(0, horizon - Math.floor(lineH / 2));
          const drawEnd = Math.min(h, horizon + Math.floor(lineH / 2));

          let r = 120;
          let g = 130;
          let b = 140;
          if (hitTile === Tile.FOREST) {
            r = 28;
            g = 86;
            b = 46;
          } else if (hitTile === Tile.STONE) {
            r = 124;
            g = 134;
            b = 146;
          } else if (hitTile === Tile.BUILT) {
            r = 166;
            g = 176;
            b = 190;
          }
          const sideMul = side === 1 ? 0.74 : 1.0;
          const fogMul = Math.max(0.15, 1 - perpDist * 0.065);
          ctx.fillStyle = shadeRGB(r, g, b, sideMul * fogMul * nightMul);
          ctx.fillRect(x, drawStart, colStep, drawEnd - drawStart);
        }
      }

      // Collect billboards: other AIs + berries + memorials + pits
      interface Spr {
        tx: number;
        ty: number;
        color: string;
        kind: 'ai' | 'food' | 'memorial' | 'pit';
        label?: string;
      }
      const sprites: Spr[] = [];
      for (const other of state.ais) {
        if (!other.alive || other.id === a.id) continue;
        sprites.push({
          tx: other.x + 0.5 - posX,
          ty: other.y + 0.5 - posY,
          color: other.color,
          kind: 'ai',
          label: other.name,
        });
      }
      for (let dy = -9; dy <= 9; dy++) {
        for (let dx = -9; dx <= 9; dx++) {
          const tx = a.x + dx;
          const ty = a.y + dy;
          if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) continue;
          const t = state.tiles[idxOf(tx, ty)] as Tile;
          if (t === Tile.FOOD) {
            sprites.push({ tx: tx + 0.5 - posX, ty: ty + 0.5 - posY, color: '#ef4444', kind: 'food' });
          } else if (t === Tile.MEMORIAL) {
            sprites.push({ tx: tx + 0.5 - posX, ty: ty + 0.5 - posY, color: '#facc15', kind: 'memorial' });
          } else if (t === Tile.PIT) {
            sprites.push({ tx: tx + 0.5 - posX, ty: ty + 0.5 - posY, color: '#090b0f', kind: 'pit' });
          }
        }
      }

      sprites.sort((s1, s2) => s2.tx * s2.tx + s2.ty * s2.ty - (s1.tx * s1.tx + s1.ty * s1.ty));
      const invDet = 1.0 / (planeX * dirY - dirX * planeY);

      for (const spr of sprites) {
        const transX = invDet * (dirY * spr.tx - dirX * spr.ty);
        const transY = invDet * (-planeY * spr.tx + planeX * spr.ty);
        if (transY <= 0.15) continue;

        const screenX = Math.floor((w / 2) * (1 + transX / transY));
        let sprH = Math.abs(Math.floor(h / transY));
        let sprW = sprH;
        if (spr.kind !== 'ai') {
          sprH = Math.floor(sprH * 0.36);
          sprW = Math.floor(sprW * 0.36);
        }
        let y0 = Math.max(0, horizon - Math.floor(sprH / 2));
        let y1 = Math.min(h, horizon + Math.floor(sprH / 2));
        if (spr.kind === 'pit') {
          sprW = Math.floor(sprW * 2.2);
          y0 = horizon + Math.floor(sprH * 0.25);
          y1 = Math.min(h, horizon + sprH);
        } else if (spr.kind === 'food') {
          y0 = horizon + Math.floor(sprH * 0.1);
          y1 = Math.min(h, horizon + Math.floor(sprH * 0.9));
        }

        const x0 = screenX - Math.floor(sprW / 2);
        const x1 = screenX + Math.floor(sprW / 2);

        const fogAlpha = Math.max(0.25, Math.min(1, 1 - transY * 0.055));
        ctx.save();
        ctx.globalAlpha = fogAlpha;
        ctx.fillStyle = spr.color;
        let visibleCols = 0;
        for (let xs = Math.max(0, x0); xs < Math.min(w, x1); xs++) {
          if (zBuffer[xs] <= transY) continue;
          ctx.fillRect(xs, y0, 1, Math.max(1, y1 - y0));
          visibleCols++;
        }
        if (spr.kind === 'ai' && spr.label && visibleCols > 8 && transY < 8) {
          ctx.globalAlpha = 0.95;
          ctx.font = '600 10px "IBM Plex Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillStyle = '#f8fafc';
          ctx.fillText(spr.label, screenX, Math.max(12, y0 - 4));
        }
        ctx.restore();
      }

      // Compact compass in top-right always visible
      const dirs = ['N', 'E', 'S', 'W'];
      ctx.fillStyle = 'rgba(8, 11, 16, 0.72)';
      ctx.fillRect(w - 30, 6, 24, 18);
      ctx.fillStyle = '#facc15';
      ctx.font = '600 11px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(dirs[a.facing], w - 18, 19);

      ctx.fillStyle = 'rgba(8, 11, 16, 0.72)';
      ctx.fillRect(6, 6, 62, 18);
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'left';
      ctx.fillText(`POV ${isNight(state.tick) ? 'NGT' : 'DAY'}`, 10, 19);

      // Fullscreen POV HUD overlay (mirrors renderPOVFullscreen)
      if (showHud && w >= 360) {
        const st = decodeQState(a.currentState);
        // Top-left identity overlay
        ctx.fillStyle = 'rgba(8, 11, 16, 0.76)';
        ctx.fillRect(8, 30, 176, 48);
        ctx.fillStyle = '#22d3ee';
        ctx.font = '700 15px "IBM Plex Mono", monospace';
        ctx.fillText(a.name, 16, 49);
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '11px "IBM Plex Mono", monospace';
        ctx.fillText(`SOUL ${a.soul} · ${(a.age / DAY_TICKS).toFixed(2)}d`, 62, 49);
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(
          `${st.need} · thr:${st.threat} F${st.foodKnown ? '+' : '-'} W${st.waterKnown ? '+' : '-'}`,
          16,
          68
        );

        // Bottom Q-bars + Action + Heard overlay
        const barAreaH = 74;
        const qY = h - barAreaH;
        ctx.fillStyle = 'rgba(8, 11, 16, 0.84)';
        ctx.fillRect(0, qY, w, barAreaH);
        ctx.strokeStyle = '#1e293b';
        ctx.beginPath();
        ctx.moveTo(0, qY + 0.5);
        ctx.lineTo(w, qY + 0.5);
        ctx.stroke();

        ctx.fillStyle = '#4ade80';
        ctx.font = '600 11px "IBM Plex Mono", monospace';
        ctx.fillText(`> ${a.lastAction}`, 12, qY + 16);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px "IBM Plex Mono", monospace';
        ctx.fillText(a.lastReason, 120, qY + 16);

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
          ctx.fillStyle = '#facc15';
          ctx.textAlign = 'right';
          ctx.fillText(
            `heard ${a.lastHeardFrom} S${a.lastHeardSound} → "${CONCEPT_NAMES[bestC]}"`,
            w - 12,
            qY + 16
          );
          ctx.textAlign = 'left';
        }

        // 14 Q-value vertical bars
        const padX = 12;
        const barW = Math.floor((w - padX * 2) / Q_ACTIONS);
        const qbY = qY + 24;
        const qbH = 30;
        const mid = qbY + qbH / 2;

        for (let i = 0; i < Q_ACTIONS; i++) {
          const qx = padX + i * barW;
          const qv =
            a.currentState >= 0 ? a.qtable[a.currentState * Q_ACTIONS + i] / 10.0 : 0;
          const picked = i === a.chosenAction;
          ctx.fillStyle = '#111827';
          ctx.fillRect(qx, qbY, barW - 3, qbH);
          ctx.fillStyle = '#334155';
          ctx.fillRect(qx, mid, barW - 3, 1);

          const bh = Math.max(-qbH / 2, Math.min(qbH / 2, qv * 2.2));
          ctx.fillStyle = bh >= 0 ? '#22c55e' : '#ef4444';
          if (bh > 0) ctx.fillRect(qx, mid - bh, barW - 3, bh);
          else if (bh < 0) ctx.fillRect(qx, mid, barW - 3, -bh);

          if (picked) {
            ctx.strokeStyle = '#facc15';
            ctx.lineWidth = 1.4;
            ctx.strokeRect(qx + 0.5, qbY + 0.5, barW - 4, qbH - 1);
          }

          ctx.fillStyle = picked ? '#facc15' : '#94a3b8';
          ctx.font = '600 10px "IBM Plex Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(ACT_ICONS[i], qx + (barW - 3) / 2, qbY + qbH + 12);
        }
        ctx.textAlign = 'left';
      }

      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafId);
  }, [worldRef, selectedAI, showHud]);

  return (
    <canvas
      ref={canvasRef}
      className={`block w-full h-full bg-[#090d14] ${className}`}
    />
  );
}
