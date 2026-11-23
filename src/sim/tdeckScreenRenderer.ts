import {
  ACT_ICONS,
  ACT_NAMES,
  CARRY_NAMES,
  CONCEPT_COLORS,
  CONCEPT_NAMES,
  DAY_TICKS,
  N_CONCEPTS,
  N_SOUNDS,
  Q_ACTIONS,
  SPEED_LABELS,
  SPEED_MS,
  Tile,
  TILE_COLORS,
  WORLD_H,
  WORLD_W,
  WorldState,
  ZOOM_LEVELS,
} from './types';
import {
  aiHasSeen,
  decodeQState,
  getLifeStage,
  getRelTrust,
  idxOf,
  isMonster,
  isNight,
  isSolid,
  nightFactor,
} from './engine';
import { decodeAllMemories, formatMemorySummary, RECORD_BYTES } from './memoryStore';

// Native LilyGO T-Deck Plus ST7789 IPS resolution (scaled 2x internally = 640x480 for razor-sharp WebGL texture)
export const TDECK_W = 320;
export const TDECK_H = 240;
export const TDECK_SCALE = 2;

export type TDeckScreenMode = 'map' | 'expanded' | 'settings';

export interface TDeckUIState {
  mode: TDeckScreenMode;
  selectedAI: number;
  panelOpen: boolean;
  rSectionIdx: number; // 0..6 (POV, GROWTH, NEEDS, BRAIN, RELATIONS, LANGUAGE, SD MEMORY)
  rSectionFull: boolean;
  settingsIdx: number;
  camX: number;
  camY: number;
}

export const R_SECTION_NAMES = [
  'POV',
  'GROWTH',
  'NEEDS',
  'BRAIN',
  'RELATIONS',
  'LANGUAGE',
  'SD MEMORY',
] as const;

function darkenHex(hex: string, factor: number): string {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.round(((num >> 16) & 255) * (1 - factor)));
  const g = Math.max(0, Math.round(((num >> 8) & 255) * (1 - factor)));
  const b = Math.max(0, Math.round((num & 255) * (1 - factor)));
  return `rgb(${r},${g},${b})`;
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  shape: number,
  col: string,
  selected: boolean
): void {
  ctx.fillStyle = col;
  ctx.strokeStyle = selected ? '#facc15' : '#000000';
  ctx.lineWidth = selected ? 1.4 : 0.8;
  ctx.beginPath();
  if (shape === 0) {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  } else if (shape === 1) {
    ctx.rect(cx - r, cy - r, r * 2, r * 2);
  } else if (shape === 2) {
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx - r, cy + r);
    ctx.lineTo(cx + r, cy + r);
    ctx.closePath();
  } else if (shape === 3) {
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
  } else if (shape === 4) {
    ctx.moveTo(cx - r, cy - r);
    ctx.lineTo(cx + r, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.closePath();
  } else if (shape === 5) {
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
  } else if (shape === 6) {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  } else {
    for (let i = 0; i < 5; i++) {
      const ang = -Math.PI / 2 + (i * Math.PI * 2) / 5;
      const px = cx + Math.cos(ang) * r;
      const py = cy + Math.sin(ang) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
  if (shape === 6) {
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, r * 0.42), 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderRaycasterBlock(
  ctx: CanvasRenderingContext2D,
  state: WorldState,
  aiIdx: number,
  ox: number,
  oy: number,
  w: number,
  h: number
): void {
  const a = state.ais[aiIdx];
  if (!a || !a.alive) {
    ctx.fillStyle = '#080c12';
    ctx.fillRect(ox, oy, w, h);
    ctx.fillStyle = '#64748b';
    ctx.font = '8px "IBM Plex Mono", monospace';
    ctx.fillText('NO SIGNAL', ox + 8, oy + h / 2);
    return;
  }

  const nf = nightFactor(state.tick);
  const nightMul = 1 - nf * 0.6;
  const horizon = Math.floor(h / 2);

  ctx.fillStyle = `rgb(${Math.round(32 * nightMul)},${Math.round(58 * nightMul)},${Math.round(92 * nightMul)})`;
  ctx.fillRect(ox, oy, w, horizon);
  ctx.fillStyle = `rgb(${Math.round(42 * nightMul)},${Math.round(78 * nightMul)},${Math.round(48 * nightMul)})`;
  ctx.fillRect(ox, oy + horizon, w, h - horizon);

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
  const zBuf = new Float32Array(w).fill(1e9);

  for (let x = 0; x < w; x += 2) {
    const camX = (2 * x) / w - 1;
    const rdx = dirX + planeX * camX;
    const rdy = dirY + planeY * camX;
    let mx = Math.floor(posX);
    let my = Math.floor(posY);
    const ddx = rdx === 0 ? 1e30 : Math.abs(1 / rdx);
    const ddy = rdy === 0 ? 1e30 : Math.abs(1 / rdy);
    let sdx = rdx < 0 ? (posX - mx) * ddx : (mx + 1 - posX) * ddx;
    let sdy = rdy < 0 ? (posY - my) * ddy : (my + 1 - posY) * ddy;
    const sx = rdx < 0 ? -1 : 1;
    const sy = rdy < 0 ? -1 : 1;

    let hit = false;
    let side = 0;
    let hitT: Tile = Tile.GRASS;
    for (let st = 0; st < 18 && !hit; st++) {
      if (sdx < sdy) {
        sdx += ddx;
        mx += sx;
        side = 0;
      } else {
        sdy += ddy;
        my += sy;
        side = 1;
      }
      if (mx < 0 || mx >= WORLD_W || my < 0 || my >= WORLD_H) break;
      const t = state.tiles[idxOf(mx, my)] as Tile;
      if (isSolid(t)) {
        hit = true;
        hitT = t;
      }
    }

    if (hit) {
      const dist = Math.max(0.05, side === 0 ? sdx - ddx : sdy - ddy);
      zBuf[x] = dist;
      if (x + 1 < w) zBuf[x + 1] = dist;
      const lh = Math.min(h, Math.floor(h / dist));
      const y0 = Math.max(0, horizon - Math.floor(lh / 2));
      const y1 = Math.min(h, horizon + Math.floor(lh / 2));
      const baseHex =
        hitT === Tile.FOREST ? '#24663a' : hitT === Tile.STONE ? '#7a8490' : '#a9b4c2';
      const fog = Math.min(0.82, dist * 0.065 + (side === 1 ? 0.16 : 0) + nf * 0.35);
      ctx.fillStyle = darkenHex(baseHex, fog);
      ctx.fillRect(ox + x, oy + y0, 2, y1 - y0);
    }
  }

  // Billboards for nearby AIs, berries, memorials
  const sprites: { tx: number; ty: number; col: string; small: boolean }[] = [];
  for (const o of state.ais) {
    if (!o.alive || o.id === a.id) continue;
    sprites.push({ tx: o.x + 0.5 - posX, ty: o.y + 0.5 - posY, col: o.color, small: false });
  }
  for (let dy = -7; dy <= 7; dy++) {
    for (let dx = -7; dx <= 7; dx++) {
      const tx = a.x + dx;
      const ty = a.y + dy;
      if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) continue;
      const t = state.tiles[idxOf(tx, ty)] as Tile;
      if (t === Tile.FOOD) sprites.push({ tx: tx + 0.5 - posX, ty: ty + 0.5 - posY, col: '#ef4444', small: true });
      else if (t === Tile.MEMORIAL) sprites.push({ tx: tx + 0.5 - posX, ty: ty + 0.5 - posY, col: '#facc15', small: true });
    }
  }
  sprites.sort((p, q) => q.tx * q.tx + q.ty * q.ty - (p.tx * p.tx + p.ty * p.ty));
  const invDet = 1 / (planeX * dirY - dirX * planeY);
  for (const s of sprites) {
    const trx = invDet * (dirY * s.tx - dirX * s.ty);
    const tryy = invDet * (-planeY * s.tx + planeX * s.ty);
    if (tryy <= 0.15) continue;
    const scx = Math.floor((w / 2) * (1 + trx / tryy));
    const sh = Math.floor((h / tryy) * (s.small ? 0.36 : 0.95));
    const sw = Math.max(2, sh);
    const y0 = Math.max(0, horizon - Math.floor(sh / 2));
    const y1 = Math.min(h, horizon + Math.floor(sh / 2));
    ctx.fillStyle = s.col;
    for (let xs = Math.max(0, scx - Math.floor(sw / 2)); xs < Math.min(w, scx + Math.floor(sw / 2)); xs += 2) {
      if (zBuf[xs] <= tryy) continue;
      ctx.fillRect(ox + xs, oy + y0, 2, Math.max(1, y1 - y0));
    }
  }

  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + 0.5, oy + 0.5, w - 1, h - 1);
  const dirs = ['N', 'E', 'S', 'W'];
  ctx.fillStyle = '#facc15';
  ctx.font = 'bold 8px "IBM Plex Mono", monospace';
  ctx.fillText(dirs[a.facing], ox + w - 10, oy + 9);
}

function renderGrowthBlock(
  ctx: CanvasRenderingContext2D,
  state: WorldState,
  aiIdx: number,
  ox: number,
  oy: number,
  w: number,
  h: number
): void {
  const a = state.ais[aiIdx];
  ctx.fillStyle = '#040812';
  ctx.fillRect(ox, oy, w, h);
  ctx.strokeStyle = '#162234';
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + 0.5, oy + 0.5, w - 1, h - 1);
  if (!a || !a.alive) return;

  const cx = ox + w * 0.5;
  const cy = oy + h * 0.5;
  const maxR = Math.min(w, h) * 0.43;

  // Polar calibration rings & subtle crosshair
  ctx.strokeStyle = '#0e1b2d';
  ctx.lineWidth = 0.75;
  for (const frac of [0.32, 0.64, 0.96]) {
    ctx.beginPath();
    ctx.arc(cx, cy, maxR * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - maxR * 1.04, cy);
  ctx.lineTo(cx + maxR * 1.04, cy);
  ctx.moveTo(cx, cy - maxR * 1.04);
  ctx.lineTo(cx, cy + maxR * 1.04);
  ctx.stroke();

  const seed = a.name.charCodeAt(0) * 73 + a.name.charCodeAt(1) * 97 + a.name.charCodeAt(2) * 131;
  const baseRot = ((seed & 0xff) / 256) * Math.PI * 2;
  const ramCells = Math.max(2, Math.min(16, Math.floor(a.soul / 10) + 2));
  const nodes = Math.max(6, ramCells + 3);
  const t = state.tick * 0.06;

  // Inner genetic trait polygon (Aggression, Curiosity, Trust, Energy)
  const traits = [a.aggression, a.curiosity, a.trust, a.energy];
  ctx.fillStyle = 'rgba(34, 211, 238, 0.14)';
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  traits.forEach((tv, i) => {
    const ang = -Math.PI / 2 + (i * Math.PI * 2) / 4;
    const rr = maxR * (0.18 + 0.34 * Math.max(0.1, Math.min(1, tv)));
    const px = cx + Math.cos(ang) * rr;
    const py = cy + Math.sin(ang) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Outer synaptic lattice nodes weighted by live Q-table activation
  const pts: { x: number; y: number; active: boolean }[] = [];
  for (let i = 0; i < nodes; i++) {
    const ang = baseRot + (i * Math.PI * 2) / nodes + t * 0.12;
    const qVal =
      a.currentState >= 0
        ? a.qtable[a.currentState * Q_ACTIONS + (i % Q_ACTIONS)] / 10
        : 0;
    const boost = Math.max(-0.12, Math.min(0.16, qVal * 0.03));
    const r =
      maxR * (0.48 + 0.42 * (((i * 5) % nodes) / nodes) + boost) +
      Math.sin(t + i * 0.85) * 1.8;
    const active = (state.tick + i * 7) % 36 < 6 || i % Q_ACTIONS === a.chosenAction;
    pts.push({ x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r, active });
  }

  // Synaptic ring & cross-links
  for (let i = 0; i < nodes; i++) {
    const next = (i + 1) % nodes;
    const hop = (i * 3 + 2) % nodes;
    const firing = pts[i].active;

    ctx.strokeStyle = firing ? '#38bdf8' : '#16304d';
    ctx.lineWidth = firing ? 1.15 : 0.7;
    ctx.beginPath();
    ctx.moveTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[hop].x, pts[hop].y);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(34, 211, 238, 0.25)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[next].x, pts[next].y);
    ctx.stroke();
  }

  // Nodes & pulsing core
  for (let i = 0; i < nodes; i++) {
    ctx.fillStyle = pts[i].active ? '#f8fafc' : i < ramCells ? '#38bdf8' : '#334155';
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, pts[i].active ? 2.3 : 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Center soul nucleus
  ctx.fillStyle = a.color;
  ctx.strokeStyle = '#f8fafc';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.arc(cx, cy, 4.0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Corner genetic telemetry (left & right columns stay outside central mandala)
  ctx.font = '7px "IBM Plex Mono", monospace';
  ctx.fillStyle = '#64748b';
  ctx.fillText('TRAITS', ox + 6, oy + 12);
  ctx.fillStyle = '#f87171';
  ctx.fillText(`AGG ${Math.round(a.aggression * 100)}%`, ox + 6, oy + 23);
  ctx.fillStyle = '#38bdf8';
  ctx.fillText(`CUR ${Math.round(a.curiosity * 100)}%`, ox + 6, oy + 33);
  ctx.fillStyle = '#4ade80';
  ctx.fillText(`TRS ${Math.round(a.trust * 100)}%`, ox + 6, oy + 43);

  ctx.fillStyle = '#64748b';
  ctx.fillText('LINEAGE', ox + 6, oy + h - 22);
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(a.parent1 ? `${a.parent1}+${a.parent2}` : 'GEN-0 POOL', ox + 6, oy + h - 11);

  const rx = ox + w - 66;
  ctx.fillStyle = '#64748b';
  ctx.fillText('SYNAPSES', rx, oy + 12);
  ctx.fillStyle = '#22d3ee';
  ctx.fillText(`RAM ${ramCells}/16`, rx, oy + 23);
  ctx.fillStyle = '#facc15';
  ctx.fillText(`EPS ${a.epsilon.toFixed(2)}`, rx, oy + 33);
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`REC ${a.sdRecordCount}`, rx, oy + 43);

  ctx.fillStyle = '#64748b';
  ctx.fillText('STATUS', rx, oy + h - 22);
  ctx.fillStyle = a.isKing ? '#facc15' : '#4ade80';
  ctx.fillText(a.isKing ? `KING(${a.followerCount})` : a.lastAction.slice(0, 9), rx, oy + h - 11);
}

/**
 * Renders the pixel-exact 320x240 LilyGO T-Deck Plus display onto a Canvas2D context.
 * The canvas is 640x480 (scale=2) so glyphs and tiles stay super crisp on the 3D screen.
 */
export function renderTDeckScreen(
  ctx: CanvasRenderingContext2D,
  state: WorldState,
  ui: TDeckUIState
): void {
  ctx.save();
  ctx.scale(TDECK_SCALE, TDECK_SCALE);
  ctx.fillStyle = '#05070b';
  ctx.fillRect(0, 0, TDECK_W, TDECK_H);

  const a = state.ais[ui.selectedAI] ?? state.ais[0];
  const aliveCount = state.ais.filter((ai) => ai.alive).length;

  // ==================== EXPANDED R-VIEW ====================
  if (ui.mode === 'expanded' && a) {
    // Top fixed banner (0..26)
    ctx.fillStyle = '#0f1622';
    ctx.fillRect(0, 0, TDECK_W, 26);
    ctx.fillStyle = a.alive ? '#22d3ee' : '#f43f5e';
    ctx.font = 'bold 15px "IBM Plex Mono", monospace';
    ctx.fillText(a.name, 5, 17);
    if (a.alive) drawShape(ctx, 44, 12, 5.5, a.shape, a.color, false);

    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 8px "IBM Plex Mono", monospace';
    ctx.fillText(`SOUL ${a.soul}`, 62, 10);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '8px "IBM Plex Mono", monospace';
    ctx.fillText(
      `age ${(a.age / DAY_TICKS).toFixed(2)}d ${getLifeStage(a.age)} ${a.isKing ? 'KING' : a.kingName ? `->${a.kingName}` : ''}`,
      62,
      20
    );

    // Section tabs strip (26..39)
    ctx.fillStyle = '#090d14';
    ctx.fillRect(0, 26, TDECK_W, 13);
    const shortTabs = ['POV', 'DNA', 'NED', 'BRN', 'REL', 'LNG', 'SD'];
    const tw = TDECK_W / shortTabs.length;
    shortTabs.forEach((lbl, idx) => {
      const sel = idx === ui.rSectionIdx;
      if (sel) {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(idx * tw + 1, 27, tw - 2, 11);
      }
      ctx.fillStyle = sel ? '#22d3ee' : '#64748b';
      ctx.font = sel ? 'bold 7.5px "IBM Plex Mono", monospace' : '7.5px "IBM Plex Mono", monospace';
      ctx.fillText(lbl, idx * tw + 8, 35);
    });

    const cy0 = 41;
    const ch = TDECK_H - 53;

    if (ui.rSectionIdx === 0) {
      // POV Raycaster
      renderRaycasterBlock(ctx, state, ui.selectedAI, 4, cy0, TDECK_W - 8, ch - 30);
      const qy = cy0 + ch - 28;
      ctx.fillStyle = '#4ade80';
      ctx.font = 'bold 8px "IBM Plex Mono", monospace';
      ctx.fillText(`> ${a.lastAction}`, 6, qy + 8);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '7.5px "IBM Plex Mono", monospace';
      ctx.fillText(a.lastReason.slice(0, 32), 84, qy + 8);
      // 14 mini Q bars
      const bw = Math.floor((TDECK_W - 12) / Q_ACTIONS);
      for (let i = 0; i < Q_ACTIONS; i++) {
        const qx = 6 + i * bw;
        const qv = a.currentState >= 0 ? a.qtable[a.currentState * Q_ACTIONS + i] / 10 : 0;
        const bh = Math.max(-7, Math.min(7, qv * 1.1));
        ctx.fillStyle = '#111827';
        ctx.fillRect(qx, qy + 11, bw - 1, 14);
        ctx.fillStyle = bh >= 0 ? '#22c55e' : '#ef4444';
        if (bh >= 0) ctx.fillRect(qx, qy + 18 - bh, bw - 1, Math.max(1, bh));
        else ctx.fillRect(qx, qy + 18, bw - 1, -bh);
        if (i === a.chosenAction) {
          ctx.strokeStyle = '#facc15';
          ctx.strokeRect(qx + 0.5, qy + 11.5, bw - 2, 13);
        }
      }
    } else if (ui.rSectionIdx === 1) {
      // GROWTH DNA
      renderGrowthBlock(ctx, state, ui.selectedAI, 4, cy0, TDECK_W - 8, ch - 18);
      ctx.fillStyle = '#22d3ee';
      ctx.font = '8px "IBM Plex Mono", monospace';
      ctx.fillText(
        `RAM cells: ${Math.max(2, Math.min(16, Math.floor(a.soul / 10) + 2))}  FOV:${a.fov}  SD:${a.sdRecordCount * RECORD_BYTES}B`,
        8,
        cy0 + ch - 5
      );
    } else if (ui.rSectionIdx === 2) {
      // NEEDS
      const items = [
        { l: 'HUNGER', v: a.hunger, c: '#ef4444' },
        { l: 'THIRST', v: a.thirst, c: '#38bdf8' },
        { l: 'ENERGY', v: a.energy, c: '#22c55e' },
      ];
      items.forEach((it, idx) => {
        const y = cy0 + 8 + idx * 24;
        ctx.fillStyle = '#cbd5e1';
        ctx.font = 'bold 8px "IBM Plex Mono", monospace';
        ctx.fillText(it.l, 10, y + 7);
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(58, y, 200, 9);
        ctx.fillStyle = it.c;
        ctx.fillRect(58, y, Math.round(it.v * 200), 9);
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(`${Math.round(it.v * 100)}%`, 266, y + 7);
      });
      ctx.fillStyle = '#facc15';
      ctx.font = '8px "IBM Plex Mono", monospace';
      ctx.fillText(
        `DISPOSITION  agg:${a.aggression.toFixed(2)}  cur:${a.curiosity.toFixed(2)}  trs:${a.trust.toFixed(2)}`,
        10,
        cy0 + 96
      );
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(
        `SENSES  fov:${a.fov} tiles  hearing:${a.hearing} tiles  taboos:${a.superstitions.length}`,
        10,
        cy0 + 114
      );
      ctx.fillText(
        `CARRY: ${CARRY_NAMES[a.carrying]}   TRADES: ${a.trades}   RECALLS: ${a.recalls}`,
        10,
        cy0 + 132
      );
    } else if (ui.rSectionIdx === 3) {
      // BRAIN Q-TABLE
      const st = decodeQState(a.currentState);
      ctx.fillStyle = '#22d3ee';
      ctx.font = '8px "IBM Plex Mono", monospace';
      ctx.fillText(
        `STATE #${a.currentState} ${st.need} thr:${st.threat} F${st.foodKnown ? '+' : '-'} W${st.waterKnown ? '+' : '-'} eps:${a.epsilon.toFixed(2)}`,
        8,
        cy0 + 10
      );
      const bw = Math.floor((TDECK_W - 16) / Q_ACTIONS);
      const mid = cy0 + 82;
      for (let i = 0; i < Q_ACTIONS; i++) {
        const qx = 8 + i * bw;
        const qv = a.currentState >= 0 ? a.qtable[a.currentState * Q_ACTIONS + i] / 10 : 0;
        const bh = Math.max(-44, Math.min(44, qv * 3.8));
        ctx.fillStyle = '#111827';
        ctx.fillRect(qx, cy0 + 34, bw - 2, 96);
        ctx.fillStyle = '#334155';
        ctx.fillRect(qx, mid, bw - 2, 1);
        ctx.fillStyle = bh >= 0 ? '#22c55e' : '#ef4444';
        if (bh >= 0) ctx.fillRect(qx, mid - bh, bw - 2, Math.max(1, bh));
        else ctx.fillRect(qx, mid, bw - 2, -bh);
        if (i === a.chosenAction) {
          ctx.strokeStyle = '#facc15';
          ctx.strokeRect(qx + 0.5, cy0 + 34.5, bw - 3, 95);
        }
        ctx.fillStyle = i === a.chosenAction ? '#facc15' : '#94a3b8';
        ctx.font = '7.5px "IBM Plex Mono", monospace';
        ctx.fillText(ACT_ICONS[i], qx + 6, cy0 + 141);
      }
      ctx.fillStyle = '#4ade80';
      ctx.font = '8px "IBM Plex Mono", monospace';
      ctx.fillText(`ACT: ${a.lastAction} (${a.lastReason})`, 8, cy0 + 162);
    } else if (ui.rSectionIdx === 4) {
      // RELATIONS & LOYALTY
      ctx.fillStyle = '#f9a8d4';
      ctx.font = 'bold 8px "IBM Plex Mono", monospace';
      ctx.fillText('TRUST (-100..+100) & LOYALTY (0..100)', 8, cy0 + 10);
      const sorted = [...a.relations]
        .sort((x, y) => y.loyalty - x.loyalty || Math.abs(y.trust) - Math.abs(x.trust))
        .slice(0, 6);
      if (sorted.length === 0) {
        ctx.fillStyle = '#64748b';
        ctx.fillText('(no relationships recorded yet)', 8, cy0 + 32);
      } else {
        sorted.forEach((rel, idx) => {
          const y = cy0 + 24 + idx * 19;
          ctx.fillStyle = a.kingName === rel.name ? '#facc15' : '#e2e8f0';
          ctx.font = 'bold 8px "IBM Plex Mono", monospace';
          ctx.fillText(rel.name, 8, y + 6);
          ctx.fillStyle = '#1e293b';
          ctx.fillRect(38, y, 80, 6);
          const zero = 78;
          ctx.fillStyle = rel.trust >= 0 ? '#22c55e' : '#ef4444';
          if (rel.trust >= 0) ctx.fillRect(zero, y, (rel.trust / 100) * 40, 6);
          else ctx.fillRect(zero + (rel.trust / 100) * 40, y, (-rel.trust / 100) * 40, 6);

          ctx.fillStyle = '#1e293b';
          ctx.fillRect(130, y, 90, 6);
          ctx.fillStyle = rel.loyalty >= 55 ? '#facc15' : '#38bdf8';
          ctx.fillRect(130, y, (rel.loyalty / 100) * 90, 6);

          ctx.fillStyle = '#94a3b8';
          ctx.font = '7.5px "IBM Plex Mono", monospace';
          ctx.fillText(`T${rel.trust >= 0 ? '+' : ''}${rel.trust} L${rel.loyalty}`, 228, y + 6);
        });
      }
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '8px "IBM Plex Mono", monospace';
      ctx.fillText(
        `LINEAGE: ${a.parent1 ? `${a.parent1}+${a.parent2}` : 'pool'}  kids:${a.numChildren}  k:${a.kills} h:${a.helps}`,
        8,
        cy0 + ch - 8
      );
    } else if (ui.rSectionIdx === 5) {
      // LANGUAGE MATRIX
      const sz = 14;
      const gx = 30;
      const gy = cy0 + 18;
      ctx.fillStyle = '#94a3b8';
      ctx.font = '7px "IBM Plex Mono", monospace';
      CONCEPT_NAMES.forEach((cn, c) => {
        ctx.fillText(cn.slice(0, 2), gx + c * sz + 2, gy - 4);
      });
      for (let s = 0; s < N_SOUNDS; s++) {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(`S${s}`, 10, gy + s * sz + 10);
        for (let c = 0; c < N_CONCEPTS; c++) {
          const val = a.ear[s * N_CONCEPTS + c];
          const g = Math.min(255, val * 9);
          ctx.fillStyle = val > 0 ? `rgb(10,${Math.max(40, g)},55)` : '#0e1520';
          ctx.fillRect(gx + c * sz, gy + s * sz, sz - 1, sz - 1);
          if (a.mouth[c] === s) {
            ctx.strokeStyle = '#facc15';
            ctx.lineWidth = 1;
            ctx.strokeRect(gx + c * sz + 0.5, gy + s * sz + 0.5, sz - 2, sz - 2);
          }
        }
      }
      // Mouth map summary on right
      const rx = gx + N_CONCEPTS * sz + 16;
      ctx.fillStyle = '#facc15';
      ctx.font = 'bold 8px "IBM Plex Mono", monospace';
      ctx.fillText('MOUTH MAP', rx, gy + 4);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '8px "IBM Plex Mono", monospace';
      CONCEPT_NAMES.forEach((cn, c) => {
        ctx.fillText(`${cn.padEnd(4)} -> S${a.mouth[c]}`, rx, gy + 18 + c * 13);
      });
    } else {
      // SD MEMORY (.dat)
      ctx.fillStyle = '#22d3ee';
      ctx.font = 'bold 8px "IBM Plex Mono", monospace';
      ctx.fillText(
        `/memories/${a.name}.dat  (${a.sdRecordCount} x 16B = ${a.sdRecordCount * RECORD_BYTES}B)`,
        8,
        cy0 + 10
      );
      const recs = decodeAllMemories(a, 11);
      ctx.font = '7.5px "IBM Plex Mono", monospace';
      recs.forEach((r, idx) => {
        ctx.fillStyle = idx === 0 ? '#f8fafc' : '#94a3b8';
        ctx.fillText(formatMemorySummary(r).slice(0, 50), 8, cy0 + 25 + idx * 14);
      });
    }

    // Bottom hint bar
    ctx.fillStyle = '#0c111a';
    ctx.fillRect(0, TDECK_H - 12, TDECK_W, 12);
    ctx.fillStyle = '#64748b';
    ctx.font = '7.5px "IBM Plex Mono", monospace';
    ctx.fillText('A/D:tab  p/P:AI  R:map  M:settings  0-5:spd', 5, TDECK_H - 3);
    ctx.restore();
    return;
  }

  // ==================== MAP + HUD + SIDE PANEL / SETTINGS ====================
  const HUD_H = 22;
  const PAN_W = ui.panelOpen ? 124 : 0;
  const MAP_W = ui.panelOpen ? TDECK_W - PAN_W - 1 : TDECK_W;
  const MAP_H = TDECK_H - HUD_H;

  // 1) Top HUD bar (2 rows)
  ctx.fillStyle = '#070a10';
  ctx.fillRect(0, 0, TDECK_W, HUD_H);
  ctx.fillStyle = isNight(state.tick) ? '#38bdf8' : '#f8fafc';
  ctx.font = 'bold 8px "IBM Plex Mono", monospace';
  ctx.fillText(
    `t${String(state.tick).padStart(5, '0')} pop${aliveCount} pool${state.soulPool} ${SPEED_LABELS[state.settings.speedIdx]} ${isNight(state.tick) ? 'NGT' : 'DAY'}`,
    3,
    9
  );
  const latestEv = state.events[0];
  if (latestEv) {
    ctx.fillStyle = latestEv.color;
    ctx.font = '7.5px "IBM Plex Mono", monospace';
    ctx.fillText(latestEv.text.slice(0, 52), 3, 19);
  }
  ctx.fillStyle = '#253142';
  ctx.fillRect(0, HUD_H - 1, TDECK_W, 1);

  // 2) Map viewport
  const vtx = Math.min(WORLD_W, ZOOM_LEVELS[state.settings.zoomIdx] ?? 40);
  const ppx = MAP_W / vtx;
  const vty = Math.min(WORLD_H, Math.max(1, Math.round(MAP_H / ppx)));
  const ppy = MAP_H / vty;

  if (state.settings.followMode && a && a.alive) {
    ui.camX = a.x - vtx / 2;
    ui.camY = a.y - vty / 2;
  }
  ui.camX = Math.max(0, Math.min(WORLD_W - vtx, ui.camX));
  ui.camY = Math.max(0, Math.min(WORLD_H - vty, ui.camY));

  const darkAmt = nightFactor(state.tick) * 0.48;
  const cx0 = Math.floor(ui.camX);
  const cy0 = Math.floor(ui.camY);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HUD_H, MAP_W, MAP_H);
  ctx.clip();

  for (let vy = 0; vy <= vty; vy++) {
    const wy = cy0 + vy;
    if (wy < 0 || wy >= WORLD_H) continue;
    const sy = HUD_H + Math.floor((wy - ui.camY) * ppy);
    const sh = Math.ceil((wy + 1 - ui.camY) * ppy) - Math.floor((wy - ui.camY) * ppy);
    for (let vx = 0; vx <= vtx; vx++) {
      const wx = cx0 + vx;
      if (wx < 0 || wx >= WORLD_W) continue;
      const sx = Math.floor((wx - ui.camX) * ppx);
      const sw = Math.ceil((wx + 1 - ui.camX) * ppx) - sx;
      const tile = state.tiles[idxOf(wx, wy)] as Tile;
      ctx.fillStyle = darkenHex(TILE_COLORS[tile], darkAmt);
      ctx.fillRect(sx, sy, sw, sh);
    }
  }

  // Fog of war
  if (state.settings.showFog && a && a.alive) {
    ctx.fillStyle = 'rgba(5,8,14,0.8)';
    for (let vy = 0; vy <= vty; vy++) {
      const wy = cy0 + vy;
      if (wy < 0 || wy >= WORLD_H) continue;
      const sy = HUD_H + Math.floor((wy - ui.camY) * ppy);
      const sh = Math.ceil(ppy) + 1;
      for (let vx = 0; vx <= vtx; vx++) {
        const wx = cx0 + vx;
        if (wx < 0 || wx >= WORLD_W) continue;
        if (!aiHasSeen(a, wx, wy)) {
          const sx = Math.floor((wx - ui.camX) * ppx);
          ctx.fillRect(sx, sy, Math.ceil(ppx) + 1, sh);
        }
      }
    }
  }

  const now = performance.now();
  const tickMs = SPEED_MS[state.settings.speedIdx] ?? 250;
  const aiPos = (ai: typeof a) => {
    const frac = tickMs > 0 ? Math.max(0, Math.min(1, (now - ai.moveStartMs) / tickMs)) : 1;
    const fx = ai.prevX + (ai.x - ai.prevX) * frac;
    const fy = ai.prevY + (ai.y - ai.prevY) * frac;
    return {
      cx: (fx - ui.camX + 0.5) * ppx,
      cy: HUD_H + (fy - ui.camY + 0.5) * ppy,
    };
  };

  // FOV cone & Hearing
  if (a && a.alive) {
    const p = aiPos(a);
    if (state.settings.showHearing) {
      ctx.strokeStyle = 'rgba(148,163,184,0.4)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.arc(p.cx, p.cy, a.hearing * ppx, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (state.settings.showFOV) {
      const dx = a.fov * ppx;
      const dy = a.fov * ppy;
      let x1 = p.cx;
      let y1 = p.cy;
      let x2 = p.cx;
      let y2 = p.cy;
      if (a.facing === 0) {
        x1 = p.cx - dx;
        y1 = p.cy - dy;
        x2 = p.cx + dx;
        y2 = p.cy - dy;
      } else if (a.facing === 1) {
        x1 = p.cx + dx;
        y1 = p.cy - dy;
        x2 = p.cx + dx;
        y2 = p.cy + dy;
      } else if (a.facing === 2) {
        x1 = p.cx - dx;
        y1 = p.cy + dy;
        x2 = p.cx + dx;
        y2 = p.cy + dy;
      } else {
        x1 = p.cx - dx;
        y1 = p.cy - dy;
        x2 = p.cx - dx;
        y2 = p.cy + dy;
      }
      ctx.strokeStyle = 'rgba(250,204,21,0.75)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(p.cx, p.cy);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.closePath();
      ctx.stroke();
    }
  }

  // Trust & Royal bonds
  if (state.settings.showBonds) {
    for (let i = 0; i < state.ais.length; i++) {
      const ai = state.ais[i];
      if (!ai.alive) continue;
      const p1 = aiPos(ai);
      if (ai.kingName) {
        const k = state.ais.find((o) => o.alive && o.name === ai.kingName);
        if (k) {
          const pk = aiPos(k);
          ctx.strokeStyle = 'rgba(250,204,21,0.75)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p1.cx, p1.cy);
          ctx.lineTo(pk.cx, pk.cy);
          ctx.stroke();
        }
      }
      for (let j = i + 1; j < state.ais.length; j++) {
        const aj = state.ais[j];
        if (!aj.alive) continue;
        if (getRelTrust(ai, aj.name) >= 40 && getRelTrust(aj, ai.name) >= 40) {
          const p2 = aiPos(aj);
          ctx.strokeStyle = 'rgba(74,222,128,0.5)';
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(p1.cx, p1.cy);
          ctx.lineTo(p2.cx, p2.cy);
          ctx.stroke();
        }
      }
    }
  }

  // AIs
  for (const ai of state.ais) {
    if (!ai.alive) continue;
    const { cx, cy } = aiPos(ai);
    const r = Math.max(2.2, Math.min(Math.min(ppx, ppy) * 0.55, ai.soul / 16 + 2));
    const sel = ai.id === ui.selectedAI;

    if (state.settings.showSound && ai.lastEmittedTick >= 0) {
      const age = state.tick - ai.lastEmittedTick;
      if (age >= 0 && age < 3) {
        ctx.strokeStyle = CONCEPT_COLORS[ai.lastEmittedConcept] ?? '#38bdf8';
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.arc(cx, cy, (age + 1) * Math.min(ppx, ppy), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    if (isMonster(ai.soul)) {
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 2.5 + ((state.tick / 4) % 2), 0, Math.PI * 2);
      ctx.stroke();
    }

    drawShape(ctx, cx, cy, r, ai.shape, ai.color, sel);

    if (ai.isKing) {
      ctx.fillStyle = '#facc15';
      ctx.fillRect(cx - 2.5, cy - r - 3.5, 5, 2);
    }

    if (ppx >= 6.5) {
      ctx.fillStyle = sel ? '#facc15' : '#f8fafc';
      ctx.font = 'bold 6.5px "IBM Plex Mono", monospace';
      ctx.fillText(ai.name[0], cx - 2, cy - r - 2);
    }
  }
  ctx.restore();

  // 3) Side Panel (AI info or Settings)
  if (ui.panelOpen) {
    const px = MAP_W + 1;
    ctx.fillStyle = '#090d14';
    ctx.fillRect(px, HUD_H, PAN_W, MAP_H);
    ctx.fillStyle = '#253142';
    ctx.fillRect(MAP_W, HUD_H, 1, MAP_H);

    if (ui.mode === 'settings') {
      ctx.fillStyle = '#22d3ee';
      ctx.font = 'bold 11px "IBM Plex Mono", monospace';
      ctx.fillText('Settings', px + 4, HUD_H + 14);
      const rows = [
        ['Zoom', `${ZOOM_LEVELS[state.settings.zoomIdx]}t`],
        ['Speed', SPEED_LABELS[state.settings.speedIdx]],
        ['Follow', state.settings.followMode ? 'ON' : 'OFF'],
        ['FOV', state.settings.showFOV ? 'ON' : 'OFF'],
        ['Fog', state.settings.showFog ? 'ON' : 'OFF'],
        ['Hearing', state.settings.showHearing ? 'ON' : 'OFF'],
        ['Sounds', state.settings.showSound ? 'ON' : 'OFF'],
        ['Bonds', state.settings.showBonds ? 'ON' : 'OFF'],
        ['Q-Learn', state.settings.learningEnabled ? 'ON' : 'OFF'],
        ['Language', state.settings.langEnabled ? 'ON' : 'OFF'],
        ['Social', state.settings.socialEnabled ? 'ON' : 'OFF'],
        ['Repro', state.settings.reproEnabled ? 'ON' : 'OFF'],
      ];
      rows.forEach(([lbl, val], i) => {
        const y = HUD_H + 28 + i * 14;
        const sel = i === ui.settingsIdx;
        if (sel) {
          ctx.fillStyle = '#1b2638';
          ctx.fillRect(px + 2, y - 9, PAN_W - 4, 12);
        }
        ctx.fillStyle = sel ? '#facc15' : '#cbd5e1';
        ctx.font = '7.5px "IBM Plex Mono", monospace';
        ctx.fillText(`${sel ? '>' : ' '}${lbl}`, px + 3, y);
        ctx.fillStyle = sel ? '#22d3ee' : '#94a3b8';
        ctx.fillText(`[${val}]`, px + PAN_W - 36, y);
      });
      ctx.fillStyle = '#64748b';
      ctx.font = '7px "IBM Plex Mono", monospace';
      ctx.fillText('W/S:nav A/D:set M:exit', px + 4, TDECK_H - 4);
    } else if (a) {
      let y = HUD_H + 15;
      ctx.fillStyle = a.alive ? '#22d3ee' : '#f43f5e';
      ctx.font = 'bold 14px "IBM Plex Mono", monospace';
      ctx.fillText(a.name, px + 5, y);
      if (a.alive) drawShape(ctx, px + PAN_W - 14, y - 5, 5, a.shape, a.color, false);
      y += 10;

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '7.5px "IBM Plex Mono", monospace';
      ctx.fillText(`S${a.soul} ${(a.age / DAY_TICKS).toFixed(1)}d ${getLifeStage(a.age).slice(0, 3)}`, px + 5, y);
      y += 10;
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`k${a.kills} h${a.helps} t${a.trades} f${a.foodEaten}`, px + 5, y);
      y += 10;
      ctx.fillStyle = a.isKing ? '#facc15' : a.kingName ? '#fbbf24' : '#64748b';
      ctx.fillText(
        a.isKing ? `KING (${a.followerCount} loy)` : a.kingName ? `loyal -> ${a.kingName}` : `carry:${CARRY_NAMES[a.carrying]}`,
        px + 5,
        y
      );
      y += 10;

      // Needs bars
      const bars = [
        ['hun', a.hunger, '#ef4444'],
        ['thi', a.thirst, '#38bdf8'],
        ['ene', a.energy, '#22c55e'],
      ] as const;
      bars.forEach(([lbl, val, col]) => {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(lbl, px + 5, y + 5);
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(px + 25, y, 74, 5);
        ctx.fillStyle = col;
        ctx.fillRect(px + 25, y, Math.round(val * 74), 5);
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(`${Math.round(val * 99)}`, px + 103, y + 5);
        y += 9;
      });
      y += 3;

      // Disposition + senses
      ctx.fillStyle = '#facc15';
      ctx.fillText(`a${a.aggression.toFixed(1)} c${a.curiosity.toFixed(1)} t${a.trust.toFixed(1)}`, px + 5, y);
      y += 9;
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`fov${a.fov} ear${a.hearing} SD:${a.sdRecordCount}r`, px + 5, y);
      y += 11;

      // Brain state
      const st = decodeQState(a.currentState);
      ctx.fillStyle = '#22d3ee';
      ctx.fillText(`S${a.currentState} ${st.need} F${st.foodKnown ? '+' : '-'}W${st.waterKnown ? '+' : '-'}`, px + 5, y);
      y += 9;
      ctx.fillStyle = a.wasRandom ? '#e879f9' : '#4ade80';
      ctx.fillText(`eps${a.epsilon.toFixed(2)} ${a.wasRandom ? 'RAND' : 'greedy'}`, px + 5, y);
      y += 11;

      // Top 3 Q
      if (a.currentState >= 0) {
        const qList = Array.from({ length: Q_ACTIONS }, (_, i) => ({
          i,
          v: a.qtable[a.currentState * Q_ACTIONS + i] / 10,
        }))
          .sort((u, v) => v.v - u.v)
          .slice(0, 3);
        qList.forEach((q) => {
          const picked = q.i === a.chosenAction;
          ctx.fillStyle = picked ? '#facc15' : '#94a3b8';
          ctx.fillText(
            `${picked ? '>' : ' '}${ACT_NAMES[q.i].padEnd(5)} ${q.v >= 0 ? '+' : ''}${q.v.toFixed(1)}`,
            px + 5,
            y
          );
          y += 9;
        });
      }
      y += 3;

      // Mouth & Action
      ctx.fillStyle = '#fb923c';
      ctx.fillText(`m:${Array.from(a.mouth).slice(0, 4).join('')}-${Array.from(a.mouth).slice(4).join('')}`, px + 5, y);
      y += 11;
      ctx.fillStyle = '#4ade80';
      ctx.font = 'bold 7.5px "IBM Plex Mono", monospace';
      ctx.fillText(`>${a.lastAction}`, px + 5, y);
      y += 9;
      ctx.fillStyle = '#94a3b8';
      ctx.font = '7px "IBM Plex Mono", monospace';
      ctx.fillText(a.lastReason.slice(0, 20), px + 5, y);

      const dirs = ['N', 'E', 'S', 'W'];
      ctx.fillStyle = '#64748b';
      ctx.fillText(`@${a.x},${a.y} f${dirs[a.facing]}`, px + 5, TDECK_H - 4);
    }
  }

  ctx.restore();
}
