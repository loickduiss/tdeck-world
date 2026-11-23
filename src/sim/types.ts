export const WORLD_W = 64;
export const WORLD_H = 64;
export const MAX_AI = 10;
export const DEFAULT_POP_CAP = 8;
export const SOUL_POOL_MAX = 2048;
export const MONSTER_THRESHOLD = 200;
export const MEMORIAL_MAX = 24;
export const DAY_TICKS = 2400;

export const N_SOUNDS = 8;
export const N_CONCEPTS = 8;
export const Q_STATES = 48;
export const Q_ACTIONS = 14; // 12 core T-Deck actions + trade + defer/rally

export enum Tile {
  GRASS = 0,
  WATER = 1,
  FOREST = 2,
  STONE = 3,
  SAND = 4,
  FOOD = 5,
  BUILT = 6,
  MEMORIAL = 7,
  PIT = 8,
}

export const TILE_NAMES: Record<Tile, string> = {
  [Tile.GRASS]: 'Grass',
  [Tile.WATER]: 'Water',
  [Tile.FOREST]: 'Forest',
  [Tile.STONE]: 'Stone',
  [Tile.SAND]: 'Sand',
  [Tile.FOOD]: 'Berries',
  [Tile.BUILT]: 'Wall',
  [Tile.MEMORIAL]: 'Memorial',
  [Tile.PIT]: 'Pit',
};

export const TILE_COLORS: Record<Tile, string> = {
  [Tile.GRASS]: '#3a6b40',
  [Tile.WATER]: '#1c5f9e',
  [Tile.FOREST]: '#1d442b',
  [Tile.STONE]: '#6a727d',
  [Tile.SAND]: '#bfa977',
  [Tile.FOOD]: '#d63b42',
  [Tile.BUILT]: '#9aa4b2',
  [Tile.MEMORIAL]: '#e8c547',
  [Tile.PIT]: '#17191d',
};

export enum Concept {
  FOOD = 0,
  WATER = 1,
  ENEMY = 2,
  PAIN = 3,
  FRIEND = 4,
  DANGER = 5,
  KILL = 6,
  CALM = 7,
}

export const CONCEPT_NAMES = [
  'food',
  'watr',
  'enmy',
  'pain',
  'frnd',
  'dngr',
  'kill',
  'calm',
] as const;

export const CONCEPT_COLORS = [
  '#f87171', // food
  '#38bdf8', // watr
  '#fb923c', // enmy
  '#f472b6', // pain
  '#34d399', // frnd
  '#fbbf24', // dngr
  '#ef4444', // kill
  '#94a3b8', // calm
] as const;

export const ACT_NAMES = [
  'seek',
  'drink',
  'flee',
  'hunt',
  'help',
  'expl',
  'rest',
  'wait',
  'build',
  'break',
  'dig',
  'jump',
  'trade',
  'defer',
] as const;

export const ACT_ICONS = [
  'F',
  'D',
  '!',
  'K',
  '+',
  '?',
  'Z',
  '-',
  'B',
  'X',
  'V',
  'J',
  'T',
  'C',
] as const;

export enum CarryItem {
  NONE = 0,
  WOOD = 1,
  STONE = 2,
  BERRY = 3,
}

export const CARRY_NAMES: Record<CarryItem, string> = {
  [CarryItem.NONE]: 'none',
  [CarryItem.WOOD]: 'wood',
  [CarryItem.STONE]: 'stone',
  [CarryItem.BERRY]: 'berry',
};

export const AI_PALETTE = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#94a3b8',
  '#e879f9',
  '#fbbf24',
  '#fb7185',
  '#cbd5e1',
  '#a3e635',
  '#f8fafc',
] as const;

export enum MemoryEventType {
  MET = 1,
  TRADE = 2,
  HELPED = 3,
  ATTACKED = 4,
  KILLED = 5,
  LOYALTY_SWORN = 6,
  DEFECTED = 7,
  MEMORIAL_READ = 8,
  UNKNOWN_HURT = 9,
  UNKNOWN_BLESS = 10,
  BIRTH = 11,
  RECALLED = 12,
  PROTECTED = 13,
  KING_DEFEAT = 14,
}

export const MEMORY_EVENT_LABELS: Record<MemoryEventType, string> = {
  [MemoryEventType.MET]: 'met',
  [MemoryEventType.TRADE]: 'traded with',
  [MemoryEventType.HELPED]: 'shared aid with',
  [MemoryEventType.ATTACKED]: 'clashed with',
  [MemoryEventType.KILLED]: 'slew',
  [MemoryEventType.LOYALTY_SWORN]: 'swore fealty to',
  [MemoryEventType.DEFECTED]: 'defected from',
  [MemoryEventType.MEMORIAL_READ]: 'read memorial of',
  [MemoryEventType.UNKNOWN_HURT]: '??? pain at',
  [MemoryEventType.UNKNOWN_BLESS]: '??? boon at',
  [MemoryEventType.BIRTH]: 'born from',
  [MemoryEventType.RECALLED]: 'recalled',
  [MemoryEventType.PROTECTED]: 'protected by',
  [MemoryEventType.KING_DEFEAT]: 'witnessed defeat of',
};

export interface DecodedMemoryRecord {
  tick: number;
  eventType: MemoryEventType;
  x: number;
  y: number;
  otherName: string;
  value: number;
  tile: Tile;
  loyaltyDelta: number;
  flags: number;
  rawHex: string;
}

export interface WorkingMemoryEntry {
  tick: number;
  summary: string;
  category: 'action' | 'social' | 'memory' | 'unknown';
}

export interface Relationship {
  name: string;
  trust: number; // -100..+100
  loyalty: number; // 0..100 (deference toward other)
  lastTick: number;
  trades: number;
}

export interface SuperstitionZone {
  x: number;
  y: number;
  tick: number;
  strength: number; // 1..5
  kind: 'taboo' | 'shrine';
}

export interface AI {
  id: number;
  alive: boolean;
  name: string;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  moveStartMs: number;
  facing: 0 | 1 | 2 | 3; // 0=N, 1=E, 2=S, 3=W
  soul: number;
  age: number;
  birthTick: number;
  shape: number; // 0..7
  color: string;

  // Needs (0..1)
  hunger: number;
  thirst: number;
  energy: number;

  // Dispositions (0..1)
  aggression: number;
  curiosity: number;
  trust: number;

  // Senses
  hearing: number;
  fov: number;

  // Lifetime counters
  kills: number;
  helps: number;
  trades: number;
  foodEaten: number;
  recalls: number;

  lastAction: string;
  lastReason: string;

  // Explored fog-of-war bitmask (WORLD_H * (WORLD_W / 8) = 512 bytes)
  seen: Uint8Array;

  // Working Memory (RAM, full precision)
  qtable: Int16Array; // length Q_STATES * Q_ACTIONS
  prevState: number;
  prevAction: number;
  prevHunger: number;
  prevThirst: number;
  prevEnergy: number;
  prevSoul: number;
  currentState: number;
  chosenAction: number;
  wasRandom: boolean;
  epsilon: number;
  workingMemory: WorkingMemoryEntry[]; // last 50 RAM events

  // Quantized Long-Term Memory (SD: memories/<NAME>.dat, 16 bytes/record)
  sdMemory: Uint8Array; // multiple of 16 bytes
  sdRecordCount: number;
  lastRecallText: string;
  lastRecallTick: number;

  // Language
  mouth: Uint8Array; // length N_CONCEPTS
  ear: Int8Array; // length N_SOUNDS * N_CONCEPTS
  lastEmittedSound: number;
  lastEmittedConcept: number;
  lastEmittedTick: number;
  lastHeardSound: number;
  lastHeardConcept: number;
  lastHeardTick: number;
  lastHeardFrom: string;

  // Relationships & Loyalty (up to 8 tracked AIs)
  relations: Relationship[];
  kingName: string; // non-empty when in follower mode
  followerCount: number; // derived each tick
  isKing: boolean; // true when followerCount >= 2

  // Superstitions (false theories about unexplained events)
  superstitions: SuperstitionZone[];

  // Lineage
  parent1: string;
  parent2: string;
  lastReproTick: number;
  numChildren: number;

  // Inventory & physics
  carrying: CarryItem;
  trapTick: number;
  lastAttacker: string;
  lastAttackedTick: number;
}

export interface MemorialData {
  used: boolean;
  x: number;
  y: number;
  qState: number;
  qRow: number[];
  mouth: number[];
  fromName: string;
  birthTick: number;
  legacySoul: number;
  legacyKills: number;
  wasKing: boolean;
}

export type EventCategory =
  | 'death'
  | 'birth'
  | 'combat'
  | 'trade'
  | 'kingdom'
  | 'memorial'
  | 'unknown'
  | 'system';

export interface WorldEvent {
  id: number;
  tick: number;
  text: string;
  color: string;
  category: EventCategory;
}

export interface WorldSettings {
  zoomIdx: number; // 0..3 -> 64, 40, 24, 12 tiles
  speedIdx: number; // 0..5 -> PAUSE, 0.5x, 1x, 2x, 5x, 15x
  followMode: boolean;
  showFOV: boolean;
  showFog: boolean;
  showHearing: boolean;
  showSound: boolean;
  showBonds: boolean;
  showSuperstitions: boolean;
  learningEnabled: boolean;
  langEnabled: boolean;
  reproEnabled: boolean;
  socialEnabled: boolean;
  paramFoodRegrowRate: number;
  paramRandomHurtRate: number;
  paramMemorialDecay: number;
  paramPopulationCap: number;
}

export interface KingdomInfo {
  kingName: string;
  kingId: number;
  kingColor: string;
  kingSoul: number;
  followers: { name: string; loyalty: number; id: number }[];
  dialectSignature: string;
}

export interface WorldState {
  tick: number;
  soulPool: number;
  tiles: Uint8Array; // WORLD_W * WORLD_H
  cursedTiles: Uint8Array; // hidden bitset WORLD_W * WORLD_H (0 or 1)
  ais: AI[];
  memorials: MemorialData[];
  events: WorldEvent[];
  nextEventId: number;
  usedNames: string[];
  totalDeaths: number;
  totalTrades: number;
  totalBirths: number;
  settings: WorldSettings;
}

export const ZOOM_LEVELS = [64, 40, 24, 12] as const;
export const ZOOM_LABELS = ['Far (64)', 'Mid (40)', 'Near (24)', 'Close (12)'] as const;
export const SPEED_MS = [0, 500, 250, 110, 45, 16] as const;
export const SPEED_LABELS = ['Pause', '0.5×', '1×', '2×', '5×', '15×'] as const;

export const DEFAULT_SETTINGS: WorldSettings = {
  zoomIdx: 1,
  speedIdx: 2,
  followMode: false,
  showFOV: true,
  showFog: false,
  showHearing: false,
  showSound: true,
  showBonds: true,
  showSuperstitions: false,
  learningEnabled: true,
  langEnabled: true,
  reproEnabled: true,
  socialEnabled: true,
  paramFoodRegrowRate: 60,
  paramRandomHurtRate: 3,
  paramMemorialDecay: 3000,
  paramPopulationCap: DEFAULT_POP_CAP,
};
