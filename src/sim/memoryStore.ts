import {
  AI,
  DecodedMemoryRecord,
  MEMORY_EVENT_LABELS,
  MemoryEventType,
  Tile,
  TILE_NAMES,
  WorldState,
} from './types';

export const RECORD_BYTES = 16;
export const MAX_RECORDS_PER_AI = 2048; // 32 KB per AI in RAM/SD cap before truncation

/**
 * Encode one long-term life event into exactly 16 quantized bytes
 * Layout (memories/<NAME>.dat):
 *   [0..3]  uint32 LE : tick
 *   [4]     uint8     : eventType
 *   [5]     uint8     : x (0..63)
 *   [6]     uint8     : y (0..63)
 *   [7..9]  3 ASCII   : other AI name (or 0,0,0)
 *   [10..11] int16 LE : signed value (soul delta, trust, damage)
 *   [12]    uint8     : tile enum
 *   [13]    int8      : loyalty delta
 *   [14]    uint8     : flags (bit0=night, bit1=kingRelated, bit2=unknown)
 *   [15]    uint8     : xor checksum of bytes 0..14
 */
export function encodeMemoryRecord(
  tick: number,
  eventType: MemoryEventType,
  x: number,
  y: number,
  otherName: string,
  value: number,
  tile: Tile,
  loyaltyDelta: number,
  flags: number
): Uint8Array {
  const buf = new Uint8Array(RECORD_BYTES);
  const view = new DataView(buf.buffer);
  view.setUint32(0, tick >>> 0, true);
  buf[4] = eventType & 0xff;
  buf[5] = x & 0xff;
  buf[6] = y & 0xff;
  buf[7] = otherName.length > 0 ? otherName.charCodeAt(0) & 0x7f : 0;
  buf[8] = otherName.length > 1 ? otherName.charCodeAt(1) & 0x7f : 0;
  buf[9] = otherName.length > 2 ? otherName.charCodeAt(2) & 0x7f : 0;
  const clampedVal = Math.max(-32768, Math.min(32767, Math.round(value)));
  view.setInt16(10, clampedVal, true);
  buf[12] = tile & 0xff;
  const clampedLoy = Math.max(-128, Math.min(127, Math.round(loyaltyDelta)));
  view.setInt8(13, clampedLoy);
  buf[14] = flags & 0xff;

  let cksum = 0;
  for (let i = 0; i < 15; i++) cksum ^= buf[i];
  buf[15] = cksum;
  return buf;
}

export function appendQuantizedMemory(
  ai: AI,
  tick: number,
  eventType: MemoryEventType,
  x: number,
  y: number,
  otherName: string,
  value: number,
  tile: Tile,
  loyaltyDelta: number,
  flags: number
): void {
  const rec = encodeMemoryRecord(
    tick,
    eventType,
    x,
    y,
    otherName,
    value,
    tile,
    loyaltyDelta,
    flags
  );

  // Truncate oldest 25% if file exceeds cap (mirrors SD decay / truncation)
  if (ai.sdRecordCount >= MAX_RECORDS_PER_AI) {
    const drop = Math.floor(MAX_RECORDS_PER_AI * 0.25);
    const keepBytes = (ai.sdRecordCount - drop) * RECORD_BYTES;
    const next = new Uint8Array(keepBytes + RECORD_BYTES);
    next.set(ai.sdMemory.subarray(drop * RECORD_BYTES, ai.sdRecordCount * RECORD_BYTES), 0);
    next.set(rec, keepBytes);
    ai.sdMemory = next;
    ai.sdRecordCount = ai.sdRecordCount - drop + 1;
    return;
  }

  const needed = (ai.sdRecordCount + 1) * RECORD_BYTES;
  if (ai.sdMemory.length < needed) {
    const newCap = Math.max(needed, Math.min(MAX_RECORDS_PER_AI * RECORD_BYTES, ai.sdMemory.length * 2 + 256));
    const grown = new Uint8Array(newCap);
    grown.set(ai.sdMemory.subarray(0, ai.sdRecordCount * RECORD_BYTES), 0);
    ai.sdMemory = grown;
  }
  ai.sdMemory.set(rec, ai.sdRecordCount * RECORD_BYTES);
  ai.sdRecordCount++;
}

export function decodeMemoryAt(buf: Uint8Array, index: number): DecodedMemoryRecord {
  const offset = index * RECORD_BYTES;
  const slice = buf.subarray(offset, offset + RECORD_BYTES);
  const view = new DataView(buf.buffer, buf.byteOffset + offset, RECORD_BYTES);
  const tick = view.getUint32(0, true);
  const eventType = slice[4] as MemoryEventType;
  const x = slice[5];
  const y = slice[6];
  const chars = [slice[7], slice[8], slice[9]].filter((c) => c >= 32 && c < 127);
  const otherName = String.fromCharCode(...chars);
  const value = view.getInt16(10, true);
  const tile = slice[12] as Tile;
  const loyaltyDelta = view.getInt8(13);
  const flags = slice[14];
  let hex = '';
  for (let i = 0; i < RECORD_BYTES; i++) {
    hex += slice[i].toString(16).padStart(2, '0');
    if (i < RECORD_BYTES - 1) hex += ' ';
  }
  return {
    tick,
    eventType,
    x,
    y,
    otherName,
    value,
    tile,
    loyaltyDelta,
    flags,
    rawHex: hex,
  };
}

export function decodeAllMemories(ai: AI, limit = 120): DecodedMemoryRecord[] {
  const count = ai.sdRecordCount;
  const start = Math.max(0, count - limit);
  const out: DecodedMemoryRecord[] = [];
  for (let i = count - 1; i >= start; i--) {
    out.push(decodeMemoryAt(ai.sdMemory, i));
  }
  return out;
}

/**
 * On-demand "remember" query into the quantized 16-byte SD archive.
 * Scans backwards from deep history for encounters with a target AI.
 */
export function queryMemoryAboutAI(
  ai: AI,
  targetName: string
): {
  encounters: number;
  netSentiment: number;
  lastEvent: DecodedMemoryRecord | null;
} {
  if (!targetName || ai.sdRecordCount === 0) {
    return { encounters: 0, netSentiment: 0, lastEvent: null };
  }
  const c0 = targetName.charCodeAt(0) & 0x7f;
  const c1 = targetName.charCodeAt(1) & 0x7f;
  const c2 = targetName.charCodeAt(2) & 0x7f;
  let encounters = 0;
  let netSentiment = 0;
  let lastEvent: DecodedMemoryRecord | null = null;

  for (let i = ai.sdRecordCount - 1; i >= 0; i--) {
    const off = i * RECORD_BYTES;
    if (ai.sdMemory[off + 7] === c0 && ai.sdMemory[off + 8] === c1 && ai.sdMemory[off + 9] === c2) {
      const rec = decodeMemoryAt(ai.sdMemory, i);
      if (!lastEvent) lastEvent = rec;
      encounters++;
      if (
        rec.eventType === MemoryEventType.TRADE ||
        rec.eventType === MemoryEventType.HELPED ||
        rec.eventType === MemoryEventType.PROTECTED ||
        rec.eventType === MemoryEventType.LOYALTY_SWORN
      ) {
        netSentiment += 2;
      } else if (
        rec.eventType === MemoryEventType.ATTACKED ||
        rec.eventType === MemoryEventType.DEFECTED
      ) {
        netSentiment -= 3;
      }
      if (encounters >= 16) break;
    }
  }
  return { encounters, netSentiment, lastEvent };
}

export function formatMemorySummary(rec: DecodedMemoryRecord): string {
  const label = MEMORY_EVENT_LABELS[rec.eventType] ?? 'event';
  const tileName = TILE_NAMES[rec.tile]?.toLowerCase() ?? 'land';
  if (
    rec.eventType === MemoryEventType.UNKNOWN_HURT ||
    rec.eventType === MemoryEventType.UNKNOWN_BLESS
  ) {
    const sign = rec.value >= 0 ? `+${rec.value}` : `${rec.value}`;
    return `t${rec.tick} ${label} (${rec.x},${rec.y}) ${tileName} (${sign} soul)`;
  }
  if (rec.otherName) {
    const valStr = rec.value !== 0 ? ` (${rec.value > 0 ? '+' : ''}${rec.value})` : '';
    return `t${rec.tick} ${label} ${rec.otherName} at ${tileName} (${rec.x},${rec.y})${valStr}`;
  }
  return `t${rec.tick} ${label} at ${tileName} (${rec.x},${rec.y})`;
}

export function downloadMemoryFile(ai: AI): void {
  const bytes = ai.sdMemory.slice(0, ai.sdRecordCount * RECORD_BYTES);
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${ai.name}.dat`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------- IndexedDB Persistence ("Virtual SD Card") ----------------
const DB_NAME = 'tdeck_world_sd_v1';
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'world_state';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

interface SerializedAI extends Omit<AI, 'seen' | 'qtable' | 'sdMemory' | 'mouth' | 'ear'> {
  seen: number[];
  qtable: number[];
  sdMemory: number[];
  mouth: number[];
  ear: number[];
}

interface SerializedWorld extends Omit<WorldState, 'tiles' | 'cursedTiles' | 'ais'> {
  tiles: number[];
  cursedTiles: number[];
  ais: SerializedAI[];
}

export async function saveWorldToSD(state: WorldState): Promise<number> {
  try {
    const payload: SerializedWorld = {
      ...state,
      tiles: Array.from(state.tiles),
      cursedTiles: Array.from(state.cursedTiles),
      ais: state.ais.map((a) => ({
        ...a,
        seen: Array.from(a.seen),
        qtable: Array.from(a.qtable),
        sdMemory: Array.from(a.sdMemory.subarray(0, a.sdRecordCount * RECORD_BYTES)),
        mouth: Array.from(a.mouth),
        ear: Array.from(a.ear),
      })),
    };
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(payload, SNAPSHOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return payload.ais.reduce((sum, a) => sum + a.sdMemory.length, 0);
  } catch {
    return 0;
  }
}

export async function loadWorldFromSD(): Promise<WorldState | null> {
  try {
    const db = await openDB();
    const raw = await new Promise<SerializedWorld | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
      req.onsuccess = () => resolve(req.result as SerializedWorld | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!raw || !Array.isArray(raw.tiles) || raw.tiles.length !== 64 * 64) {
      return null;
    }
    const now = performance.now();
    return {
      ...raw,
      tiles: Uint8Array.from(raw.tiles),
      cursedTiles: Uint8Array.from(raw.cursedTiles),
      ais: raw.ais.map((a) => ({
        ...a,
        moveStartMs: now,
        seen: Uint8Array.from(a.seen),
        qtable: Int16Array.from(a.qtable),
        sdMemory: Uint8Array.from(a.sdMemory),
        mouth: Uint8Array.from(a.mouth),
        ear: Int8Array.from(a.ear),
      })),
    };
  } catch {
    return null;
  }
}

export async function clearWorldSD(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(SNAPSHOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore storage errors
  }
}
