import {
  AI,
  AI_PALETTE,
  CarryItem,
  CARRY_NAMES,
  Concept,
  CONCEPT_NAMES,
  DAY_TICKS,
  DEFAULT_SETTINGS,
  EventCategory,
  KingdomInfo,
  MAX_AI,
  MEMORIAL_MAX,
  MemoryEventType,
  MONSTER_THRESHOLD,
  N_CONCEPTS,
  N_SOUNDS,
  Q_ACTIONS,
  Q_STATES,
  Relationship,
  SOUL_POOL_MAX,
  Tile,
  WORLD_H,
  WORLD_W,
  WorldSettings,
  WorldState,
} from './types';
import { appendQuantizedMemory, queryMemoryAboutAI } from './memoryStore';

// Helpers
const randInt = (min: number, maxExclusive: number) =>
  min + Math.floor(Math.random() * (maxExclusive - min));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const sgn = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export function idxOf(x: number, y: number): number {
  return y * WORLD_W + x;
}

export function timeOfDay(tick: number): number {
  return tick % DAY_TICKS;
}

export function isNight(tick: number): boolean {
  const t = timeOfDay(tick);
  return t < 400 || t > 2000;
}

/** Smooth ambient darkness factor 0 (noon) .. 1 (midnight) for rendering */
export function nightFactor(tick: number): number {
  const t = timeOfDay(tick);
  if (t >= 520 && t <= 1880) return 0;
  if (t < 320 || t > 2080) return 1;
  if (t < 520) return 1 - (t - 320) / 200;
  return (t - 1880) / 200;
}

export function isMonster(soul: number): boolean {
  return soul >= MONSTER_THRESHOLD;
}

export function isPassable(t: Tile): boolean {
  return (
    t === Tile.GRASS ||
    t === Tile.SAND ||
    t === Tile.FOREST ||
    t === Tile.FOOD ||
    t === Tile.MEMORIAL ||
    t === Tile.PIT
  );
}

export function isSolid(t: Tile): boolean {
  return t === Tile.FOREST || t === Tile.STONE || t === Tile.BUILT;
}

export function hasLOS(tiles: Uint8Array, x1: number, y1: number, x2: number, y2: number): boolean {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1;
  const sy = y1 < y2 ? 1 : -1;
  let err = dx - dy;
  let x = x1;
  let y = y1;
  let safety = dx + dy + 2;
  while (safety-- > 0) {
    if (x === x2 && y === y2) return true;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
    if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return false;
    if ((x !== x2 || y !== y2) && isSolid(tiles[idxOf(x, y)] as Tile)) return false;
  }
  return false;
}

export function aiMarkSeen(a: AI, x: number, y: number): void {
  if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return;
  a.seen[y * (WORLD_W >> 3) + (x >> 3)] |= 1 << (x & 7);
}

export function aiHasSeen(a: AI, x: number, y: number): boolean {
  if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return false;
  return ((a.seen[y * (WORLD_W >> 3) + (x >> 3)] >> (x & 7)) & 1) === 1;
}

export function decodeQState(st: number): {
  need: string;
  threat: string;
  foodKnown: boolean;
  waterKnown: boolean;
} {
  let s = st < 0 ? 0 : st;
  const waterKnown = s >= 24;
  if (waterKnown) s -= 24;
  const foodKnown = s >= 12;
  if (foodKnown) s -= 12;
  const threatIdx = Math.floor(s / 4);
  const needIdx = s - threatIdx * 4;
  const needs = ['OK', 'FOOD', 'WATR', 'REST'];
  const threats = ['none', 'prey', 'ENMY'];
  return {
    need: needs[needIdx] ?? 'OK',
    threat: threats[threatIdx] ?? 'none',
    foodKnown,
    waterKnown,
  };
}

export function getLifeStage(age: number): 'infant' | 'young' | 'adult' | 'elder' {
  if (age < 200) return 'infant';
  if (age < 800) return 'young';
  if (age < 3000) return 'adult';
  return 'elder';
}

function pushWorkingMemory(
  ai: AI,
  tick: number,
  summary: string,
  category: 'action' | 'social' | 'memory' | 'unknown'
): void {
  ai.workingMemory.unshift({ tick, summary, category });
  if (ai.workingMemory.length > 50) {
    ai.workingMemory.length = 50;
  }
}

export function addWorldEvent(
  state: WorldState,
  color: string,
  category: EventCategory,
  text: string
): void {
  state.events.unshift({
    id: state.nextEventId++,
    tick: state.tick,
    text,
    color,
    category,
  });
  if (state.events.length > 160) {
    state.events.length = 160;
  }
}

function makeUniqueName(state: WorldState): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let tries = 0; tries < 500; tries++) {
    const candidate =
      letters[randInt(0, 26)] + letters[randInt(0, 26)] + letters[randInt(0, 26)];
    if (!state.usedNames.includes(candidate)) {
      state.usedNames.push(candidate);
      return candidate;
    }
  }
  // Fallback if somehow exhausted
  const fallback =
    letters[randInt(0, 26)] + letters[randInt(0, 26)] + String(randInt(0, 10));
  state.usedNames.push(fallback);
  return fallback;
}

export function generateTerrain(): { tiles: Uint8Array; cursedTiles: Uint8Array } {
  const tiles = new Uint8Array(WORLD_W * WORLD_H);
  const cursedTiles = new Uint8Array(WORLD_W * WORLD_H);
  tiles.fill(Tile.GRASS);

  // 8 lakes / ponds
  for (let i = 0; i < 8; i++) {
    const cx = randInt(4, WORLD_W - 4);
    const cy = randInt(4, WORLD_H - 4);
    const r = randInt(2, 5);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r && x >= 0 && x < WORLD_W && y >= 0 && y < WORLD_H) {
          tiles[idxOf(x, y)] = Tile.WATER;
        }
      }
    }
  }

  // 12 forests
  for (let i = 0; i < 12; i++) {
    const cx = randInt(2, WORLD_W - 2);
    const cy = randInt(2, WORLD_H - 2);
    const r = randInt(2, 6);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (
          dx * dx + dy * dy <= r * r &&
          x >= 0 &&
          x < WORLD_W &&
          y >= 0 &&
          y < WORLD_H &&
          tiles[idxOf(x, y)] === Tile.GRASS &&
          randInt(0, 100) < 70
        ) {
          tiles[idxOf(x, y)] = Tile.FOREST;
        }
      }
    }
  }

  // 6 stone outcrops
  for (let i = 0; i < 6; i++) {
    const cx = randInt(2, WORLD_W - 2);
    const cy = randInt(2, WORLD_H - 2);
    const r = randInt(1, 3);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (
          dx * dx + dy * dy <= r * r &&
          x >= 0 &&
          x < WORLD_W &&
          y >= 0 &&
          y < WORLD_H &&
          tiles[idxOf(x, y)] === Tile.GRASS
        ) {
          tiles[idxOf(x, y)] = Tile.STONE;
        }
      }
    }
  }

  // Sand beaches adjacent to water
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      if (tiles[idxOf(x, y)] !== Tile.GRASS) continue;
      let nearWater = false;
      for (let dy = -1; dy <= 1 && !nearWater; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (
            nx >= 0 &&
            nx < WORLD_W &&
            ny >= 0 &&
            ny < WORLD_H &&
            tiles[idxOf(nx, ny)] === Tile.WATER
          ) {
            nearWater = true;
            break;
          }
        }
      }
      if (nearWater) tiles[idxOf(x, y)] = Tile.SAND;
    }
  }

  // 40 initial berry patches
  for (let i = 0; i < 40; i++) {
    const x = randInt(0, WORLD_W);
    const y = randInt(0, WORLD_H);
    const t = tiles[idxOf(x, y)];
    if (t === Tile.GRASS || t === Tile.FOREST) {
      tiles[idxOf(x, y)] = Tile.FOOD;
    }
  }

  // 18 invisible cursed tiles (unpredictable hazards, never rendered on map)
  for (let i = 0; i < 18; i++) {
    const x = randInt(2, WORLD_W - 2);
    const y = randInt(2, WORLD_H - 2);
    if (isPassable(tiles[idxOf(x, y)] as Tile)) {
      cursedTiles[idxOf(x, y)] = 1;
    }
  }

  return { tiles, cursedTiles };
}

function aiPerceive(state: WorldState, a: AI): void {
  const depth = a.fov;
  aiMarkSeen(a, a.x, a.y);
  for (let d = 1; d <= depth; d++) {
    for (let w = -d; w <= d; w++) {
      let dx = 0;
      let dy = 0;
      switch (a.facing) {
        case 0:
          dx = w;
          dy = -d;
          break;
        case 1:
          dx = d;
          dy = w;
          break;
        case 2:
          dx = w;
          dy = d;
          break;
        case 3:
          dx = -d;
          dy = w;
          break;
      }
      const tx = a.x + dx;
      const ty = a.y + dy;
      if (hasLOS(state.tiles, a.x, a.y, tx, ty)) {
        aiMarkSeen(a, tx, ty);
      }
    }
  }
}

function getOrCreateRel(a: AI, otherName: string, tick: number): Relationship | null {
  const existing = a.relations.find((r) => r.name === otherName);
  if (existing) return existing;
  if (a.relations.length < 8) {
    const rel: Relationship = { name: otherName, trust: 0, loyalty: 0, lastTick: tick, trades: 0 };
    a.relations.push(rel);
    return rel;
  }
  // Replace oldest forgotten relationship if > 600 ticks stale
  let oldestIdx = 0;
  for (let i = 1; i < a.relations.length; i++) {
    if (a.relations[i].lastTick < a.relations[oldestIdx].lastTick) oldestIdx = i;
  }
  if (tick - a.relations[oldestIdx].lastTick > 600 && a.relations[oldestIdx].name !== a.kingName) {
    const rel: Relationship = { name: otherName, trust: 0, loyalty: 0, lastTick: tick, trades: 0 };
    a.relations[oldestIdx] = rel;
    return rel;
  }
  return null;
}

export function getRelTrust(a: AI, otherName: string): number {
  const r = a.relations.find((item) => item.name === otherName);
  return r ? r.trust : 0;
}

export function getRelLoyalty(a: AI, otherName: string): number {
  const r = a.relations.find((item) => item.name === otherName);
  return r ? r.loyalty : 0;
}

function updateRel(
  state: WorldState,
  a: AI,
  otherName: string,
  trustDelta: number,
  loyaltyDelta = 0
): void {
  if (!otherName || otherName === a.name) return;
  const rel = getOrCreateRel(a, otherName, state.tick);
  if (!rel) return;

  // Sticky loyalty: once loyalty > 55, negative shifts are dampened by 55%
  let effectiveLoyDelta = loyaltyDelta;
  if (loyaltyDelta < 0 && rel.loyalty >= 55) {
    effectiveLoyDelta = Math.round(loyaltyDelta * 0.45);
  }

  rel.trust = clamp(rel.trust + trustDelta, -100, 100);
  rel.loyalty = clamp(rel.loyalty + effectiveLoyDelta, 0, 100);
  rel.lastTick = state.tick;

  // Enter follower mode if loyalty exceeds threshold (55)
  if (state.settings.socialEnabled && rel.loyalty >= 55 && a.kingName !== otherName) {
    const currentKingLoy = a.kingName ? getRelLoyalty(a, a.kingName) : 0;
    if (!a.kingName || rel.loyalty > currentKingLoy + 12) {
      const prevKing = a.kingName;
      a.kingName = otherName;
      appendQuantizedMemory(
        a,
        state.tick,
        MemoryEventType.LOYALTY_SWORN,
        a.x,
        a.y,
        otherName,
        rel.loyalty,
        state.tiles[idxOf(a.x, a.y)] as Tile,
        effectiveLoyDelta,
        (isNight(state.tick) ? 1 : 0) | 2
      );
      pushWorkingMemory(a, state.tick, `Swore loyalty to ${otherName} (loy ${rel.loyalty})`, 'social');
      if (prevKing && prevKing !== otherName) {
        addWorldEvent(state, '#fbbf24', 'kingdom', `${a.name} defected from ${prevKing} to ${otherName}`);
      }
    }
  } else if (a.kingName === otherName && rel.loyalty < 30) {
    // Defection!
    a.kingName = '';
    appendQuantizedMemory(
      a,
      state.tick,
      MemoryEventType.DEFECTED,
      a.x,
      a.y,
      otherName,
      rel.loyalty,
      state.tiles[idxOf(a.x, a.y)] as Tile,
      effectiveLoyDelta,
      (isNight(state.tick) ? 1 : 0) | 2
    );
    pushWorkingMemory(a, state.tick, `Defected from ${otherName}`, 'social');
    addWorldEvent(state, '#f97316', 'kingdom', `${a.name} defected from ${otherName}'s court`);
  }
}

function aiHear(state: WorldState, listener: AI, speaker: AI, sound: number, concept: Concept): void {
  if (!listener.alive) return;
  listener.lastHeardSound = sound;
  listener.lastHeardConcept = concept;
  listener.lastHeardTick = state.tick;
  listener.lastHeardFrom = speaker.name;

  const idx = sound * N_CONCEPTS + concept;
  if (listener.ear[idx] < 100) {
    listener.ear[idx]++;
  }
  // Competitive decay for other concepts on this phoneme
  for (let c = 0; c < N_CONCEPTS; c++) {
    const cIdx = sound * N_CONCEPTS + c;
    if (c !== concept && listener.ear[cIdx] > 0 && randInt(0, 4) === 0) {
      listener.ear[cIdx]--;
    }
  }
  // Dialect convergence inside kingdoms: loyal followers gradually adopt king's phonemes
  if (listener.kingName === speaker.name && randInt(0, 6) === 0) {
    listener.mouth[concept] = speaker.mouth[concept];
  }
}

function aiEmit(state: WorldState, speaker: AI, concept: Concept): void {
  if (!state.settings.langEnabled) return;
  const sound = speaker.mouth[concept];
  speaker.lastEmittedSound = sound;
  speaker.lastEmittedConcept = concept;
  speaker.lastEmittedTick = state.tick;

  for (const l of state.ais) {
    if (!l.alive || l.id === speaker.id) continue;
    const dx = l.x - speaker.x;
    const dy = l.y - speaker.y;
    if (dx * dx + dy * dy <= l.hearing * l.hearing) {
      aiHear(state, l, speaker, sound, concept);
    }
  }
}

// Q-learning math
function qComputeState(
  hun: number,
  thi: number,
  ene: number,
  foodK: boolean,
  waterK: boolean,
  threat: number
): number {
  const eNeed = 1.0 - ene;
  const maxN = Math.max(hun, thi, eNeed);
  let need = 0;
  if (maxN < 0.4) need = 0;
  else if (hun === maxN) need = 1;
  else if (thi === maxN) need = 2;
  else need = 3;
  const st = need + threat * 4 + (foodK ? 12 : 0) + (waterK ? 24 : 0);
  return clamp(st, 0, Q_STATES - 1);
}

function qBestAction(a: AI, st: number): number {
  let best = 0;
  const base = st * Q_ACTIONS;
  for (let i = 1; i < Q_ACTIONS; i++) {
    if (a.qtable[base + i] > a.qtable[base + best]) best = i;
  }
  return best;
}

function qPickAction(a: AI, st: number): number {
  a.wasRandom = Math.random() < a.epsilon;
  if (a.wasRandom) return randInt(0, Q_ACTIONS);
  return qBestAction(a, st);
}

function qUpdate(
  a: AI,
  st: number,
  action: number,
  reward: number,
  newState: number,
  terminal: boolean
): void {
  const alpha = 0.15;
  const gamma = 0.9;
  const idx = st * Q_ACTIONS + action;
  const current = a.qtable[idx] / 10.0;
  let target: number;
  if (terminal) {
    target = reward;
  } else {
    const bestNext = qBestAction(a, newState);
    const maxNext = a.qtable[newState * Q_ACTIONS + bestNext] / 10.0;
    target = reward + gamma * maxNext;
  }
  const nv = current + alpha * (target - current);
  a.qtable[idx] = clamp(Math.round(nv * 10), -32000, 32000);
}

export function spawnAI(state: WorldState, slotIdx: number): AI {
  const name = makeUniqueName(state);
  let sx = randInt(2, WORLD_W - 2);
  let sy = randInt(2, WORLD_H - 2);
  for (let tries = 0; tries < 200; tries++) {
    const tx = randInt(2, WORLD_W - 2);
    const ty = randInt(2, WORLD_H - 2);
    const tile = state.tiles[idxOf(tx, ty)] as Tile;
    if (isPassable(tile) && tile !== Tile.MEMORIAL) {
      const occupied = state.ais.some(
        (other) => other && other.id !== slotIdx && other.alive && other.x === tx && other.y === ty
      );
      if (!occupied) {
        sx = tx;
        sy = ty;
        break;
      }
    }
  }

  const soul = 16;
  state.soulPool = Math.max(0, state.soulPool - soul);
  const aggression = Math.random();
  const curiosity = Math.random();
  const trust = Math.random();

  const qtable = new Int16Array(Q_STATES * Q_ACTIONS);
  const aggBias = Math.floor(aggression * 10);
  const trustBias = Math.floor(trust * 6);
  const curBias = Math.floor(curiosity * 5);
  for (let s = 0; s < Q_STATES; s++) {
    const base = s * Q_ACTIONS;
    qtable[base + 3] += aggBias; // hunt
    qtable[base + 4] += trustBias; // help
    qtable[base + 5] += curBias; // explore
    qtable[base + 12] += Math.floor(trust * 5); // trade
  }

  const mouth = new Uint8Array(N_CONCEPTS);
  for (let c = 0; c < N_CONCEPTS; c++) mouth[c] = randInt(0, N_SOUNDS);

  const ai: AI = {
    id: slotIdx,
    alive: true,
    name,
    x: sx,
    y: sy,
    prevX: sx,
    prevY: sy,
    moveStartMs: performance.now(),
    facing: randInt(0, 4) as 0 | 1 | 2 | 3,
    soul,
    age: 0,
    birthTick: state.tick,
    shape: randInt(0, 8),
    color: AI_PALETTE[randInt(0, AI_PALETTE.length)],
    hunger: 0.3 + Math.random() * 0.2,
    thirst: 0.2 + Math.random() * 0.2,
    energy: 0.8 + Math.random() * 0.2,
    aggression,
    curiosity,
    trust,
    hearing: 3 + randInt(0, 6),
    fov: 2 + Math.floor(soul / 32),
    kills: 0,
    helps: 0,
    trades: 0,
    foodEaten: 0,
    recalls: 0,
    lastAction: 'born',
    lastReason: 'awakened from pool',
    seen: new Uint8Array(WORLD_H * (WORLD_W >> 3)),
    qtable,
    prevState: -1,
    prevAction: -1,
    prevHunger: 0.3,
    prevThirst: 0.2,
    prevEnergy: 0.8,
    prevSoul: soul,
    currentState: -1,
    chosenAction: -1,
    wasRandom: false,
    epsilon: 0.5,
    workingMemory: [],
    sdMemory: new Uint8Array(256),
    sdRecordCount: 0,
    lastRecallText: '',
    lastRecallTick: -9999,
    mouth,
    ear: new Int8Array(N_SOUNDS * N_CONCEPTS),
    lastEmittedSound: -1,
    lastEmittedConcept: -1,
    lastEmittedTick: -9999,
    lastHeardSound: -1,
    lastHeardConcept: -1,
    lastHeardTick: -9999,
    lastHeardFrom: '',
    relations: [],
    kingName: '',
    followerCount: 0,
    isKing: false,
    superstitions: [],
    parent1: '',
    parent2: '',
    lastReproTick: -9999,
    numChildren: 0,
    carrying: CarryItem.NONE,
    trapTick: 0,
    lastAttacker: '',
    lastAttackedTick: -9999,
  };

  appendQuantizedMemory(
    ai,
    state.tick,
    MemoryEventType.BIRTH,
    sx,
    sy,
    '',
    soul,
    state.tiles[idxOf(sx, sy)] as Tile,
    0,
    isNight(state.tick) ? 1 : 0
  );
  pushWorkingMemory(ai, state.tick, `Spawned at (${sx},${sy})`, 'action');
  aiPerceive(state, ai);
  state.ais[slotIdx] = ai;
  return ai;
}

export function createInitialWorld(settings: WorldSettings = DEFAULT_SETTINGS): WorldState {
  const { tiles, cursedTiles } = generateTerrain();
  const state: WorldState = {
    tick: 0,
    soulPool: SOUL_POOL_MAX,
    tiles,
    cursedTiles,
    ais: [],
    memorials: [],
    events: [],
    nextEventId: 1,
    usedNames: [],
    totalDeaths: 0,
    totalTrades: 0,
    totalBirths: 0,
    settings: { ...settings },
  };

  for (let i = 0; i < MAX_AI; i++) {
    if (i < state.settings.paramPopulationCap) {
      spawnAI(state, i);
    } else {
      const dead = spawnAI(state, i);
      state.soulPool += dead.soul;
      dead.alive = false;
    }
  }
  addWorldEvent(
    state,
    '#22d3ee',
    'system',
    `Continent seeded with ${state.settings.paramPopulationCap} autonomous minds`
  );
  return state;
}

function handleKingDeathSuccession(state: WorldState, deadKing: AI): void {
  const followers = state.ais.filter((other) => other.alive && other.kingName === deadKing.name);
  if (followers.length === 0) return;

  // Strongest follower may inherit the court, otherwise kingdom fractures
  followers.sort((a, b) => b.soul - a.soul);
  const heir = followers[0];
  if (followers.length >= 2 && heir.soul >= 28 && Math.random() < 0.65) {
    heir.kingName = '';
    for (const f of followers) {
      if (f.id === heir.id) continue;
      f.kingName = heir.name;
      updateRel(state, f, heir.name, +10, +58);
    }
    addWorldEvent(
      state,
      '#fbbf24',
      'kingdom',
      `Succession: ${heir.name} inherited ${deadKing.name}'s court (${followers.length - 1} loyal)`
    );
  } else {
    for (const f of followers) {
      f.kingName = '';
      pushWorkingMemory(f, state.tick, `Court of ${deadKing.name} fractured`, 'social');
    }
    addWorldEvent(state, '#f97316', 'kingdom', `${deadKing.name}'s kingdom fractured on death`);
  }
}

export function killAI(state: WorldState, a: AI, cause: string): void {
  if (!a.alive) return;
  const famous = a.soul > 48 || a.kills >= 2 || a.age > 1500 || a.helps >= 3 || a.isKing;
  const witness = state.ais.some((other) => {
    if (!other.alive || other.id === a.id) return false;
    const dx = other.x - a.x;
    const dy = other.y - a.y;
    return dx * dx + dy * dy <= other.hearing * other.hearing;
  });

  if (famous && witness && randInt(0, 100) < 65) {
    const t = state.tiles[idxOf(a.x, a.y)] as Tile;
    if (t === Tile.GRASS || t === Tile.SAND || t === Tile.FOREST) {
      state.tiles[idxOf(a.x, a.y)] = Tile.MEMORIAL;
      const qState = randInt(0, Q_STATES);
      const qRow: number[] = [];
      for (let act = 0; act < Q_ACTIONS; act++) {
        qRow.push(a.qtable[qState * Q_ACTIONS + act]);
      }
      const memorial = {
        used: true,
        x: a.x,
        y: a.y,
        qState,
        qRow,
        mouth: Array.from(a.mouth),
        fromName: a.name,
        birthTick: state.tick,
        legacySoul: Math.max(a.soul, a.prevSoul),
        legacyKills: a.kills,
        wasKing: a.isKing,
      };
      if (state.memorials.length < MEMORIAL_MAX) {
        state.memorials.push(memorial);
      } else {
        state.memorials[randInt(0, MEMORIAL_MAX)] = memorial;
      }
      addWorldEvent(
        state,
        '#facc15',
        'memorial',
        `Memorial raised for ${a.name} at (${a.x},${a.y})`
      );
    }
  }

  if (a.isKing) {
    handleKingDeathSuccession(state, a);
  }

  if (famous || cause === 'heart-attack' || cause === 'user') {
    const reasonText =
      cause === 'heart-attack'
        ? '??? sudden collapse'
        : cause === 'user'
        ? 'observer cull'
        : `age ${(a.age / DAY_TICKS).toFixed(1)}d · k${a.kills}`;
    addWorldEvent(
      state,
      cause === 'heart-attack' ? '#c084fc' : '#f87171',
      cause === 'heart-attack' ? 'unknown' : 'death',
      `${a.name} died (${reasonText})`
    );
  }

  state.soulPool += Math.max(0, a.soul);
  state.totalDeaths++;
  a.alive = false;
  a.isKing = false;
  a.followerCount = 0;
}

function isSuperstitiousTile(a: AI, x: number, y: number): boolean {
  for (const z of a.superstitions) {
    if (z.kind !== 'taboo') continue;
    const dx = z.x - x;
    const dy = z.y - y;
    if (dx * dx + dy * dy <= 2) return true;
  }
  return false;
}

function addSuperstition(a: AI, x: number, y: number, tick: number, kind: 'taboo' | 'shrine'): void {
  const existing = a.superstitions.find((z) => Math.abs(z.x - x) <= 1 && Math.abs(z.y - y) <= 1);
  if (existing) {
    existing.strength = Math.min(5, existing.strength + 1);
    existing.tick = tick;
    existing.kind = kind;
    return;
  }
  a.superstitions.push({ x, y, tick, strength: 1, kind });
  if (a.superstitions.length > 6) {
    a.superstitions.shift();
  }
}

function aiTryMoveImpl(
  state: WorldState,
  a: AI,
  dx: number,
  dy: number,
  canEscapePit: boolean
): boolean {
  if (dx === 0 && dy === 0) return false;
  if (!canEscapePit && state.tiles[idxOf(a.x, a.y)] === Tile.PIT) {
    if (a.trapTick === 0) a.trapTick = state.tick;
    return false;
  }
  const nx = a.x + dx;
  const ny = a.y + dy;
  if (nx < 0 || nx >= WORLD_W || ny < 0 || ny >= WORLD_H) return false;
  if (!isPassable(state.tiles[idxOf(nx, ny)] as Tile)) return false;

  // Superstitious avoidance (80% chance to refuse stepping onto a taboo tile unless starving)
  if (isSuperstitiousTile(a, nx, ny) && a.hunger < 0.85 && Math.random() < 0.8) {
    a.lastAction = 'avoid';
    a.lastReason = `superstition (${nx},${ny})`;
    return false;
  }

  for (const other of state.ais) {
    if (other.alive && other.id !== a.id && other.x === nx && other.y === ny) return false;
  }

  a.prevX = a.x;
  a.prevY = a.y;
  a.moveStartMs = performance.now();
  a.x = nx;
  a.y = ny;

  const landedTile = state.tiles[idxOf(nx, ny)] as Tile;
  a.trapTick = landedTile === Tile.PIT ? state.tick : 0;

  if (Math.abs(dx) > Math.abs(dy)) a.facing = dx > 0 ? 1 : 3;
  else a.facing = dy > 0 ? 2 : 0;

  // Invisible cursed tile check!
  if (state.cursedTiles[idxOf(nx, ny)] === 1 && randInt(0, 100) < 35) {
    const dmg = 2 + randInt(0, 5);
    a.soul -= dmg;
    state.soulPool += dmg;
    a.lastAction = 'hurt';
    a.lastReason = '??? unknown';
    addSuperstition(a, nx, ny, state.tick, 'taboo');
    appendQuantizedMemory(
      a,
      state.tick,
      MemoryEventType.UNKNOWN_HURT,
      nx,
      ny,
      '',
      -dmg,
      landedTile,
      0,
      (isNight(state.tick) ? 1 : 0) | 4
    );
    pushWorkingMemory(a, state.tick, `??? unexplained pain (-${dmg}) at (${nx},${ny})`, 'unknown');
    aiEmit(state, a, Concept.PAIN);
    addWorldEvent(state, '#c084fc', 'unknown', `${a.name} suffered ??? unknown event`);
  }

  // Eating berries
  if (landedTile === Tile.FOOD) {
    state.tiles[idxOf(nx, ny)] = Tile.GRASS;
    a.hunger = Math.max(0, a.hunger - 0.6);
    a.soul += 2;
    a.foodEaten++;
    state.soulPool = Math.max(0, state.soulPool - 2);
    a.lastAction = 'ate berry';
    a.lastReason = `hunger ${a.hunger.toFixed(2)}`;
    aiEmit(state, a, Concept.FOOD);
    if (a.carrying === CarryItem.NONE) a.carrying = CarryItem.BERRY;
  }

  // Reading a memorial
  if (landedTile === Tile.MEMORIAL) {
    const m = state.memorials.find((item) => item.used && item.x === nx && item.y === ny);
    if (m) {
      for (let act = 0; act < Q_ACTIONS; act++) {
        const idx = m.qState * Q_ACTIONS + act;
        a.qtable[idx] = Math.round((a.qtable[idx] + m.qRow[act]) / 2);
      }
      for (let c = 0; c < N_CONCEPTS; c++) {
        if (randInt(0, 3) === 0) a.mouth[c] = m.mouth[c];
      }
      a.soul += 3;
      a.lastAction = 'learned';
      a.lastReason = `memorial of ${m.fromName}`;
      appendQuantizedMemory(
        a,
        state.tick,
        MemoryEventType.MEMORIAL_READ,
        nx,
        ny,
        m.fromName,
        3,
        Tile.MEMORIAL,
        0,
        isNight(state.tick) ? 1 : 0
      );
      pushWorkingMemory(a, state.tick, `Inherited memory from ${m.fromName}`, 'memory');
      addWorldEvent(state, '#facc15', 'memorial', `${a.name} read ${m.fromName}'s memorial`);
    }
  }

  return true;
}

function aiTryMove(state: WorldState, a: AI, dx: number, dy: number): boolean {
  return aiTryMoveImpl(state, a, dx, dy, false);
}

function aiTryJump(state: WorldState, a: AI, dx: number, dy: number): boolean {
  return aiTryMoveImpl(state, a, dx, dy, true);
}

function aiNearest(state: WorldState, a: AI, r: number, weakerOnly = false): AI | null {
  let best: AI | null = null;
  let bestD = r * r + 1;
  for (const other of state.ais) {
    if (!other.alive || other.id === a.id) continue;
    const dx = other.x - a.x;
    const dy = other.y - a.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r * r) continue;
    if (weakerOnly && other.soul >= a.soul) continue;
    if (!hasLOS(state.tiles, a.x, a.y, other.x, other.y)) continue;
    if (d2 < bestD) {
      bestD = d2;
      best = other;
    }
  }
  return best;
}

function aiFindRememberedTile(
  state: WorldState,
  a: AI,
  wanted: Tile,
  maxR = 20
): { x: number; y: number } | null {
  let bd = maxR * maxR + 1;
  let best: { x: number; y: number } | null = null;
  const y0 = Math.max(0, a.y - maxR);
  const y1 = Math.min(WORLD_H - 1, a.y + maxR);
  const x0 = Math.max(0, a.x - maxR);
  const x1 = Math.min(WORLD_W - 1, a.x + maxR);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!aiHasSeen(a, x, y)) continue;
      if (state.tiles[idxOf(x, y)] !== wanted) continue;
      const dx = x - a.x;
      const dy = y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd) {
        bd = d2;
        best = { x, y };
      }
    }
  }
  return best;
}

function aiStepToward(state: WorldState, a: AI, tx: number, ty: number): void {
  const dx = sgn(tx - a.x);
  const dy = sgn(ty - a.y);
  if (!aiTryMove(state, a, dx, dy)) {
    if (Math.abs(tx - a.x) >= Math.abs(ty - a.y)) {
      if (!aiTryMove(state, a, dx, 0)) aiTryMove(state, a, 0, dy);
    } else {
      if (!aiTryMove(state, a, 0, dy)) aiTryMove(state, a, dx, 0);
    }
  }
}

function aiAttack(state: WorldState, a: AI, other: AI): void {
  // Followers will not attack their own king
  if (a.kingName === other.name && getRelLoyalty(a, other.name) >= 40) {
    a.lastAction = 'deferred';
    a.lastReason = `loyal to ${other.name}`;
    return;
  }

  const damage = Math.max(1, Math.floor(a.soul / 8) + Math.floor(a.aggression * 4));
  const selfdmg = Math.max(1, Math.floor(other.soul / 10));
  other.soul -= damage;
  a.soul -= selfdmg;
  state.soulPool += damage + selfdmg;

  other.lastAttacker = a.name;
  other.lastAttackedTick = state.tick;

  updateRel(state, other, a.name, -30, -35);
  updateRel(state, a, other.name, -10, -10);

  // Protection bonus: if `other` was attacking a third AI `victim`, `victim` gains huge loyalty to `a`!
  if (state.settings.socialEnabled) {
    for (const witness of state.ais) {
      if (!witness.alive || witness.id === a.id || witness.id === other.id) continue;
      const d2 = (witness.x - a.x) ** 2 + (witness.y - a.y) ** 2;
      if (d2 > witness.fov * witness.fov + 9) continue;

      if (witness.lastAttacker === other.name && state.tick - witness.lastAttackedTick < 40) {
        updateRel(state, witness, a.name, +24, +28);
        appendQuantizedMemory(
          witness,
          state.tick,
          MemoryEventType.PROTECTED,
          a.x,
          a.y,
          a.name,
          28,
          state.tiles[idxOf(witness.x, witness.y)] as Tile,
          28,
          isNight(state.tick) ? 1 : 0
        );
      }

      // Visible defeat of a king crashes follower loyalty!
      if (other.isKing && damage >= other.soul * 0.35) {
        if (witness.kingName === other.name) {
          // Bypass sticky loyalty dampening on public humiliation
          const rel = witness.relations.find((r) => r.name === other.name);
          if (rel) rel.loyalty = Math.max(0, rel.loyalty - 35);
          updateRel(state, witness, other.name, -12, -20);
          appendQuantizedMemory(
            witness,
            state.tick,
            MemoryEventType.KING_DEFEAT,
            other.x,
            other.y,
            other.name,
            -35,
            state.tiles[idxOf(other.x, other.y)] as Tile,
            -35,
            (isNight(state.tick) ? 1 : 0) | 2
          );
        }
        // Witnesses develop fear/respect for victor
        if (a.soul > witness.soul * 1.1) {
          updateRel(state, witness, a.name, +2, +14);
        }
      }
    }
  }

  appendQuantizedMemory(
    a,
    state.tick,
    MemoryEventType.ATTACKED,
    other.x,
    other.y,
    other.name,
    damage,
    state.tiles[idxOf(other.x, other.y)] as Tile,
    -10,
    isNight(state.tick) ? 1 : 0
  );
  appendQuantizedMemory(
    other,
    state.tick,
    MemoryEventType.ATTACKED,
    a.x,
    a.y,
    a.name,
    -damage,
    state.tiles[idxOf(other.x, other.y)] as Tile,
    -35,
    isNight(state.tick) ? 1 : 0
  );

  aiEmit(state, a, Concept.ENEMY);
  aiEmit(state, other, Concept.PAIN);

  if (other.soul <= 0) {
    const gain = Math.max(4, damage);
    const crossMonster = !isMonster(a.soul) && isMonster(a.soul + gain);
    a.soul += gain;
    state.soulPool = Math.max(0, state.soulPool - gain);
    a.kills++;
    a.lastAction = 'killed';
    a.lastReason = `${other.name} +${gain}`;
    appendQuantizedMemory(
      a,
      state.tick,
      MemoryEventType.KILLED,
      other.x,
      other.y,
      other.name,
      gain,
      state.tiles[idxOf(other.x, other.y)] as Tile,
      0,
      isNight(state.tick) ? 1 : 0
    );
    pushWorkingMemory(a, state.tick, `Killed ${other.name} (+${gain} soul)`, 'social');
    aiEmit(state, a, Concept.KILL);
    addWorldEvent(state, '#ef4444', 'combat', `${a.name} killed ${other.name}`);
    if (crossMonster) {
      addWorldEvent(state, '#e879f9', 'combat', `${a.name} crossed monster threshold (${a.soul} soul)`);
    }
    killAI(state, other, 'killed');
  } else {
    a.lastAction = 'attack';
    a.lastReason = `${other.name} dmg ${damage}`;
    pushWorkingMemory(a, state.tick, `Attacked ${other.name} for ${damage}`, 'social');
  }
}

function aiAttemptTrade(state: WorldState, a: AI, partner: AI): boolean {
  if (!state.settings.socialEnabled) return false;
  const dist = Math.abs(partner.x - a.x) + Math.abs(partner.y - a.y);
  if (dist > 2) return false;

  // Query quantized SD memory before trusting a trade partner!
  const mem = queryMemoryAboutAI(a, partner.name);
  if (mem.encounters > 0) {
    a.recalls++;
    a.lastRecallTick = state.tick;
    a.lastRecallText = `recalled ${partner.name}: ${mem.encounters} events (net ${mem.netSentiment >= 0 ? '+' : ''}${mem.netSentiment})`;
    if (mem.netSentiment < -4 && Math.random() < 0.75) {
      a.lastAction = 'refused trade';
      a.lastReason = `remembers ${partner.name}`;
      pushWorkingMemory(a, state.tick, `Refused ${partner.name} from deep memory`, 'memory');
      return false;
    }
  }

  // Trade scenarios:
  // 1) Item swap (wood/stone/berry)
  // 2) Material for food/soul
  // 3) Map knowledge swap (merge seen bitmaps!)
  let tradeDesc = '';
  if (a.carrying !== CarryItem.NONE && partner.carrying !== CarryItem.NONE && a.carrying !== partner.carrying) {
    const tmp = a.carrying;
    a.carrying = partner.carrying;
    partner.carrying = tmp;
    tradeDesc = `${CARRY_NAMES[partner.carrying]}↔${CARRY_NAMES[a.carrying]}`;
  } else if (a.carrying === CarryItem.BERRY && partner.hunger > 0.45) {
    a.carrying = CarryItem.NONE;
    partner.hunger = Math.max(0, partner.hunger - 0.35);
    const fee = Math.min(3, Math.max(1, Math.floor(partner.soul * 0.08)));
    partner.soul -= fee;
    a.soul += fee;
    tradeDesc = `berry for ${fee} soul`;
  } else if ((a.carrying === CarryItem.WOOD || a.carrying === CarryItem.STONE) && partner.soul > 20) {
    const mat = CARRY_NAMES[a.carrying];
    if (partner.carrying === CarryItem.NONE) {
      partner.carrying = a.carrying;
      a.carrying = CarryItem.NONE;
    }
    a.hunger = Math.max(0, a.hunger - 0.15);
    a.soul += 2;
    partner.soul = Math.max(10, partner.soul - 1);
    tradeDesc = `${mat} for rations`;
  } else {
    // Information trade: exchange explored map chunks
    let sharedBytes = 0;
    for (let i = 0; i < a.seen.length; i += 4) {
      const merged = a.seen[i] | partner.seen[i];
      if (merged !== a.seen[i] || merged !== partner.seen[i]) sharedBytes++;
      a.seen[i] = merged;
      partner.seen[i] = merged;
    }
    if (sharedBytes === 0) return false;
    a.soul += 1;
    partner.soul += 1;
    tradeDesc = 'map intel';
  }

  a.trades++;
  partner.trades++;
  state.totalTrades++;
  updateRel(state, a, partner.name, +14, +6);
  updateRel(state, partner, a.name, +14, +6);
  const relA = a.relations.find((r) => r.name === partner.name);
  if (relA) relA.trades++;
  const relB = partner.relations.find((r) => r.name === a.name);
  if (relB) relB.trades++;

  const tile = state.tiles[idxOf(a.x, a.y)] as Tile;
  appendQuantizedMemory(a, state.tick, MemoryEventType.TRADE, a.x, a.y, partner.name, +2, tile, +6, isNight(state.tick) ? 1 : 0);
  appendQuantizedMemory(partner, state.tick, MemoryEventType.TRADE, partner.x, partner.y, a.name, +2, tile, +6, isNight(state.tick) ? 1 : 0);

  a.lastAction = 'traded';
  a.lastReason = `${partner.name}: ${tradeDesc}`;
  pushWorkingMemory(a, state.tick, `Traded ${tradeDesc} with ${partner.name}`, 'social');
  pushWorkingMemory(partner, state.tick, `Traded ${tradeDesc} with ${a.name}`, 'social');
  aiEmit(state, a, Concept.FRIEND);
  addWorldEvent(state, '#34d399', 'trade', `${a.name} ↔ ${partner.name} traded (${tradeDesc})`);
  return true;
}

function aiTick(state: WorldState, a: AI): void {
  if (!a.alive) return;
  a.age++;
  a.fov = clamp(2 + Math.floor(a.soul / 32), 2, 10);

  // Natural decay
  a.hunger = Math.min(1.0, a.hunger + 0.0008);
  a.thirst = Math.min(1.0, a.thirst + 0.001);
  if (isNight(state.tick)) a.energy = Math.max(0.0, a.energy - 0.0006);
  else a.energy = Math.min(1.0, a.energy + 0.0003);

  if (a.age % 50 === 0 && a.soul > 16) {
    a.soul--;
    state.soulPool++;
  }
  if (a.hunger > 0.95 && a.age % 30 === 0) {
    a.soul--;
    state.soulPool++;
  }
  if (a.thirst > 0.95 && a.age % 20 === 0) {
    a.soul--;
    state.soulPool++;
  }

  // Unpredictable random punishment / boon / rare sudden heart attack
  const hurtRate = state.settings.paramRandomHurtRate;
  if (hurtRate > 0) {
    const roll = randInt(0, 20000);
    if (roll < hurtRate) {
      const dmg = 2 + randInt(0, 6);
      a.soul -= dmg;
      state.soulPool += dmg;
      a.lastAction = 'hurt';
      a.lastReason = '??? unknown';
      addSuperstition(a, a.x, a.y, state.tick, 'taboo');
      appendQuantizedMemory(
        a,
        state.tick,
        MemoryEventType.UNKNOWN_HURT,
        a.x,
        a.y,
        '',
        -dmg,
        state.tiles[idxOf(a.x, a.y)] as Tile,
        0,
        (isNight(state.tick) ? 1 : 0) | 4
      );
      pushWorkingMemory(a, state.tick, `??? unknown pulse (-${dmg} soul)`, 'unknown');
      aiEmit(state, a, Concept.PAIN);
      addWorldEvent(state, '#c084fc', 'unknown', `${a.name}: ??? unknown damage (-${dmg})`);
    } else if (roll === 19999) {
      // Ultra-rare random mysterious soul bonus
      const boon = 4 + randInt(0, 7);
      a.soul += boon;
      addSuperstition(a, a.x, a.y, state.tick, 'shrine');
      appendQuantizedMemory(
        a,
        state.tick,
        MemoryEventType.UNKNOWN_BLESS,
        a.x,
        a.y,
        '',
        boon,
        state.tiles[idxOf(a.x, a.y)] as Tile,
        0,
        (isNight(state.tick) ? 1 : 0) | 4
      );
      pushWorkingMemory(a, state.tick, `??? unexplained boon (+${boon} soul)`, 'unknown');
      addWorldEvent(state, '#38bdf8', 'unknown', `${a.name}: ??? mysterious boon (+${boon})`);
    } else if (roll === 19998 && a.age > 900 && randInt(0, 12) === 0) {
      // Very rare random sudden death ("heart attack")
      a.soul = 0;
      killAI(state, a, 'heart-attack');
      return;
    }
  }

  // Death check with terminal Q-update
  if (a.soul <= 0) {
    if (state.settings.learningEnabled && a.prevState >= 0 && a.prevAction >= 0) {
      qUpdate(a, a.prevState, a.prevAction, -20.0, 0, true);
    }
    killAI(state, a, 'soul0');
    return;
  }

  aiPerceive(state, a);

  // Proximity trust, fear-loyalty, social proof & memory recall every 10 ticks
  if (a.age % 10 === 0) {
    for (const other of state.ais) {
      if (!other.alive || other.id === a.id) continue;
      const dx = other.x - a.x;
      const dy = other.y - a.y;
      if (dx * dx + dy * dy <= a.fov * a.fov) {
        // Peaceful proximity raises trust + gentle loyalty
        let loyBump = state.settings.socialEnabled ? 1 : 0;
        // Fear reinforcement when neighbor is much stronger
        if (state.settings.socialEnabled && other.soul > a.soul * 1.45) {
          loyBump += 3;
        }
        // Social proof: if other AIs I trust defer to `other`, my loyalty rises fast
        if (state.settings.socialEnabled && other.followerCount >= 1) {
          const trustedFollows = state.ais.some(
            (third) =>
              third.alive &&
              third.kingName === other.name &&
              getRelTrust(a, third.name) >= 15
          );
          if (trustedFollows) loyBump += 6;
          else if (other.followerCount >= 2) loyBump += 3;
        }

        const wasKnown = a.relations.some((r) => r.name === other.name);
        updateRel(state, a, other.name, +1, loyBump);
        if (!wasKnown) {
          appendQuantizedMemory(
            a,
            state.tick,
            MemoryEventType.MET,
            other.x,
            other.y,
            other.name,
            other.soul,
            state.tiles[idxOf(other.x, other.y)] as Tile,
            loyBump,
            isNight(state.tick) ? 1 : 0
          );
        }

        // Occasional deep SD recall when encountering a familiar AI
        if (wasKnown && randInt(0, 12) === 0) {
          const mem = queryMemoryAboutAI(a, other.name);
          if (mem.encounters > 0) {
            a.recalls++;
            a.lastRecallTick = state.tick;
            a.lastRecallText = `met ${other.name} (${mem.encounters} records, net ${mem.netSentiment >= 0 ? '+' : ''}${mem.netSentiment})`;
          }
        }
      }
    }
  }

  // Observe environment
  const enemy = aiNearest(state, a, a.fov, false);
  const prey = aiNearest(state, a, a.fov, true);
  const foodLoc = aiFindRememberedTile(state, a, Tile.FOOD, a.fov + 10);
  const waterLoc = aiFindRememberedTile(state, a, Tile.WATER, a.fov + 10);
  let threat = 0;
  if (enemy && enemy.soul > a.soul * 1.3 && enemy.name !== a.kingName) threat = 2;
  else if (prey && prey.name !== a.kingName) threat = 1;

  const qState = qComputeState(a.hunger, a.thirst, a.energy, !!foodLoc, !!waterLoc, threat);
  a.currentState = qState;

  // Age-stage epsilon
  if (a.age < 200) a.epsilon = 0.5;
  else if (a.age < 600) a.epsilon = 0.25;
  else if (a.age < 1500) a.epsilon = 0.1;
  else a.epsilon = 0.05;

  // TD Q-update for previous step
  if (state.settings.learningEnabled && a.prevState >= 0 && a.prevAction >= 0) {
    let r = 0.1;
    r += (a.prevHunger - a.hunger) * 4.0;
    r += (a.prevThirst - a.thirst) * 4.0;
    r += (a.energy - a.prevEnergy) * 1.5;
    r += (a.soul - a.prevSoul) * 1.2;
    switch (a.prevAction) {
      case 3:
        r += a.aggression * 1.0;
        break;
      case 4:
        r += a.trust * 0.8;
        break;
      case 5:
        r += a.curiosity * 0.4;
        break;
      case 12:
        r += a.trust * 0.9;
        break;
    }
    qUpdate(a, a.prevState, a.prevAction, r, qState, false);
  }

  // Follower override: defend king if king was just attacked nearby!
  let action = state.settings.learningEnabled ? qPickAction(a, qState) : qBestAction(a, qState);
  const myKing = a.kingName
    ? state.ais.find((k) => k.alive && k.name === a.kingName) ?? null
    : null;
  if (myKing && state.settings.socialEnabled) {
    const kingAttacker =
      myKing.lastAttacker && state.tick - myKing.lastAttackedTick < 25
        ? state.ais.find((at) => at.alive && at.name === myKing.lastAttacker)
        : null;
    if (kingAttacker && (kingAttacker.x - a.x) ** 2 + (kingAttacker.y - a.y) ** 2 <= (a.fov + 4) ** 2) {
      // Rush to defend the king!
      const dxy = Math.abs(kingAttacker.x - a.x) + Math.abs(kingAttacker.y - a.y);
      if (dxy <= 1) {
        aiAttack(state, a, kingAttacker);
      } else {
        aiStepToward(state, a, kingAttacker.x, kingAttacker.y);
        a.lastAction = 'defend king';
        a.lastReason = `for ${myKing.name} vs ${kingAttacker.name}`;
      }
      a.chosenAction = 3;
      a.prevState = qState;
      a.prevAction = 3;
      a.prevHunger = a.hunger;
      a.prevThirst = a.thirst;
      a.prevEnergy = a.energy;
      a.prevSoul = a.soul;
      return;
    }
    // If king emitted a recent call and needs aren't critical, bias toward defer/follow
    if (
      state.tick - myKing.lastEmittedTick < 12 &&
      a.hunger < 0.75 &&
      a.thirst < 0.75 &&
      Math.random() < 0.55
    ) {
      action = 13; // defer / rally
    }
  }

  a.chosenAction = action;
  a.prevState = qState;
  a.prevAction = action;
  a.prevHunger = a.hunger;
  a.prevThirst = a.thirst;
  a.prevEnergy = a.energy;
  a.prevSoul = a.soul;

  // Execute action
  switch (action) {
    case 0: // seek food
      if (foodLoc) {
        aiStepToward(state, a, foodLoc.x, foodLoc.y);
        a.lastAction = 'seek food';
        a.lastReason = `to (${foodLoc.x},${foodLoc.y})`;
      } else {
        aiTryMove(state, a, randInt(-1, 2), randInt(-1, 2));
        a.lastAction = 'wander';
        a.lastReason = 'no food known';
      }
      break;

    case 1: {
      // drink
      let nearWater = false;
      for (let ddy = -1; ddy <= 1 && !nearWater; ddy++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          const nx = a.x + ddx;
          const ny = a.y + ddy;
          if (
            nx >= 0 &&
            nx < WORLD_W &&
            ny >= 0 &&
            ny < WORLD_H &&
            state.tiles[idxOf(nx, ny)] === Tile.WATER
          ) {
            nearWater = true;
            break;
          }
        }
      }
      if (nearWater) {
        a.thirst = Math.max(0, a.thirst - 0.7);
        a.soul++;
        state.soulPool = Math.max(0, state.soulPool - 1);
        a.lastAction = 'drank';
        a.lastReason = `thirst ${a.thirst.toFixed(2)}`;
        aiEmit(state, a, Concept.WATER);
      } else if (waterLoc) {
        aiStepToward(state, a, waterLoc.x, waterLoc.y);
        a.lastAction = 'seek water';
        a.lastReason = `to pond (${waterLoc.x},${waterLoc.y})`;
      } else {
        aiTryMove(state, a, randInt(-1, 2), randInt(-1, 2));
        a.lastAction = 'wander';
        a.lastReason = 'no water known';
      }
      break;
    }

    case 2: // flee
      if (enemy) {
        aiTryMove(state, a, -sgn(enemy.x - a.x), -sgn(enemy.y - a.y));
        a.lastAction = 'flee';
        a.lastReason = `from ${enemy.name}`;
        aiEmit(state, a, Concept.DANGER);
      } else {
        aiTryMove(state, a, randInt(-1, 2), randInt(-1, 2));
        a.lastAction = 'scatter';
        a.lastReason = 'nothing to flee';
      }
      break;

    case 3: // hunt
      if (prey && prey.name !== a.kingName) {
        // Reduced aggression in presence of king
        if (myKing && (myKing.x - a.x) ** 2 + (myKing.y - a.y) ** 2 <= 9 && Math.random() < 0.5) {
          a.lastAction = 'restrained';
          a.lastReason = `near king ${myKing.name}`;
          break;
        }
        const dxy = Math.abs(prey.x - a.x) + Math.abs(prey.y - a.y);
        if (dxy <= 1) aiAttack(state, a, prey);
        else {
          aiStepToward(state, a, prey.x, prey.y);
          a.lastAction = 'stalk';
          a.lastReason = prey.name;
        }
      } else {
        aiTryMove(state, a, randInt(-1, 2), randInt(-1, 2));
        a.lastAction = 'hunt?';
        a.lastReason = 'no prey';
      }
      break;

    case 4: // help / gift
      if (prey || enemy) {
        const target = prey ?? enemy!;
        aiStepToward(state, a, target.x, target.y);
        if (Math.abs(target.x - a.x) + Math.abs(target.y - a.y) <= 1 && a.soul > 20) {
          a.soul--;
          target.soul++;
          a.helps++;
          a.lastAction = 'helped';
          a.lastReason = `gave soul to ${target.name}`;
          updateRel(state, target, a.name, +15, +12);
          updateRel(state, a, target.name, +5, +2);
          appendQuantizedMemory(
            a,
            state.tick,
            MemoryEventType.HELPED,
            target.x,
            target.y,
            target.name,
            1,
            state.tiles[idxOf(a.x, a.y)] as Tile,
            2,
            isNight(state.tick) ? 1 : 0
          );
          appendQuantizedMemory(
            target,
            state.tick,
            MemoryEventType.HELPED,
            a.x,
            a.y,
            a.name,
            1,
            state.tiles[idxOf(target.x, target.y)] as Tile,
            12,
            isNight(state.tick) ? 1 : 0
          );
          aiEmit(state, a, Concept.FRIEND);
        } else {
          a.lastAction = 'aid';
          a.lastReason = target.name;
        }
      } else {
        a.lastAction = 'idle';
        a.lastReason = 'no one to help';
      }
      break;

    case 5: // explore
      aiTryMove(state, a, randInt(-1, 2), randInt(-1, 2));
      a.lastAction = 'explore';
      a.lastReason = 'curiosity';
      break;

    case 6: // rest
      a.energy = Math.min(1.0, a.energy + 0.025);
      a.lastAction = 'rest';
      a.lastReason = `energy ${a.energy.toFixed(2)}`;
      if (randInt(0, 10) === 0) aiEmit(state, a, Concept.CALM);
      break;

    case 7: // wait
      a.lastAction = 'wait';
      a.lastReason = 'observing';
      break;

    case 8: {
      // build wall
      let tx = a.x;
      let ty = a.y;
      if (a.facing === 0) ty--;
      else if (a.facing === 1) tx++;
      else if (a.facing === 2) ty++;
      else tx--;
      const hasMat = a.carrying === CarryItem.WOOD || a.carrying === CarryItem.STONE;
      if (!hasMat) {
        a.lastAction = 'build?';
        a.lastReason = 'no material';
      } else if (
        tx >= 0 &&
        tx < WORLD_W &&
        ty >= 0 &&
        ty < WORLD_H &&
        state.tiles[idxOf(tx, ty)] === Tile.GRASS
      ) {
        state.tiles[idxOf(tx, ty)] = Tile.BUILT;
        a.carrying = CarryItem.NONE;
        a.lastAction = 'built';
        a.lastReason = `wall @${tx},${ty}`;
        pushWorkingMemory(a, state.tick, `Built wall at (${tx},${ty})`, 'action');
      } else {
        a.lastAction = 'build?';
        a.lastReason = 'blocked';
      }
      break;
    }

    case 9: {
      // break / mine
      let tx = a.x;
      let ty = a.y;
      if (a.facing === 0) ty--;
      else if (a.facing === 1) tx++;
      else if (a.facing === 2) ty++;
      else tx--;
      if (tx >= 0 && tx < WORLD_W && ty >= 0 && ty < WORLD_H) {
        const t = state.tiles[idxOf(tx, ty)] as Tile;
        if (t === Tile.FOREST || t === Tile.STONE || t === Tile.BUILT || t === Tile.PIT) {
          state.tiles[idxOf(tx, ty)] = Tile.GRASS;
          const gain = t === Tile.STONE ? 2 : 1;
          a.soul += gain;
          state.soulPool = Math.max(0, state.soulPool - gain);
          if (a.carrying === CarryItem.NONE) {
            if (t === Tile.FOREST || t === Tile.BUILT) a.carrying = CarryItem.WOOD;
            else if (t === Tile.STONE) a.carrying = CarryItem.STONE;
          }
          a.lastAction = 'broke';
          a.lastReason =
            t === Tile.FOREST
              ? 'tree → wood'
              : t === Tile.STONE
              ? 'mined stone'
              : t === Tile.BUILT
              ? 'wall → wood'
              : 'filled pit';
          break;
        }
      }
      a.lastAction = 'break?';
      a.lastReason = 'nothing solid';
      break;
    }

    case 10: {
      // dig pit
      let tx = a.x;
      let ty = a.y;
      if (a.facing === 0) ty--;
      else if (a.facing === 1) tx++;
      else if (a.facing === 2) ty++;
      else tx--;
      if (
        tx >= 0 &&
        tx < WORLD_W &&
        ty >= 0 &&
        ty < WORLD_H &&
        (state.tiles[idxOf(tx, ty)] === Tile.GRASS || state.tiles[idxOf(tx, ty)] === Tile.SAND)
      ) {
        state.tiles[idxOf(tx, ty)] = Tile.PIT;
        a.energy = Math.max(0, a.energy - 0.08);
        a.lastAction = 'dug';
        a.lastReason = `pit @${tx},${ty}`;
      } else {
        a.lastAction = 'dig?';
        a.lastReason = "can't dig here";
      }
      break;
    }

    case 11: {
      // jump 2 tiles (escape pit or vault wall)
      const dx = a.facing === 1 ? 1 : a.facing === 3 ? -1 : 0;
      const dy = a.facing === 2 ? 1 : a.facing === 0 ? -1 : 0;
      a.energy = Math.max(0, a.energy - 0.08);
      const wasInPit = state.tiles[idxOf(a.x, a.y)] === Tile.PIT;
      const landX = a.x + 2 * dx;
      const landY = a.y + 2 * dy;
      const canLand =
        landX >= 0 &&
        landX < WORLD_W &&
        landY >= 0 &&
        landY < WORLD_H &&
        isPassable(state.tiles[idxOf(landX, landY)] as Tile);
      const occupied = state.ais.some(
        (other) => other.alive && other.id !== a.id && other.x === landX && other.y === landY
      );
      const midX = a.x + dx;
      const midY = a.y + dy;
      const overWall =
        midX >= 0 &&
        midX < WORLD_W &&
        midY >= 0 &&
        midY < WORLD_H &&
        isSolid(state.tiles[idxOf(midX, midY)] as Tile);

      if (canLand && !occupied) {
        a.prevX = a.x;
        a.prevY = a.y;
        a.moveStartMs = performance.now();
        a.x = landX;
        a.y = landY;
        a.trapTick = state.tiles[idxOf(landX, landY)] === Tile.PIT ? state.tick : 0;
        a.lastAction = wasInPit ? 'jump out' : 'jumped';
        a.lastReason = wasInPit ? 'escaped pit' : overWall ? 'vaulted wall' : '2 tiles';
      } else if (aiTryJump(state, a, dx, dy)) {
        a.lastAction = 'hop';
        a.lastReason = '1 tile';
      } else {
        a.lastAction = 'jump?';
        a.lastReason = 'blocked';
      }
      break;
    }

    case 12: {
      // trade
      const partner = enemy ?? prey;
      if (partner && state.settings.socialEnabled) {
        const dist = Math.abs(partner.x - a.x) + Math.abs(partner.y - a.y);
        if (dist <= 2) {
          if (!aiAttemptTrade(state, a, partner)) {
            a.lastAction = 'trade?';
            a.lastReason = `${partner.name} declined`;
          }
        } else {
          aiStepToward(state, a, partner.x, partner.y);
          a.lastAction = 'seek trade';
          a.lastReason = `with ${partner.name}`;
        }
      } else {
        aiTryMove(state, a, randInt(-1, 2), randInt(-1, 2));
        a.lastAction = 'trade?';
        a.lastReason = 'no partner nearby';
      }
      break;
    }

    case 13: {
      // defer / follow king (or rally followers if king)
      if (myKing) {
        const dist = Math.abs(myKing.x - a.x) + Math.abs(myKing.y - a.y);
        if (dist > 2) {
          aiStepToward(state, a, myKing.x, myKing.y);
          a.lastAction = 'follow king';
          a.lastReason = `trailing ${myKing.name}`;
        } else {
          // Tribute / scraps exchange with king
          if (a.carrying === CarryItem.BERRY && myKing.hunger > 0.3) {
            a.carrying = CarryItem.NONE;
            myKing.hunger = Math.max(0, myKing.hunger - 0.35);
            myKing.soul += 1;
            updateRel(state, a, myKing.name, +4, +4);
            a.lastAction = 'tribute';
            a.lastReason = `fed king ${myKing.name}`;
          } else {
            a.lastAction = 'attend';
            a.lastReason = `court of ${myKing.name}`;
          }
        }
      } else if (a.isKing) {
        aiEmit(state, a, Concept.CALM);
        a.lastAction = 'rally court';
        a.lastReason = `${a.followerCount} followers`;
      } else {
        a.lastAction = 'defer';
        a.lastReason = 'no sovereign';
      }
      break;
    }
  }
}

function aiReproduce(state: WorldState, p1: AI, p2: AI): void {
  if (!state.settings.reproEnabled) return;
  if (state.soulPool < 20) return;
  if (state.tick - p1.lastReproTick < 1000 || state.tick - p2.lastReproTick < 1000) return;

  const slot = state.ais.findIndex((a) => !a.alive);
  if (slot < 0) return;

  let bx = -1;
  let by = -1;
  for (let dy = -1; dy <= 1 && bx < 0; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = p1.x + dx;
      const ny = p1.y + dy;
      if (nx < 0 || nx >= WORLD_W || ny < 0 || ny >= WORLD_H) continue;
      if (!isPassable(state.tiles[idxOf(nx, ny)] as Tile)) continue;
      const occ = state.ais.some((other) => other.alive && other.x === nx && other.y === ny);
      if (!occ) {
        bx = nx;
        by = ny;
        break;
      }
    }
  }
  if (bx < 0) return;

  const c = spawnAI(state, slot);
  c.x = bx;
  c.y = by;
  c.prevX = bx;
  c.prevY = by;

  // Inherit averaged Q-table
  for (let i = 0; i < c.qtable.length; i++) {
    c.qtable[i] = Math.round((p1.qtable[i] + p2.qtable[i]) / 2);
  }
  // Inherit mouth & averaged ear
  for (let cc = 0; cc < N_CONCEPTS; cc++) {
    c.mouth[cc] = randInt(0, 2) === 0 ? p1.mouth[cc] : p2.mouth[cc];
  }
  for (let i = 0; i < c.ear.length; i++) {
    c.ear[i] = Math.round((p1.ear[i] + p2.ear[i]) / 2);
  }
  c.aggression = clamp((p1.aggression + p2.aggression) / 2 + (Math.random() * 2 - 1) * 0.1, 0, 1);
  c.curiosity = clamp((p1.curiosity + p2.curiosity) / 2 + (Math.random() * 2 - 1) * 0.1, 0, 1);
  c.trust = clamp((p1.trust + p2.trust) / 2 + (Math.random() * 2 - 1) * 0.1, 0, 1);
  c.shape = randInt(0, 2) === 0 ? p1.shape : p2.shape;
  c.color = randInt(0, 2) === 0 ? p1.color : p2.color;
  c.parent1 = p1.name;
  c.parent2 = p2.name;

  p1.numChildren++;
  p2.numChildren++;
  p1.lastReproTick = state.tick;
  p2.lastReproTick = state.tick;
  p1.soul = Math.max(1, p1.soul - 4);
  p2.soul = Math.max(1, p2.soul - 4);
  state.soulPool = Math.max(0, state.soulPool - 10);
  c.soul = 10;

  updateRel(state, c, p1.name, +50, +35);
  updateRel(state, c, p2.name, +50, +35);
  updateRel(state, p1, c.name, +40, +5);
  updateRel(state, p2, c.name, +40, +5);

  p1.lastAction = 'birth';
  p1.lastReason = `${p2.name} → ${c.name}`;
  p2.lastAction = 'birth';
  p2.lastReason = `${p1.name} → ${c.name}`;
  state.totalBirths++;
  addWorldEvent(state, '#4ade80', 'birth', `${c.name} born to ${p1.name} + ${p2.name}`);
}

function recomputeKingdoms(state: WorldState): void {
  const prevKings = new Set(state.ais.filter((a) => a.alive && a.isKing).map((a) => a.name));

  for (const a of state.ais) {
    a.followerCount = 0;
    a.isKing = false;
  }

  // Validate follower references & count followers
  for (const a of state.ais) {
    if (!a.alive || !a.kingName) continue;
    const king = state.ais.find((k) => k.alive && k.name === a.kingName);
    if (!king || king.id === a.id) {
      a.kingName = '';
      continue;
    }
    king.followerCount++;
  }

  for (const a of state.ais) {
    if (!a.alive) continue;
    if (a.followerCount >= 2) {
      a.isKing = true;
      a.kingName = ''; // kings don't remain vassals once crowned
      if (!prevKings.has(a.name)) {
        addWorldEvent(
          state,
          '#fbbf24',
          'kingdom',
          `Crown: ${a.name} rose as King (${a.followerCount} loyal)`
        );
      }
    }
  }
}

export function getKingdoms(state: WorldState): KingdomInfo[] {
  const result: KingdomInfo[] = [];
  for (const k of state.ais) {
    if (!k.alive || !k.isKing) continue;
    const followers = state.ais
      .filter((f) => f.alive && f.kingName === k.name)
      .map((f) => ({
        name: f.name,
        loyalty: getRelLoyalty(f, k.name),
        id: f.id,
      }));
    const sig = Array.from(k.mouth)
      .map((s) => `S${s}`)
      .join('');
    result.push({
      kingName: k.name,
      kingId: k.id,
      kingColor: k.color,
      kingSoul: k.soul,
      followers,
      dialectSignature: sig,
    });
  }
  return result;
}

export function worldTick(state: WorldState): void {
  state.tick++;

  // Food regrowth
  if (
    state.settings.paramFoodRegrowRate > 0 &&
    state.tick % state.settings.paramFoodRegrowRate === 0
  ) {
    for (let i = 0; i < 3; i++) {
      const x = randInt(0, WORLD_W);
      const y = randInt(0, WORLD_H);
      const t = state.tiles[idxOf(x, y)] as Tile;
      if (t === Tile.GRASS || t === Tile.FOREST) {
        state.tiles[idxOf(x, y)] = Tile.FOOD;
      }
    }
  }

  // Memorial slow decay
  if (
    state.settings.paramMemorialDecay > 0 &&
    state.tick % state.settings.paramMemorialDecay === 0
  ) {
    for (let i = 0; i < state.tiles.length; i++) {
      if (state.tiles[i] === Tile.MEMORIAL && randInt(0, 100) < 10) {
        state.tiles[i] = Tile.GRASS;
      }
    }
  }

  // Tick all active AIs
  for (const a of state.ais) {
    if (a.alive) aiTick(state, a);
  }

  // Update king/follower status
  recomputeKingdoms(state);

  // Periodic reproduction
  if (state.settings.reproEnabled && state.tick % 50 === 0) {
    for (let i = 0; i < state.ais.length; i++) {
      const a = state.ais[i];
      if (!a.alive || a.soul < 30) continue;
      for (let j = i + 1; j < state.ais.length; j++) {
        const b = state.ais[j];
        if (!b.alive || b.soul < 30) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx * dx + dy * dy > 2) continue;
        const t1 = getRelTrust(a, b.name);
        const t2 = getRelTrust(b, a.name);
        if (t1 >= 30 && t2 >= 30 && randInt(0, 100) < 15) {
          aiReproduce(state, a, b);
          break;
        }
      }
    }
  }

  // Respawn newborns from soul pool when population below cap
  let aliveCnt = state.ais.filter((a) => a.alive).length;
  for (let i = 0; i < MAX_AI && aliveCnt < state.settings.paramPopulationCap; i++) {
    if (!state.ais[i] || !state.ais[i].alive) {
      if (state.soulPool >= 16) {
        spawnAI(state, i);
        aliveCnt++;
      }
    }
  }
}

export function resetAIsOnly(state: WorldState): void {
  for (const a of state.ais) {
    if (a.alive) {
      state.soulPool += a.soul;
      a.alive = false;
    }
  }
  state.soulPool = SOUL_POOL_MAX;
  for (let i = 0; i < MAX_AI; i++) {
    if (i < state.settings.paramPopulationCap) {
      spawnAI(state, i);
    }
  }
  addWorldEvent(state, '#22d3ee', 'system', 'Population reseeded from soul pool');
}

export function computeDialectConvergence(state: WorldState): {
  concept: string;
  dominantSound: number;
  agreementPct: number;
}[] {
  const living = state.ais.filter((a) => a.alive);
  return CONCEPT_NAMES.map((concept, cIdx) => {
    const counts = new Array(N_SOUNDS).fill(0);
    for (const a of living) counts[a.mouth[cIdx]]++;
    let bestS = 0;
    for (let s = 1; s < N_SOUNDS; s++) {
      if (counts[s] > counts[bestS]) bestS = s;
    }
    const agreementPct = living.length > 0 ? Math.round((counts[bestS] / living.length) * 100) : 0;
    return { concept, dominantSound: bestS, agreementPct };
  });
}
