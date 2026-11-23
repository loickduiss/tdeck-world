import { buildZipBlob, triggerFileDownload } from './zipBuilder';

export const TDECK_PLATFORMIO_INI = `; =============================================================================
;  T-Deck World — Full Emergent Civilization Firmware (LilyGO T-Deck Plus)
;  ESP32-S3 · 16MB Flash · 8MB OPI PSRAM · ST7789 320x240 · MicroSD · I2C KB
;  Build:  pio run
;  Flash:  cp .pio/build/tdeck/firmware.bin /media/<user>/<SD>/world.bin && sync
; =============================================================================

[platformio]
default_envs = tdeck

[env:tdeck]
platform                        = espressif32@6.9.0
board                           = esp32-s3-devkitc-1
framework                       = arduino

board_build.flash_size          = 16MB
board_build.psram_type          = opi
board_build.arduino.memory_type = qio_opi
board_build.partitions          = default_16MB.csv
board_upload.flash_size         = 16MB

monitor_speed = 115200

build_flags =
    -DBOARD_HAS_PSRAM
    -DARDUINO_USB_CDC_ON_BOOT=1
    -DCORE_DEBUG_LEVEL=1
    ; ---- TFT_eSPI for LilyGO T-Deck Plus ST7789 ----
    -DUSER_SETUP_LOADED=1
    -DST7789_DRIVER=1
    -DUSE_HSPI_PORT=1
    -DTFT_INVERSION_ON
    -DTFT_RGB_ORDER=TFT_RGB
    -DTFT_WIDTH=240
    -DTFT_HEIGHT=320
    -DTFT_MISO=38
    -DTFT_MOSI=41
    -DTFT_SCLK=40
    -DTFT_CS=12
    -DTFT_DC=11
    -DTFT_RST=-1
    -DTFT_BL=42
    -DTFT_BACKLIGHT_ON=HIGH
    -DLOAD_GLCD=1
    -DLOAD_FONT2=1
    -DLOAD_FONT4=1
    -DLOAD_GFXFF=1
    -DSMOOTH_FONT=1
    -DSPI_FREQUENCY=27000000
    -DSPI_READ_FREQUENCY=16000000
    -DSPI_TOUCH_FREQUENCY=2500000

lib_deps =
    bodmer/TFT_eSPI@^2.5.43
`;

export const TDECK_README_MD = `# T-Deck World — LilyGO T-Deck Plus ESP32-S3 Firmware

Complete, persistent, open-ended emergent AI civilization simulator built specifically for the **LilyGO T-Deck Plus (ESP32-S3)**.

## Architecture on Hardware
- **Working Memory (RAM / OPI PSRAM, Full Precision)**: 48-state × 14-action Q-table per AI, current scene perception, Bresenham LOS, fog-of-war bitmask, mouth/ear language matrices, loyalty gradients, and superstitions.
- **Long-Term Memory (MicroSD, 16-Byte Quantized Records)**: Each AI maintains its own binary log \`/memories/<NAME>.dat\` (packed 16-byte records: tick, event type, coords, target name, signed value, tile, loyalty delta, flags, XOR checksum) queried on demand via \`sdRecallAI()\` and auto-truncated above 32 KB.
- **Persistent Continent (\`/world.sav\`)**: World tiles, cursed tiles, memorials, soul pool, and all living AIs auto-save to MicroSD every 500 ticks (or manually from the Settings menu) and resume seamlessly on reboot.

## Build & Flash

\`\`\`bash
unzip tdeck-world-esp32.zip
cd tdeck-world-esp32
pio run
\`\`\`

### Option A — Flash via Cairn Launcher / SD Card
\`\`\`bash
cp .pio/build/tdeck/firmware.bin /media/$USER/<SD_LABEL>/world.bin
sync
\`\`\`
Insert MicroSD into T-Deck Plus → Launcher → SD → \`world.bin\` → Install & Run.

### Option B — Direct USB-C Flash
\`\`\`bash
pio run -t upload
\`\`\`

## Controls (T-Deck Plus Trackball + I2C Keyboard)
- **Trackball / W A S D** — Pan the 64×64 continent (or navigate menus)
- **Trackball Click / Space** — Center camera on selected AI (or run Setting action)
- **\`+\` / \`-\` / \`Z\`** — Zoom levels (64 / 40 / 24 / 12 tiles)
- **\`p\` / \`n\` / \`]\`** — Next AI · **\`P\` / \`[\`** — Previous AI
- **\`R\`** — Expanded 7-Section Detail View (\`POV\`, \`GROWTH\`, \`NEEDS\`, \`BRAIN\`, \`RELATIONS\`, \`LANGUAGE\`, \`SD MEMORY\`)
- **\`E\`** — Toggle side panel (or expand section fullscreen in \`R\` view)
- **\`M\`** — Settings menu (display overlays, subsystem toggles, physics tuning, manual SD Save / Reset)
- **\`0\`–\`4\`** — Speed (\`0\` Pause, \`1\` 0.5×, \`2\` 1×, \`3\` 2×, \`4\` 5×)
`;

export const TDECK_MAIN_CPP = `// =============================================================================
//  T-Deck World — Full Emergent Civilization Firmware for LilyGO T-Deck Plus
//  Hardware: ESP32-S3 (16MB Flash + 8MB OPI PSRAM), ST7789 320x240,
//            I2C Keyboard (0x55), Trackball (GPIO 3/15/1/2/0), MicroSD (CS 39)
//  Features:
//    - 64x64 destructible continent + invisible cursed tiles + memorials
//    - 8 autonomous AIs: 48-state x 14-action Q-learning brain in RAM
//    - Quantized 16-byte SD long-term memory (/memories/<NAME>.dat) + recall
//    - Trading (resources + map intel), sticky loyalty, social proof & Kings
//    - Emergent language (8 phonemes x 8 concepts), dialect drift, lineage
//    - Unpredictable ??? events + emergent superstition taboo zones
//    - Zero-flicker TFT_eSprite UI, Doom-style raycast POV, 7-section R-view
// =============================================================================

#include <Arduino.h>
#include <SPI.h>
#include <SD.h>
#include <FS.h>
#include <TFT_eSPI.h>
#include <Wire.h>
#include <math.h>
#include <string.h>
#include <stdarg.h>

// ---------------- LILYGO T-DECK PLUS HARDWARE PINS ----------------
#define PERI_POWERON      10
#define TFT_BL_PIN        42
#define TFT_CS_PIN        12
#define LORA_CS_PIN        9
#define SD_CS_PIN         39
#define SPI_SCK_PIN       40
#define SPI_MISO_PIN      38
#define SPI_MOSI_PIN      41

#define KB_I2C_SDA        18
#define KB_I2C_SCL         8
#define KB_I2C_ADDR     0x55

#define TB_UP              3
#define TB_DOWN           15
#define TB_LEFT            1
#define TB_RIGHT           2
#define TB_CLICK           0

TFT_eSPI tft = TFT_eSPI();
TFT_eSprite mapSprite   = TFT_eSprite(&tft);
TFT_eSprite panelSprite = TFT_eSprite(&tft);
TFT_eSprite hudSprite   = TFT_eSprite(&tft);
TFT_eSprite fullSprite  = TFT_eSprite(&tft);

bool sdReady         = false;
bool expandedMode    = false;
int  rSectionIdx     = 0;
bool rSectionFullscr = false;

// ---------------- SCREEN LAYOUT ----------------
static const int SW    = 320;
static const int SH    = 240;
static const int HUD_H = 22;

bool panelOpen   = true;
int  PAN_W_OPEN  = 128;
int  PAN_X, PAN_Y, PAN_W, PAN_H;
int  MAP_X, MAP_Y, MAP_W, MAP_H;

// ---------------- EVENTS TICKER ----------------
struct Event { char text[42]; int tick; uint16_t col; };
static const int EVENT_LOG_SIZE = 10;
Event eventLog[EVENT_LOG_SIZE];
int eventHead = 0;

int tick = 0;

void addEvent(uint16_t col, const char* fmt, ...) {
  va_list ap; va_start(ap, fmt);
  vsnprintf(eventLog[eventHead].text, sizeof(eventLog[0].text), fmt, ap);
  va_end(ap);
  eventLog[eventHead].text[sizeof(eventLog[0].text) - 1] = 0;
  eventLog[eventHead].tick = tick;
  eventLog[eventHead].col  = col;
  eventHead = (eventHead + 1) % EVENT_LOG_SIZE;
}

// ---------------- WORLD ----------------
static const int WORLD_W = 64;
static const int WORLD_H = 64;

int zoomLevels[] = {64, 40, 24, 12};
int zoomIdx = 1;
int tilesVisX() { return min(WORLD_W, zoomLevels[zoomIdx]); }
int tilesVisY() {
  float ppx = (float)MAP_W / tilesVisX();
  int v = (int)(MAP_H / ppx + 0.5f);
  return min(WORLD_H, max(1, v));
}
float tilePpx() { return (float)MAP_W / tilesVisX(); }
float tilePpy() { return (float)MAP_H / tilesVisY(); }

enum Tile : uint8_t {
  T_GRASS = 0, T_WATER = 1, T_FOREST = 2, T_STONE = 3,
  T_SAND = 4, T_FOOD = 5, T_BUILT = 6, T_MEMORIAL = 7,
  T_PIT = 8, T_COUNT
};
static const uint16_t TILE_COLOR[T_COUNT] = {
  0x3B48, 0x1AF3, 0x1A25, 0x6B8F, 0xBD4E, 0xD1C8, 0x9D36, 0xEE28, 0x18C3
};

uint8_t world[WORLD_H][WORLD_W];
uint8_t cursedTile[WORLD_H][WORLD_W];   // invisible hazards

int camX = 16, camY = 16;
int timeOfDay() { return tick % 2400; }
bool isNight()  { int t = timeOfDay(); return t < 400 || t > 2000; }

int speedMs[] = {0, 500, 250, 100, 40};
int speedIdx  = 2;
int currentSpeedMs() { return speedMs[speedIdx]; }

int paramFoodRegrowRate = 60;
int paramRandomHurtRate = 3;
int paramMemorialDecay  = 3000;
int paramPopulationCap  = 8;

bool learningEnabled = true;
bool langEnabled     = true;
bool reproEnabled    = true;
bool socialEnabled   = true;

// ---------------- QUANTIZED 16-BYTE SD LONG-TERM MEMORY ----------------
// Saved to /memories/<NAME>.dat (16 bytes per event record)
enum MemEvt : uint8_t {
  ME_MET = 1, ME_TRADE = 2, ME_HELPED = 3, ME_ATTACKED = 4,
  ME_KILLED = 5, ME_LOYALTY = 6, ME_DEFECT = 7, ME_MEMORIAL = 8,
  ME_UNKNOWN_HURT = 9, ME_UNKNOWN_BOON = 10, ME_BIRTH = 11,
  ME_PROTECTED = 13, ME_KING_DEFEAT = 14
};

struct __attribute__((packed)) MemRecord {
  uint32_t tick;
  uint8_t  eventType;
  uint8_t  x;
  uint8_t  y;
  char     other[3];
  int16_t  value;
  uint8_t  tile;
  int8_t   loyaltyDelta;
  uint8_t  flags;
  uint8_t  checksum;
};
static_assert(sizeof(MemRecord) == 16, "MemRecord must be exactly 16 bytes");

static const size_t SD_MAX_FILE_BYTES = 32768; // 2048 records per AI before truncation

// ---------------- AI & BRAIN CONSTANTS ----------------
static const int MAX_AI     = 8;
static const int N_SOUNDS   = 8;
static const int N_CONCEPTS = 8;
enum Concept {
  C_FOOD = 0, C_WATER = 1, C_ENEMY = 2, C_PAIN = 3,
  C_FRIEND = 4, C_DANGER = 5, C_KILL = 6, C_CALM = 7
};
static const char* CONCEPT_NAME[N_CONCEPTS] = {
  "food", "watr", "enmy", "pain", "frnd", "dngr", "kill", "calm"
};

static const int Q_STATES  = 48;
static const int Q_ACTIONS = 14;
static const char* ACT_NAME[Q_ACTIONS] = {
  "seek", "drink", "flee", "hunt",
  "help", "expl",  "rest", "wait",
  "build","break", "dig",  "jump",
  "trade","defer"
};
static const char* ACT_ICON[Q_ACTIONS] = {
  "F","D","!","K","+","?","Z","-","B","X","V","J","T","C"
};

enum CarryItem : uint8_t { CARRY_NONE = 0, CARRY_WOOD = 1, CARRY_STONE = 2, CARRY_BERRY = 3 };
static const char* CARRY_NAMES[4] = { "-", "wood", "stone", "berry" };

struct Superstition { uint8_t x, y, strength, kind; }; // kind: 1=taboo, 2=shrine

struct AI {
  bool     alive;
  char     name[4];
  int      x, y, prevX, prevY;
  unsigned long moveStartMs;
  int8_t   facing;
  int      soul, age, birthTick;
  uint8_t  shape;
  uint16_t color;
  float    hunger, thirst, energy;
  float    aggression, curiosity, trust;
  int      hearing, fov;
  int      kills, helps, trades, foodEaten, recalls;
  char     lastAction[16];
  char     lastReason[28];
  uint8_t  seen[WORLD_H][WORLD_W / 8];
  // Brain (full precision RAM)
  int16_t  qtable[Q_STATES][Q_ACTIONS];
  int      prevState, prevAction;
  float    prevHunger, prevThirst, prevEnergy;
  int      prevSoul, currentState, chosenAction;
  bool     wasRandom;
  float    epsilon;
  // Language
  uint8_t  mouth[N_CONCEPTS];
  int8_t   ear[N_SOUNDS][N_CONCEPTS];
  int8_t   lastEmittedSound, lastEmittedConcept;
  int      lastEmittedTick;
  int8_t   lastHeardSound, lastHeardConcept;
  int      lastHeardTick;
  char     lastHeardFrom[4];
  // Social: relationships + sticky loyalty + kingship
  char     rel_name[6][4];
  int8_t   rel_trust[6];
  uint8_t  rel_loyalty[6];
  int      rel_lastTick[6];
  char     kingName[4];
  uint8_t  followerCount;
  bool     isKing;
  char     lastAttacker[4];
  int      lastAttackedTick;
  // Superstitions
  Superstition taboos[6];
  uint8_t  tabooCount;
  // SD stats
  uint32_t sdRecordCount;
  char     lastRecall[28];
  // Lineage & Inventory
  char     parent1[4], parent2[4];
  int      lastReproTick, numChildren;
  uint8_t  carrying;
  int      trapTick;
};

AI ais[MAX_AI];

struct MemorialData {
  bool    used;
  int     x, y, qState;
  int16_t qRow[Q_ACTIONS];
  uint8_t mouth[N_CONCEPTS];
  char    fromName[4];
  int     birthTick;
};
static const int MEMORIAL_MAX = 16;
MemorialData memorials[MEMORIAL_MAX];

static const int SOUL_POOL_MAX     = 2048;
static const int MONSTER_THRESHOLD = 200;
int soulPool = SOUL_POOL_MAX;

bool isMonster(int soul) { return soul >= MONSTER_THRESHOLD; }
bool isPassable(Tile t)  { return t==T_GRASS||t==T_SAND||t==T_FOREST||t==T_FOOD||t==T_MEMORIAL||t==T_PIT; }
bool isSolid(Tile t)     { return t==T_FOREST||t==T_STONE||t==T_BUILT; }
int  sgn(int v)          { return (v > 0) - (v < 0); }

// ---------------- SD CARD HELPERS ----------------
void sdEnsureDirs() {
  if (!sdReady) return;
  if (!SD.exists("/memories")) SD.mkdir("/memories");
}

void sdAppendMemory(AI& a, MemEvt evt, int x, int y, const char* other, int16_t val, uint8_t tile, int8_t loyDelta, uint8_t flags) {
  a.sdRecordCount++;
  if (!sdReady) return;
  MemRecord r;
  memset(&r, 0, sizeof(r));
  r.tick = (uint32_t)tick;
  r.eventType = (uint8_t)evt;
  r.x = (uint8_t)x; r.y = (uint8_t)y;
  if (other && other[0]) memcpy(r.other, other, 3);
  r.value = val; r.tile = tile; r.loyaltyDelta = loyDelta; r.flags = flags;
  uint8_t* bytes = (uint8_t*)&r;
  uint8_t ck = 0; for (int i = 0; i < 15; i++) ck ^= bytes[i];
  r.checksum = ck;

  char path[28];
  snprintf(path, sizeof(path), "/memories/%s.dat", a.name);
  File f = SD.open(path, FILE_APPEND);
  if (!f) return;
  if (f.size() >= SD_MAX_FILE_BYTES) {
    f.close();
    SD.remove(path); // truncate cyclic archive when huge
    a.sdRecordCount = 1;
    f = SD.open(path, FILE_WRITE);
    if (!f) return;
  }
  f.write(bytes, sizeof(MemRecord));
  f.close();
}

// On-demand quantized SD recall for a specific target AI
int sdRecallAI(AI& a, const char* target, int& encountersOut) {
  encountersOut = 0;
  if (!sdReady || !target || !target[0]) return 0;
  char path[28];
  snprintf(path, sizeof(path), "/memories/%s.dat", a.name);
  File f = SD.open(path, FILE_READ);
  if (!f) return 0;
  size_t sz = f.size();
  size_t totalRecs = sz / sizeof(MemRecord);
  size_t scan = min((size_t)48, totalRecs);
  int sentiment = 0;
  MemRecord r;
  for (size_t i = 0; i < scan; i++) {
    f.seek((totalRecs - 1 - i) * sizeof(MemRecord));
    if (f.read((uint8_t*)&r, sizeof(MemRecord)) != sizeof(MemRecord)) break;
    if (r.other[0]==target[0] && r.other[1]==target[1] && r.other[2]==target[2]) {
      encountersOut++;
      if (r.eventType==ME_TRADE||r.eventType==ME_HELPED||r.eventType==ME_PROTECTED||r.eventType==ME_LOYALTY)
        sentiment += 2;
      else if (r.eventType==ME_ATTACKED||r.eventType==ME_DEFECT)
        sentiment -= 3;
    }
  }
  f.close();
  if (encountersOut > 0) {
    a.recalls++;
    snprintf(a.lastRecall, sizeof(a.lastRecall), "%s:%dr(%+d)", target, encountersOut, sentiment);
  }
  return sentiment;
}

struct WorldSaveHeader {
  uint32_t magic;
  int32_t  tick;
  int32_t  soulPool;
};

void sdSaveWorld() {
  if (!sdReady) return;
  File f = SD.open("/world.sav", FILE_WRITE);
  if (!f) return;
  WorldSaveHeader hdr = { 0x54445732UL, tick, soulPool };
  f.write((uint8_t*)&hdr, sizeof(hdr));
  f.write((uint8_t*)world, sizeof(world));
  f.write((uint8_t*)cursedTile, sizeof(cursedTile));
  f.write((uint8_t*)memorials, sizeof(memorials));
  f.write((uint8_t*)ais, sizeof(ais));
  f.close();
  addEvent(TFT_CYAN, "SD saved t%d", tick);
}

bool sdLoadWorld() {
  if (!sdReady || !SD.exists("/world.sav")) return false;
  File f = SD.open("/world.sav", FILE_READ);
  if (!f) return false;
  WorldSaveHeader hdr;
  if (f.read((uint8_t*)&hdr, sizeof(hdr)) != sizeof(hdr) || hdr.magic != 0x54445732UL) {
    f.close(); return false;
  }
  tick = hdr.tick;
  soulPool = hdr.soulPool;
  f.read((uint8_t*)world, sizeof(world));
  f.read((uint8_t*)cursedTile, sizeof(cursedTile));
  f.read((uint8_t*)memorials, sizeof(memorials));
  f.read((uint8_t*)ais, sizeof(ais));
  f.close();
  unsigned long now = millis();
  for (int i = 0; i < MAX_AI; i++) ais[i].moveStartMs = now;
  addEvent(TFT_CYAN, "SD resumed t%d", tick);
  return true;
}

// ---------------- SENSING & WORLD GEN ----------------
void aiMarkSeen(AI& a, int x, int y) {
  if (x<0||x>=WORLD_W||y<0||y>=WORLD_H) return;
  a.seen[y][x >> 3] |= (1 << (x & 7));
}
bool aiHasSeen(const AI& a, int x, int y) {
  if (x<0||x>=WORLD_W||y<0||y>=WORLD_H) return false;
  return (a.seen[y][x >> 3] >> (x & 7)) & 1;
}

bool hasLOS(int x1, int y1, int x2, int y2) {
  int dx = abs(x2 - x1), dy = abs(y2 - y1);
  int sx = (x1 < x2) ? 1 : -1, sy = (y1 < y2) ? 1 : -1;
  int err = dx - dy, x = x1, y = y1, safety = dx + dy + 2;
  while (safety-- > 0) {
    if (x == x2 && y == y2) return true;
    int e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx)  { err += dx; y += sy; }
    if (x<0||x>=WORLD_W||y<0||y>=WORLD_H) return false;
    if ((x!=x2||y!=y2) && isSolid((Tile)world[y][x])) return false;
  }
  return false;
}

void aiPerceive(AI& a) {
  aiMarkSeen(a, a.x, a.y);
  for (int d = 1; d <= a.fov; d++) {
    for (int w = -d; w <= d; w++) {
      int dx = 0, dy = 0;
      switch (a.facing) {
        case 0: dx = w; dy = -d; break;
        case 1: dx = d; dy = w;  break;
        case 2: dx = w; dy = d;  break;
        case 3: dx = -d; dy = w; break;
      }
      int tx = a.x + dx, ty = a.y + dy;
      if (hasLOS(a.x, a.y, tx, ty)) aiMarkSeen(a, tx, ty);
    }
  }
}

void genWorld() {
  memset(cursedTile, 0, sizeof(cursedTile));
  for (int y = 0; y < WORLD_H; y++)
    for (int x = 0; x < WORLD_W; x++) world[y][x] = T_GRASS;
  for (int i = 0; i < 8; i++) {
    int cx = random(4, WORLD_W - 4), cy = random(4, WORLD_H - 4), r = random(2, 5);
    for (int y = cy - r; y <= cy + r; y++)
      for (int x = cx - r; x <= cx + r; x++)
        if ((x-cx)*(x-cx)+(y-cy)*(y-cy)<=r*r && x>=0&&x<WORLD_W&&y>=0&&y<WORLD_H) world[y][x] = T_WATER;
  }
  for (int i = 0; i < 12; i++) {
    int cx = random(2, WORLD_W - 2), cy = random(2, WORLD_H - 2), r = random(2, 6);
    for (int y = cy - r; y <= cy + r; y++)
      for (int x = cx - r; x <= cx + r; x++)
        if ((x-cx)*(x-cx)+(y-cy)*(y-cy)<=r*r && x>=0&&x<WORLD_W&&y>=0&&y<WORLD_H && world[y][x]==T_GRASS && random(0,100)<70)
          world[y][x] = T_FOREST;
  }
  for (int i = 0; i < 6; i++) {
    int cx = random(2, WORLD_W - 2), cy = random(2, WORLD_H - 2), r = random(1, 3);
    for (int y = cy - r; y <= cy + r; y++)
      for (int x = cx - r; x <= cx + r; x++)
        if ((x-cx)*(x-cx)+(y-cy)*(y-cy)<=r*r && x>=0&&x<WORLD_W&&y>=0&&y<WORLD_H && world[y][x]==T_GRASS)
          world[y][x] = T_STONE;
  }
  for (int y = 0; y < WORLD_H; y++)
    for (int x = 0; x < WORLD_W; x++) {
      if (world[y][x] != T_GRASS) continue;
      bool nearW = false;
      for (int dy = -1; dy <= 1 && !nearW; dy++)
        for (int dx = -1; dx <= 1; dx++) {
          int nx=x+dx, ny=y+dy;
          if (nx>=0&&nx<WORLD_W&&ny>=0&&ny<WORLD_H && world[ny][nx]==T_WATER) { nearW=true; break; }
        }
      if (nearW) world[y][x] = T_SAND;
    }
  for (int i = 0; i < 40; i++) {
    int x = random(0, WORLD_W), y = random(0, WORLD_H);
    if (world[y][x]==T_GRASS || world[y][x]==T_FOREST) world[y][x] = T_FOOD;
  }
  for (int i = 0; i < 18; i++) {
    int x = random(2, WORLD_W - 2), y = random(2, WORLD_H - 2);
    if (isPassable((Tile)world[y][x])) cursedTile[y][x] = 1;
  }
}

void makeName(char out[4]) {
  while (true) {
    out[0] = 'A' + random(0, 26);
    out[1] = 'A' + random(0, 26);
    out[2] = 'A' + random(0, 26);
    out[3] = 0;
    bool taken = false;
    for (int i = 0; i < MAX_AI; i++)
      if (ais[i].alive && strcmp(ais[i].name, out) == 0) { taken = true; break; }
    if (!taken) return;
  }
}

// ---------------- RELATIONSHIPS, LOYALTY & KINGS ----------------
int aiRelSlot(AI& a, const char* otherName) {
  for (int i = 0; i < 6; i++)
    if (a.rel_name[i][0] && strcmp(a.rel_name[i], otherName) == 0) return i;
  for (int i = 0; i < 6; i++)
    if (a.rel_name[i][0] == 0) {
      strncpy(a.rel_name[i], otherName, 3); a.rel_name[i][3] = 0;
      a.rel_trust[i] = 0; a.rel_loyalty[i] = 0; a.rel_lastTick[i] = tick;
      return i;
    }
  int oldest = 0;
  for (int i = 1; i < 6; i++) if (a.rel_lastTick[i] < a.rel_lastTick[oldest]) oldest = i;
  if (tick - a.rel_lastTick[oldest] > 500 && strcmp(a.rel_name[oldest], a.kingName) != 0) {
    strncpy(a.rel_name[oldest], otherName, 3); a.rel_name[oldest][3] = 0;
    a.rel_trust[oldest] = 0; a.rel_loyalty[oldest] = 0; a.rel_lastTick[oldest] = tick;
    return oldest;
  }
  return -1;
}

int aiRelTrust(const AI& a, const char* otherName) {
  for (int i = 0; i < 6; i++)
    if (a.rel_name[i][0] && strcmp(a.rel_name[i], otherName) == 0) return a.rel_trust[i];
  return 0;
}
int aiRelLoyalty(const AI& a, const char* otherName) {
  for (int i = 0; i < 6; i++)
    if (a.rel_name[i][0] && strcmp(a.rel_name[i], otherName) == 0) return a.rel_loyalty[i];
  return 0;
}

void aiRelUpdate(AI& a, const char* otherName, int trustDelta, int loyDelta = 0) {
  int s = aiRelSlot(a, otherName);
  if (s < 0) return;
  int effLoy = loyDelta;
  if (loyDelta < 0 && a.rel_loyalty[s] >= 55) effLoy = (int)(loyDelta * 0.45f); // sticky loyalty
  a.rel_trust[s]   = (int8_t)constrain((int)a.rel_trust[s] + trustDelta, -100, 100);
  a.rel_loyalty[s] = (uint8_t)constrain((int)a.rel_loyalty[s] + effLoy, 0, 100);
  a.rel_lastTick[s] = tick;

  if (socialEnabled && a.rel_loyalty[s] >= 55 && strcmp(a.kingName, otherName) != 0) {
    int curKL = a.kingName[0] ? aiRelLoyalty(a, a.kingName) : 0;
    if (!a.kingName[0] || a.rel_loyalty[s] > curKL + 12) {
      strncpy(a.kingName, otherName, 3); a.kingName[3] = 0;
      sdAppendMemory(a, ME_LOYALTY, a.x, a.y, otherName, a.rel_loyalty[s], world[a.y][a.x], (int8_t)effLoy, 2);
    }
  } else if (strcmp(a.kingName, otherName) == 0 && a.rel_loyalty[s] < 30) {
    a.kingName[0] = 0;
    sdAppendMemory(a, ME_DEFECT, a.x, a.y, otherName, a.rel_loyalty[s], world[a.y][a.x], (int8_t)effLoy, 2);
    addEvent(0xFD20, "%s defected from %s", a.name, otherName);
  }
}

void aiAddTaboo(AI& a, int x, int y, uint8_t kind) {
  for (int i = 0; i < a.tabooCount; i++) {
    if (abs((int)a.taboos[i].x - x) <= 1 && abs((int)a.taboos[i].y - y) <= 1) {
      a.taboos[i].strength = min(5, a.taboos[i].strength + 1);
      a.taboos[i].kind = kind;
      return;
    }
  }
  int slot = (a.tabooCount < 6) ? a.tabooCount++ : random(0, 6);
  a.taboos[slot] = { (uint8_t)x, (uint8_t)y, 1, kind };
}
bool aiIsTaboo(const AI& a, int x, int y) {
  for (int i = 0; i < a.tabooCount; i++) {
    if (a.taboos[i].kind != 1) continue;
    int dx = (int)a.taboos[i].x - x, dy = (int)a.taboos[i].y - y;
    if (dx*dx + dy*dy <= 2) return true;
  }
  return false;
}

// ---------------- LANGUAGE ----------------
void aiHear(AI& listener, const AI& speaker, int sound, int concept) {
  if (!listener.alive) return;
  listener.lastHeardSound   = sound;
  listener.lastHeardConcept = concept;
  listener.lastHeardTick    = tick;
  strncpy(listener.lastHeardFrom, speaker.name, 3); listener.lastHeardFrom[3] = 0;
  if (listener.ear[sound][concept] < 100) listener.ear[sound][concept]++;
  for (int c = 0; c < N_CONCEPTS; c++)
    if (c != concept && listener.ear[sound][c] > 0 && random(0, 4) == 0) listener.ear[sound][c]--;
  if (strcmp(listener.kingName, speaker.name) == 0 && random(0, 6) == 0)
    listener.mouth[concept] = speaker.mouth[concept]; // royal dialect drift
}

void aiEmit(AI& speaker, int concept) {
  if (!langEnabled || concept < 0 || concept >= N_CONCEPTS) return;
  int sound = speaker.mouth[concept];
  speaker.lastEmittedSound   = sound;
  speaker.lastEmittedConcept = concept;
  speaker.lastEmittedTick    = tick;
  for (int i = 0; i < MAX_AI; i++) {
    AI& l = ais[i];
    if (!l.alive || &l == &speaker) continue;
    int dx = l.x - speaker.x, dy = l.y - speaker.y;
    if (dx*dx + dy*dy <= l.hearing * l.hearing) aiHear(l, speaker, sound, concept);
  }
}

// ---------------- Q-LEARNING ----------------
int qComputeState(float hun, float thi, float ene, bool foodK, bool waterK, int threat) {
  int need = 0;
  float e = 1.0f - ene, maxN = max(hun, max(thi, e));
  if (maxN < 0.4f) need = 0;
  else if (hun == maxN) need = 1;
  else if (thi == maxN) need = 2;
  else need = 3;
  return constrain(need + threat * 4 + (foodK ? 12 : 0) + (waterK ? 24 : 0), 0, Q_STATES - 1);
}
int qBestAction(AI& a, int st) {
  int best = 0;
  for (int i = 1; i < Q_ACTIONS; i++) if (a.qtable[st][i] > a.qtable[st][best]) best = i;
  return best;
}
int qPickAction(AI& a, int st) {
  a.wasRandom = ((random(0, 10000) / 10000.0f) < a.epsilon);
  return a.wasRandom ? random(0, Q_ACTIONS) : qBestAction(a, st);
}
void qUpdate(AI& a, int st, int act, float reward, int nextSt, bool terminal) {
  const float alpha = 0.15f, gamma = 0.9f;
  float cur = a.qtable[st][act] / 10.0f;
  float target = terminal ? reward : (reward + gamma * (a.qtable[nextSt][qBestAction(a, nextSt)] / 10.0f));
  a.qtable[st][act] = (int16_t)constrain((int)((cur + alpha * (target - cur)) * 10.0f), -32000, 32000);
}

// ---------------- AI SPAWN / DEATH / MOVEMENT ----------------
void aiSpawn(int idx) {
  AI& a = ais[idx];
  memset(&a, 0, sizeof(a));
  makeName(a.name);
  for (int tries = 0; tries < 200; tries++) {
    int x = random(2, WORLD_W - 2), y = random(2, WORLD_H - 2);
    if (isPassable((Tile)world[y][x]) && world[y][x] != T_MEMORIAL) {
      bool occ = false;
      for (int i = 0; i < MAX_AI; i++) if (i!=idx && ais[i].alive && ais[i].x==x && ais[i].y==y) { occ=true; break; }
      if (!occ) { a.x = x; a.y = y; break; }
    }
  }
  a.alive = true; a.facing = random(0, 4);
  a.prevX = a.x; a.prevY = a.y; a.moveStartMs = millis();
  a.soul = 16; a.birthTick = tick; a.shape = random(0, 8);
  static const uint16_t PAL[12] = {0xF800,0xFD20,0xFFE0,0x07E0,0x07FF,0x8410,0xF81F,0xFBE0,0xFC9E,0xC618,0xE73C,0xFFFF};
  a.color = PAL[random(0, 12)];
  soulPool = max(0, soulPool - a.soul);
  a.hunger = 0.3f + random(0, 100)/500.0f;
  a.thirst = 0.2f + random(0, 100)/500.0f;
  a.energy = 0.8f + random(0, 100)/500.0f;
  a.aggression = random(0, 100)/100.0f;
  a.curiosity  = random(0, 100)/100.0f;
  a.trust      = random(0, 100)/100.0f;
  a.hearing = 3 + random(0, 6);
  a.fov = 2 + a.soul / 32;
  strcpy(a.lastAction, "born"); strcpy(a.lastReason, "newborn");
  int aggB = (int)(a.aggression * 10.0f), trsB = (int)(a.trust * 6.0f), curB = (int)(a.curiosity * 5.0f);
  for (int s = 0; s < Q_STATES; s++) {
    a.qtable[s][3] += aggB; a.qtable[s][4] += trsB; a.qtable[s][5] += curB; a.qtable[s][12] += trsB;
  }
  a.prevState = a.prevAction = a.currentState = a.chosenAction = -1;
  a.epsilon = 0.5f;
  for (int c = 0; c < N_CONCEPTS; c++) a.mouth[c] = random(0, N_SOUNDS);
  a.lastEmittedSound = a.lastEmittedConcept = a.lastHeardSound = a.lastHeardConcept = -1;
  a.lastEmittedTick = a.lastHeardTick = a.lastReproTick = a.lastAttackedTick = -9999;
  sdAppendMemory(a, ME_BIRTH, a.x, a.y, "", a.soul, world[a.y][a.x], 0, 0);
  aiPerceive(a);
}

void aiDie(AI& a, const char* cause) {
  bool famous = (a.soul > 48) || (a.kills >= 2) || (a.age > 1500) || (a.helps >= 3) || a.isKing;
  bool witness = false;
  for (int i = 0; i < MAX_AI; i++) {
    if (!ais[i].alive || &ais[i] == &a) continue;
    int dx = ais[i].x - a.x, dy = ais[i].y - a.y;
    if (dx*dx + dy*dy <= ais[i].hearing * ais[i].hearing) { witness = true; break; }
  }
  if (famous && witness && random(0, 100) < 60) {
    if (world[a.y][a.x]==T_GRASS || world[a.y][a.x]==T_SAND || world[a.y][a.x]==T_FOREST) {
      world[a.y][a.x] = T_MEMORIAL;
      int slot = -1;
      for (int i = 0; i < MEMORIAL_MAX; i++) if (!memorials[i].used) { slot = i; break; }
      if (slot < 0) slot = random(0, MEMORIAL_MAX);
      MemorialData& m = memorials[slot];
      m.used = true; m.x = a.x; m.y = a.y; m.qState = random(0, Q_STATES);
      memcpy(m.qRow, a.qtable[m.qState], sizeof(m.qRow));
      memcpy(m.mouth, a.mouth, sizeof(m.mouth));
      strncpy(m.fromName, a.name, 3); m.fromName[3] = 0; m.birthTick = tick;
    }
  }
  // Succession / fracture if king died
  if (a.isKing) {
    int heirIdx = -1, fCount = 0;
    for (int i = 0; i < MAX_AI; i++) {
      if (ais[i].alive && strcmp(ais[i].kingName, a.name) == 0) {
        fCount++;
        if (heirIdx < 0 || ais[i].soul > ais[heirIdx].soul) heirIdx = i;
      }
    }
    if (fCount >= 2 && heirIdx >= 0 && ais[heirIdx].soul >= 28 && random(0, 100) < 65) {
      ais[heirIdx].kingName[0] = 0;
      for (int i = 0; i < MAX_AI; i++)
        if (ais[i].alive && i != heirIdx && strcmp(ais[i].kingName, a.name) == 0) {
          strncpy(ais[i].kingName, ais[heirIdx].name, 3);
          aiRelUpdate(ais[i], ais[heirIdx].name, +10, +58);
        }
      addEvent(TFT_YELLOW, "Heir %s took %s's crown", ais[heirIdx].name, a.name);
    } else {
      for (int i = 0; i < MAX_AI; i++)
        if (ais[i].alive && strcmp(ais[i].kingName, a.name) == 0) ais[i].kingName[0] = 0;
      addEvent(0xFD20, "%s's court fractured", a.name);
    }
  }
  if (famous) addEvent(0xFBE0, "%s died (%s)", a.name, cause);
  soulPool += max(0, a.soul);
  a.alive = false; a.isKing = false; a.followerCount = 0;
}

bool aiTryMoveImpl(AI& a, int dx, int dy, bool canEscapePit) {
  if (dx == 0 && dy == 0) return false;
  if (!canEscapePit && world[a.y][a.x] == T_PIT) { if (a.trapTick == 0) a.trapTick = tick; return false; }
  int nx = a.x + dx, ny = a.y + dy;
  if (nx<0||nx>=WORLD_W||ny<0||ny>=WORLD_H || !isPassable((Tile)world[ny][nx])) return false;
  if (aiIsTaboo(a, nx, ny) && a.hunger < 0.85f && random(0, 100) < 80) {
    strcpy(a.lastAction, "avoid"); strcpy(a.lastReason, "superstition"); return false;
  }
  for (int i = 0; i < MAX_AI; i++)
    if (ais[i].alive && &ais[i]!=&a && ais[i].x==nx && ais[i].y==ny) return false;
  a.prevX = a.x; a.prevY = a.y; a.moveStartMs = millis();
  a.x = nx; a.y = ny;
  a.trapTick = (world[ny][nx] == T_PIT) ? tick : 0;
  if (abs(dx) > abs(dy)) a.facing = (dx > 0) ? 1 : 3; else a.facing = (dy > 0) ? 2 : 0;

  if (cursedTile[ny][nx] && random(0, 100) < 35) {
    int dmg = 2 + random(0, 5);
    a.soul -= dmg; soulPool += dmg;
    strcpy(a.lastAction, "hurt"); strcpy(a.lastReason, "??? unknown");
    aiAddTaboo(a, nx, ny, 1);
    sdAppendMemory(a, ME_UNKNOWN_HURT, nx, ny, "", -dmg, world[ny][nx], 0, 4);
    aiEmit(a, C_PAIN);
  }
  if (world[ny][nx] == T_FOOD) {
    world[ny][nx] = T_GRASS; a.hunger = max(0.0f, a.hunger - 0.6f);
    a.soul += 2; a.foodEaten++; soulPool = max(0, soulPool - 2);
    strcpy(a.lastAction, "ate berry"); aiEmit(a, C_FOOD);
    if (a.carrying == CARRY_NONE) a.carrying = CARRY_BERRY;
  }
  if (world[ny][nx] == T_MEMORIAL) {
    for (int i = 0; i < MEMORIAL_MAX; i++) {
      if (!memorials[i].used || memorials[i].x!=nx || memorials[i].y!=ny) continue;
      for (int ac = 0; ac < Q_ACTIONS; ac++)
        a.qtable[memorials[i].qState][ac] = (a.qtable[memorials[i].qState][ac] + memorials[i].qRow[ac]) / 2;
      for (int c = 0; c < N_CONCEPTS; c++) if (random(0, 3) == 0) a.mouth[c] = memorials[i].mouth[c];
      a.soul += 3;
      sdAppendMemory(a, ME_MEMORIAL, nx, ny, memorials[i].fromName, 3, T_MEMORIAL, 0, 0);
      addEvent(TFT_YELLOW, "%s read %s's mem", a.name, memorials[i].fromName);
      break;
    }
  }
  return true;
}
bool aiTryMove(AI& a, int dx, int dy) { return aiTryMoveImpl(a, dx, dy, false); }
bool aiTryJump(AI& a, int dx, int dy) { return aiTryMoveImpl(a, dx, dy, true); }

AI* aiNearest(AI& a, int r, bool weakerOnly = false) {
  AI* best = nullptr; int bestD = r*r + 1;
  for (int i = 0; i < MAX_AI; i++) {
    if (!ais[i].alive || &ais[i] == &a) continue;
    int dx = ais[i].x - a.x, dy = ais[i].y - a.y, d2 = dx*dx + dy*dy;
    if (d2 > r*r || (weakerOnly && ais[i].soul >= a.soul)) continue;
    if (!hasLOS(a.x, a.y, ais[i].x, ais[i].y)) continue;
    if (d2 < bestD) { bestD = d2; best = &ais[i]; }
  }
  return best;
}

bool aiFindTile(const AI& a, Tile wanted, int& ox, int& oy, int maxR = 20) {
  int bd = maxR*maxR + 1; bool found = false;
  for (int y = max(0, a.y-maxR); y <= min(WORLD_H-1, a.y+maxR); y++)
    for (int x = max(0, a.x-maxR); x <= min(WORLD_W-1, a.x+maxR); x++) {
      if (!aiHasSeen(a, x, y) || world[y][x] != wanted) continue;
      int d2 = (x-a.x)*(x-a.x) + (y-a.y)*(y-a.y);
      if (d2 < bd) { bd = d2; ox = x; oy = y; found = true; }
    }
  return found;
}

void aiStepToward(AI& a, int tx, int ty) {
  int dx = sgn(tx - a.x), dy = sgn(ty - a.y);
  if (!aiTryMove(a, dx, dy)) {
    if (abs(tx - a.x) >= abs(ty - a.y)) { if (!aiTryMove(a, dx, 0)) aiTryMove(a, 0, dy); }
    else { if (!aiTryMove(a, 0, dy)) aiTryMove(a, dx, 0); }
  }
}

void aiAttack(AI& a, AI& other) {
  if (strcmp(a.kingName, other.name) == 0 && aiRelLoyalty(a, other.name) >= 40) return;
  int dmg = max(1, a.soul / 8 + (int)(a.aggression * 4.0f));
  int self = max(1, other.soul / 10);
  other.soul -= dmg; a.soul -= self; soulPool += dmg + self;
  strncpy(other.lastAttacker, a.name, 3); other.lastAttacker[3] = 0;
  other.lastAttackedTick = tick;
  aiRelUpdate(other, a.name, -30, -35);
  aiRelUpdate(a, other.name, -10, -10);

  // Witness protection + King defeat crash
  if (socialEnabled) {
    for (int i = 0; i < MAX_AI; i++) {
      AI& w = ais[i];
      if (!w.alive || &w == &a || &w == &other) continue;
      int d2 = (w.x - a.x)*(w.x - a.x) + (w.y - a.y)*(w.y - a.y);
      if (d2 > (w.fov + 3)*(w.fov + 3)) continue;
      if (strcmp(w.lastAttacker, other.name) == 0 && tick - w.lastAttackedTick < 40) {
        aiRelUpdate(w, a.name, +24, +28);
        sdAppendMemory(w, ME_PROTECTED, a.x, a.y, a.name, 28, world[w.y][w.x], 28, 0);
      }
      if (other.isKing && dmg >= other.soul / 3 && strcmp(w.kingName, other.name) == 0) {
        int s = aiRelSlot(w, other.name);
        if (s >= 0) w.rel_loyalty[s] = (uint8_t)max(0, (int)w.rel_loyalty[s] - 35);
        aiRelUpdate(w, other.name, -12, -20);
        sdAppendMemory(w, ME_KING_DEFEAT, other.x, other.y, other.name, -35, world[other.y][other.x], -35, 2);
      }
    }
  }
  sdAppendMemory(a, ME_ATTACKED, other.x, other.y, other.name, dmg, world[other.y][other.x], -10, 0);
  aiEmit(a, C_ENEMY); aiEmit(other, C_PAIN);
  if (other.soul <= 0) {
    int gain = max(4, dmg);
    a.soul += gain; soulPool = max(0, soulPool - gain); a.kills++;
    strcpy(a.lastAction, "killed"); snprintf(a.lastReason, sizeof(a.lastReason), "%s +%d", other.name, gain);
    sdAppendMemory(a, ME_KILLED, other.x, other.y, other.name, gain, world[other.y][other.x], 0, 0);
    aiEmit(a, C_KILL); addEvent(0xF800, "%s killed %s", a.name, other.name);
    aiDie(other, "killed");
  } else {
    strcpy(a.lastAction, "attack"); snprintf(a.lastReason, sizeof(a.lastReason), "%s -%d", other.name, dmg);
  }
}

bool aiTrade(AI& a, AI& p) {
  if (!socialEnabled || abs(p.x - a.x) + abs(p.y - a.y) > 2) return false;
  int enc = 0;
  int sent = sdRecallAI(a, p.name, enc);
  if (enc > 0 && sent < -4 && random(0, 100) < 75) {
    strcpy(a.lastAction, "no trade"); snprintf(a.lastReason, sizeof(a.lastReason), "rem %s", p.name);
    return false;
  }
  if (a.carrying != CARRY_NONE && p.carrying != CARRY_NONE && a.carrying != p.carrying) {
    uint8_t tmp = a.carrying; a.carrying = p.carrying; p.carrying = tmp;
  } else if (a.carrying == CARRY_BERRY && p.hunger > 0.45f) {
    a.carrying = CARRY_NONE; p.hunger = max(0.0f, p.hunger - 0.35f);
    a.soul += 2; p.soul = max(10, p.soul - 2);
  } else {
    // Map knowledge swap
    for (int y = 0; y < WORLD_H; y += 2)
      for (int b = 0; b < WORLD_W/8; b++) {
        uint8_t m = a.seen[y][b] | p.seen[y][b];
        a.seen[y][b] = m; p.seen[y][b] = m;
      }
    a.soul++; p.soul++;
  }
  a.trades++; p.trades++;
  aiRelUpdate(a, p.name, +14, +6); aiRelUpdate(p, a.name, +14, +6);
  sdAppendMemory(a, ME_TRADE, a.x, a.y, p.name, 2, world[a.y][a.x], 6, 0);
  sdAppendMemory(p, ME_TRADE, p.x, p.y, a.name, 2, world[p.y][p.x], 6, 0);
  strcpy(a.lastAction, "traded"); snprintf(a.lastReason, sizeof(a.lastReason), "with %s", p.name);
  aiEmit(a, C_FRIEND);
  addEvent(0x07E0, "%s <-> %s traded", a.name, p.name);
  return true;
}

void aiTick(AI& a) {
  if (!a.alive) return;
  a.age++; a.fov = constrain(2 + a.soul / 32, 2, 10);
  a.hunger = min(1.0f, a.hunger + 0.0008f);
  a.thirst = min(1.0f, a.thirst + 0.0010f);
  a.energy = isNight() ? max(0.0f, a.energy - 0.0006f) : min(1.0f, a.energy + 0.0003f);
  if (a.age % 50 == 0 && a.soul > 16) { a.soul--; soulPool++; }
  if (a.hunger > 0.95f && a.age % 30 == 0) { a.soul--; soulPool++; }
  if (a.thirst > 0.95f && a.age % 20 == 0) { a.soul--; soulPool++; }

  if (paramRandomHurtRate > 0) {
    int roll = random(0, 20000);
    if (roll < paramRandomHurtRate) {
      int dmg = 2 + random(0, 6);
      a.soul -= dmg; soulPool += dmg;
      strcpy(a.lastAction, "hurt"); strcpy(a.lastReason, "??? unknown");
      aiAddTaboo(a, a.x, a.y, 1);
      sdAppendMemory(a, ME_UNKNOWN_HURT, a.x, a.y, "", -dmg, world[a.y][a.x], 0, 4);
      aiEmit(a, C_PAIN);
    } else if (roll == 19999) {
      int boon = 4 + random(0, 7); a.soul += boon;
      aiAddTaboo(a, a.x, a.y, 2);
      sdAppendMemory(a, ME_UNKNOWN_BOON, a.x, a.y, "", boon, world[a.y][a.x], 0, 4);
      addEvent(0x07FF, "%s: ??? boon +%d", a.name, boon);
    } else if (roll == 19998 && a.age > 900 && random(0, 12) == 0) {
      a.soul = 0; aiDie(a, "???"); return;
    }
  }

  if (a.soul <= 0) {
    if (learningEnabled && a.prevState >= 0 && a.prevAction >= 0)
      qUpdate(a, a.prevState, a.prevAction, -20.0f, 0, true);
    aiDie(a, "soul0"); return;
  }

  aiPerceive(a);

  // Proximity trust, fear & social proof loyalty
  if (a.age % 10 == 0) {
    for (int i = 0; i < MAX_AI; i++) {
      if (!ais[i].alive || &ais[i] == &a) continue;
      int dx = ais[i].x - a.x, dy = ais[i].y - a.y;
      if (dx*dx + dy*dy <= a.fov * a.fov) {
        int lb = socialEnabled ? 1 : 0;
        if (socialEnabled && ais[i].soul > a.soul * 1.45f) lb += 3;
        if (socialEnabled && ais[i].followerCount >= 1) {
          for (int k = 0; k < MAX_AI; k++)
            if (ais[k].alive && strcmp(ais[k].kingName, ais[i].name) == 0 && aiRelTrust(a, ais[k].name) >= 15) {
              lb += 6; break;
            }
        }
        aiRelUpdate(a, ais[i].name, +1, lb);
      }
    }
  }

  AI* enemy = aiNearest(a, a.fov, false);
  AI* prey  = aiNearest(a, a.fov, true);
  int fx=0, fy=0, wx=0, wy=0;
  bool foundFood  = aiFindTile(a, T_FOOD, fx, fy, a.fov + 10);
  bool foundWater = aiFindTile(a, T_WATER, wx, wy, a.fov + 10);
  int threat = 0;
  if (enemy && enemy->soul > a.soul * 1.3f && strcmp(enemy->name, a.kingName) != 0) threat = 2;
  else if (prey && strcmp(prey->name, a.kingName) != 0) threat = 1;

  int st = qComputeState(a.hunger, a.thirst, a.energy, foundFood, foundWater, threat);
  a.currentState = st;
  a.epsilon = (a.age < 200) ? 0.5f : (a.age < 600) ? 0.25f : (a.age < 1500) ? 0.1f : 0.05f;

  if (learningEnabled && a.prevState >= 0 && a.prevAction >= 0) {
    float r = 0.1f + (a.prevHunger - a.hunger)*4.0f + (a.prevThirst - a.thirst)*4.0f
            + (a.energy - a.prevEnergy)*1.5f + (a.soul - a.prevSoul)*1.2f;
    if (a.prevAction == 3) r += a.aggression;
    else if (a.prevAction == 4 || a.prevAction == 12) r += a.trust * 0.8f;
    else if (a.prevAction == 5) r += a.curiosity * 0.4f;
    qUpdate(a, a.prevState, a.prevAction, r, st, false);
  }

  int act = learningEnabled ? qPickAction(a, st) : qBestAction(a, st);
  AI* myKing = nullptr;
  if (a.kingName[0])
    for (int i = 0; i < MAX_AI; i++) if (ais[i].alive && strcmp(ais[i].name, a.kingName) == 0) { myKing = &ais[i]; break; }

  // Follower defense override
  if (myKing && socialEnabled && myKing->lastAttacker[0] && tick - myKing->lastAttackedTick < 25) {
    for (int i = 0; i < MAX_AI; i++) {
      if (ais[i].alive && strcmp(ais[i].name, myKing->lastAttacker) == 0) {
        if (abs(ais[i].x - a.x) + abs(ais[i].y - a.y) <= 1) aiAttack(a, ais[i]);
        else { aiStepToward(a, ais[i].x, ais[i].y); strcpy(a.lastAction, "defend"); }
        a.chosenAction = 3; a.prevState = st; a.prevAction = 3;
        a.prevHunger = a.hunger; a.prevThirst = a.thirst; a.prevEnergy = a.energy; a.prevSoul = a.soul;
        return;
      }
    }
  }

  a.chosenAction = act; a.prevState = st; a.prevAction = act;
  a.prevHunger = a.hunger; a.prevThirst = a.thirst; a.prevEnergy = a.energy; a.prevSoul = a.soul;

  switch (act) {
    case 0: if (foundFood) { aiStepToward(a, fx, fy); strcpy(a.lastAction, "seek food"); }
            else { aiTryMove(a, random(-1, 2), random(-1, 2)); strcpy(a.lastAction, "wander"); } break;
    case 1: {
      bool nw = false;
      for (int dy=-1; dy<=1 && !nw; dy++) for (int dx=-1; dx<=1; dx++) {
        int nx=a.x+dx, ny=a.y+dy;
        if (nx>=0&&nx<WORLD_W&&ny>=0&&ny<WORLD_H && world[ny][nx]==T_WATER) nw = true;
      }
      if (nw) { a.thirst = max(0.0f, a.thirst - 0.7f); a.soul++; strcpy(a.lastAction, "drank"); aiEmit(a, C_WATER); }
      else if (foundWater) { aiStepToward(a, wx, wy); strcpy(a.lastAction, "seek water"); }
      else { aiTryMove(a, random(-1, 2), random(-1, 2)); strcpy(a.lastAction, "wander"); }
      break;
    }
    case 2: if (enemy) { aiTryMove(a, -sgn(enemy->x - a.x), -sgn(enemy->y - a.y)); strcpy(a.lastAction, "flee"); aiEmit(a, C_DANGER); }
            else { aiTryMove(a, random(-1, 2), random(-1, 2)); strcpy(a.lastAction, "scatter"); } break;
    case 3: if (prey && strcmp(prey->name, a.kingName) != 0) {
              if (abs(prey->x - a.x) + abs(prey->y - a.y) <= 1) aiAttack(a, *prey);
              else { aiStepToward(a, prey->x, prey->y); strcpy(a.lastAction, "stalk"); }
            } else { aiTryMove(a, random(-1, 2), random(-1, 2)); strcpy(a.lastAction, "hunt?"); } break;
    case 4: if (prey || enemy) {
              AI* t = prey ? prey : enemy; aiStepToward(a, t->x, t->y);
              if (abs(t->x-a.x)+abs(t->y-a.y)<=1 && a.soul>20) {
                a.soul--; t->soul++; a.helps++; aiRelUpdate(*t, a.name, +15, +12); aiRelUpdate(a, t->name, +5, +2);
                sdAppendMemory(a, ME_HELPED, t->x, t->y, t->name, 1, world[a.y][a.x], 2, 0);
                strcpy(a.lastAction, "helped"); aiEmit(a, C_FRIEND);
              }
            } else strcpy(a.lastAction, "idle"); break;
    case 5: aiTryMove(a, random(-1, 2), random(-1, 2)); strcpy(a.lastAction, "explore"); break;
    case 6: a.energy = min(1.0f, a.energy + 0.025f); strcpy(a.lastAction, "rest"); break;
    case 7: strcpy(a.lastAction, "wait"); break;
    case 8: {
      int tx=a.x+(a.facing==1?1:a.facing==3?-1:0), ty=a.y+(a.facing==2?1:a.facing==0?-1:0);
      if ((a.carrying==CARRY_WOOD||a.carrying==CARRY_STONE) && tx>=0&&tx<WORLD_W&&ty>=0&&ty<WORLD_H && world[ty][tx]==T_GRASS) {
        world[ty][tx] = T_BUILT; a.carrying = CARRY_NONE; strcpy(a.lastAction, "built");
      } else strcpy(a.lastAction, "build?"); break;
    }
    case 9: {
      int tx=a.x+(a.facing==1?1:a.facing==3?-1:0), ty=a.y+(a.facing==2?1:a.facing==0?-1:0);
      if (tx>=0&&tx<WORLD_W&&ty>=0&&ty<WORLD_H && (world[ty][tx]==T_FOREST||world[ty][tx]==T_STONE||world[ty][tx]==T_BUILT||world[ty][tx]==T_PIT)) {
        Tile old = (Tile)world[ty][tx]; world[ty][tx] = T_GRASS; a.soul += (old==T_STONE?2:1);
        if (a.carrying==CARRY_NONE) a.carrying = (old==T_STONE?CARRY_STONE:CARRY_WOOD);
        strcpy(a.lastAction, "broke");
      } else strcpy(a.lastAction, "break?"); break;
    }
    case 10: {
      int tx=a.x+(a.facing==1?1:a.facing==3?-1:0), ty=a.y+(a.facing==2?1:a.facing==0?-1:0);
      if (tx>=0&&tx<WORLD_W&&ty>=0&&ty<WORLD_H && (world[ty][tx]==T_GRASS||world[ty][tx]==T_SAND)) {
        world[ty][tx] = T_PIT; a.energy = max(0.0f, a.energy - 0.08f); strcpy(a.lastAction, "dug pit");
      } else strcpy(a.lastAction, "dig?"); break;
    }
    case 11: {
      int dx=(a.facing==1?1:a.facing==3?-1:0), dy=(a.facing==2?1:a.facing==0?-1:0);
      int lx=a.x+2*dx, ly=a.y+2*dy; a.energy = max(0.0f, a.energy - 0.08f);
      if (lx>=0&&lx<WORLD_W&&ly>=0&&ly<WORLD_H && isPassable((Tile)world[ly][lx])) {
        a.prevX=a.x; a.prevY=a.y; a.moveStartMs=millis(); a.x=lx; a.y=ly; strcpy(a.lastAction, "jumped");
      } else if (aiTryJump(a, dx, dy)) strcpy(a.lastAction, "hop"); else strcpy(a.lastAction, "jump?"); break;
    }
    case 12: {
      AI* partner = enemy ? enemy : prey;
      if (partner && socialEnabled) {
        if (abs(partner->x - a.x) + abs(partner->y - a.y) <= 2) aiTrade(a, *partner);
        else { aiStepToward(a, partner->x, partner->y); strcpy(a.lastAction, "seek trade"); }
      } else strcpy(a.lastAction, "trade?"); break;
    }
    case 13: {
      if (myKing) {
        if (abs(myKing->x - a.x) + abs(myKing->y - a.y) > 2) {
          aiStepToward(a, myKing->x, myKing->y); strcpy(a.lastAction, "follow king");
        } else {
          if (a.carrying == CARRY_BERRY && myKing->hunger > 0.3f) {
            a.carrying = CARRY_NONE; myKing->hunger = max(0.0f, myKing->hunger - 0.35f); myKing->soul++;
            strcpy(a.lastAction, "tribute");
          } else strcpy(a.lastAction, "attend");
        }
      } else if (a.isKing) { aiEmit(a, C_CALM); strcpy(a.lastAction, "rally"); }
      else strcpy(a.lastAction, "defer"); break;
    }
  }
}

void recomputeKingdoms() {
  bool wasKing[MAX_AI];
  for (int i = 0; i < MAX_AI; i++) { wasKing[i] = ais[i].isKing; ais[i].followerCount = 0; ais[i].isKing = false; }
  for (int i = 0; i < MAX_AI; i++) {
    if (!ais[i].alive || !ais[i].kingName[0]) continue;
    for (int k = 0; k < MAX_AI; k++)
      if (ais[k].alive && k != i && strcmp(ais[k].name, ais[i].kingName) == 0) { ais[k].followerCount++; break; }
  }
  for (int i = 0; i < MAX_AI; i++) {
    if (ais[i].alive && ais[i].followerCount >= 2) {
      ais[i].isKing = true; ais[i].kingName[0] = 0;
      if (!wasKing[i]) addEvent(TFT_YELLOW, "Crown: King %s (%d)", ais[i].name, ais[i].followerCount);
    }
  }
}

void worldTick() {
  tick++;
  if (paramFoodRegrowRate > 0 && tick % paramFoodRegrowRate == 0)
    for (int i = 0; i < 3; i++) {
      int x = random(0, WORLD_W), y = random(0, WORLD_H);
      if (world[y][x] == T_GRASS || world[y][x] == T_FOREST) world[y][x] = T_FOOD;
    }
  if (paramMemorialDecay > 0 && tick % paramMemorialDecay == 0)
    for (int y = 0; y < WORLD_H; y++) for (int x = 0; x < WORLD_W; x++)
      if (world[y][x] == T_MEMORIAL && random(0, 100) < 10) world[y][x] = T_GRASS;

  for (int i = 0; i < MAX_AI; i++) aiTick(ais[i]);
  recomputeKingdoms();

  int aliveCnt = 0; for (int i = 0; i < MAX_AI; i++) if (ais[i].alive) aliveCnt++;
  for (int i = 0; i < MAX_AI; i++)
    if (!ais[i].alive && soulPool >= 16 && aliveCnt < paramPopulationCap) { aiSpawn(i); aliveCnt++; }

  if (sdReady && tick % 500 == 0) sdSaveWorld();
}

// ---------------- RENDERING (ZERO-FLICKER SPRITES) ----------------
int selectedAI = 0;
enum PanelMode { PANEL_AI, PANEL_SETTINGS };
PanelMode panelMode = PANEL_AI;
int settingsIdx = 0;
bool followMode = false, showFog = false, showFOV = true, showHearing = false, showSound = true, showBonds = true;

uint16_t darken(uint16_t c, int amt) {
  int r = max(0, ((c >> 11) & 0x1F) - amt);
  int g = max(0, ((c >> 5)  & 0x3F) - amt*2);
  int b = max(0, (c & 0x1F) - amt);
  return (r << 11) | (g << 5) | b;
}

void layoutPanels() {
  PAN_W = panelOpen ? PAN_W_OPEN : 0;
  PAN_X = SW - PAN_W;
  MAP_W = panelOpen ? (SW - PAN_W - 2) : SW;
  MAP_X = 0; PAN_Y = MAP_Y = HUD_H; PAN_H = MAP_H = SH - HUD_H;
}
void allocMapSprites() {
  mapSprite.setColorDepth(16); mapSprite.createSprite(MAP_W, MAP_H);
  panelSprite.setColorDepth(16); panelSprite.createSprite(PAN_W_OPEN, SH - HUD_H);
  hudSprite.setColorDepth(16); hudSprite.createSprite(SW, HUD_H);
}
void freeMapSprites() { mapSprite.deleteSprite(); panelSprite.deleteSprite(); hudSprite.deleteSprite(); }

void renderHUD() {
  hudSprite.fillSprite(TFT_BLACK);
  hudSprite.setTextSize(1);
  hudSprite.setTextColor(isNight() ? 0x3DDF : TFT_WHITE, TFT_BLACK);
  int alive = 0; for (int i = 0; i < MAX_AI; i++) if (ais[i].alive) alive++;
  const char* spd[] = {"PAUSE","0.5x","1x","2x","5x"};
  hudSprite.setCursor(2, 2);
  hudSprite.printf("t%05d p%d pl%d %s %s%s", tick, alive, soulPool, spd[speedIdx], isNight()?"NGT":"DAY", sdReady?" SD":"");
  int latest = (eventHead - 1 + EVENT_LOG_SIZE) % EVENT_LOG_SIZE;
  if (eventLog[latest].text[0]) {
    hudSprite.setTextColor(eventLog[latest].col, TFT_BLACK);
    hudSprite.setCursor(2, 12); hudSprite.print(eventLog[latest].text);
  }
  hudSprite.drawFastHLine(0, HUD_H - 1, SW, TFT_DARKGREY);
  hudSprite.pushSprite(0, 0);
}

void renderMap() {
  mapSprite.fillSprite(TFT_BLACK);
  int nd = isNight() ? 4 : 0;
  int vtx = tilesVisX(), vty = tilesVisY();
  float ppx = tilePpx(), ppy = tilePpy();
  camX = constrain(camX, 0, max(0, WORLD_W - vtx));
  camY = constrain(camY, 0, max(0, WORLD_H - vty));
  for (int vy = 0; vy < vty; vy++) {
    int wy = camY + vy; if (wy < 0 || wy >= WORLD_H) continue;
    int sy = (int)(vy * ppy), sh = (int)((vy+1) * ppy) - sy;
    for (int vx = 0; vx < vtx; vx++) {
      int wx = camX + vx; if (wx < 0 || wx >= WORLD_W) continue;
      int sx = (int)(vx * ppx), sw = (int)((vx+1) * ppx) - sx;
      uint16_t c = TILE_COLOR[world[wy][wx]];
      if (nd) c = darken(c, nd);
      mapSprite.fillRect(sx, sy, sw, sh, c);
    }
  }
  if (showBonds) {
    for (int i = 0; i < MAX_AI; i++) {
      if (!ais[i].alive || !ais[i].kingName[0]) continue;
      for (int k = 0; k < MAX_AI; k++) {
        if (!ais[k].alive || strcmp(ais[k].name, ais[i].kingName) != 0) continue;
        int x1=(int)((ais[i].x-camX)*ppx+ppx/2), y1=(int)((ais[i].y-camY)*ppy+ppy/2);
        int x2=(int)((ais[k].x-camX)*ppx+ppx/2), y2=(int)((ais[k].y-camY)*ppy+ppy/2);
        mapSprite.drawLine(x1, y1, x2, y2, TFT_YELLOW);
      }
    }
  }
  unsigned long nowMs = millis(); int tickMs = max(1, currentSpeedMs());
  for (int i = 0; i < MAX_AI; i++) {
    if (!ais[i].alive) continue;
    float t = constrain((nowMs - ais[i].moveStartMs) / (float)tickMs, 0.0f, 1.0f);
    float fx = ais[i].prevX + (ais[i].x - ais[i].prevX) * t;
    float fy = ais[i].prevY + (ais[i].y - ais[i].prevY) * t;
    int cx = (int)((fx - camX) * ppx + ppx/2), cy = (int)((fy - camY) * ppy + ppy/2);
    if (cx < -10 || cx > MAP_W + 10 || cy < -10 || cy > MAP_H + 10) continue;
    int r = max(2, min((int)(min(ppx, ppy)/2 + 1), ais[i].soul / 12 + 2));
    mapSprite.fillCircle(cx, cy, r, ais[i].color);
    mapSprite.drawCircle(cx, cy, r, (i == selectedAI) ? TFT_YELLOW : TFT_BLACK);
    if (ais[i].isKing) mapSprite.fillRect(cx - 2, cy - r - 3, 5, 2, TFT_YELLOW);
  }
  mapSprite.pushSprite(MAP_X, MAP_Y);
}

void renderPanel() {
  if (!panelOpen) return;
  panelSprite.fillSprite(TFT_BLACK);
  panelSprite.setTextSize(1);
  if (panelMode == PANEL_SETTINGS) {
    panelSprite.setTextColor(TFT_CYAN, TFT_BLACK);
    panelSprite.setCursor(4, 4); panelSprite.print("SETTINGS");
    const char* spd[] = {"PAU","0.5","1x","2x","5x"};
    char vals[10][8];
    snprintf(vals[0], 8, "%dt", zoomLevels[zoomIdx]);
    snprintf(vals[1], 8, "%s", spd[speedIdx]);
    snprintf(vals[2], 8, "%s", followMode ? "ON" : "OFF");
    snprintf(vals[3], 8, "%s", showFOV ? "ON" : "OFF");
    snprintf(vals[4], 8, "%s", showFog ? "ON" : "OFF");
    snprintf(vals[5], 8, "%s", showBonds ? "ON" : "OFF");
    snprintf(vals[6], 8, "%s", learningEnabled ? "ON" : "OFF");
    snprintf(vals[7], 8, "%s", langEnabled ? "ON" : "OFF");
    snprintf(vals[8], 8, "%s", socialEnabled ? "ON" : "OFF");
    snprintf(vals[9], 8, "NOW");
    const char* lbls[10] = {"Zoom","Speed","Follow","FOV","Fog","Bonds","Q-Lrn","Lang","Social","SaveSD"};
    for (int i = 0; i < 10; i++) {
      int y = 20 + i * 16;
      bool sel = (i == settingsIdx);
      if (sel) panelSprite.fillRect(2, y - 2, PAN_W - 4, 13, 0x1947);
      panelSprite.setTextColor(sel ? TFT_YELLOW : TFT_LIGHTGREY, sel ? 0x1947 : TFT_BLACK);
      panelSprite.setCursor(4, y); panelSprite.printf("%c%-6s", sel ? '>' : ' ', lbls[i]);
      panelSprite.setTextColor(sel ? TFT_CYAN : TFT_DARKGREY, sel ? 0x1947 : TFT_BLACK);
      panelSprite.setCursor(PAN_W - 38, y); panelSprite.printf("[%s]", vals[i]);
    }
    panelSprite.setTextColor(TFT_DARKGREY, TFT_BLACK);
    panelSprite.setCursor(4, PAN_H - 10); panelSprite.print("W/S:nav A/D:set M:ok");
    panelSprite.pushSprite(PAN_X, PAN_Y);
    return;
  }

  AI& a = ais[selectedAI];
  panelSprite.setTextSize(2);
  panelSprite.setTextColor(a.alive ? TFT_CYAN : TFT_RED, TFT_BLACK);
  panelSprite.setCursor(4, 2); panelSprite.print(a.name);
  panelSprite.setTextSize(1);
  if (a.alive) {
    panelSprite.setTextColor(TFT_WHITE, TFT_BLACK);
    panelSprite.setCursor(4, 22); panelSprite.printf("S%d %.1fd", a.soul, a.age/2400.0f);
    panelSprite.setCursor(4, 32); panelSprite.printf("k%d h%d t%d", a.kills, a.helps, a.trades);
    panelSprite.setTextColor(a.isKing ? TFT_YELLOW : TFT_LIGHTGREY, TFT_BLACK);
    panelSprite.setCursor(4, 42);
    if (a.isKing) panelSprite.printf("KING (%d loy)", a.followerCount);
    else if (a.kingName[0]) panelSprite.printf("loyal->%s", a.kingName);
    else panelSprite.printf("carry:%s", CARRY_NAMES[a.carrying]);
    panelSprite.setTextColor(TFT_CYAN, TFT_BLACK);
    panelSprite.setCursor(4, 56); panelSprite.printf("SD: %lu rec", (unsigned long)a.sdRecordCount);
    panelSprite.setCursor(4, 66); panelSprite.printf("hun%2d thi%2d", (int)(a.hunger*99), (int)(a.thirst*99));
    panelSprite.setCursor(4, 76); panelSprite.printf("ene%2d fov%d", (int)(a.energy*99), a.fov);
    panelSprite.setTextColor(TFT_GREEN, TFT_BLACK);
    panelSprite.setCursor(4, 92); panelSprite.printf(">%s", a.lastAction);
    panelSprite.setTextColor(TFT_DARKGREY, TFT_BLACK);
    panelSprite.setCursor(4, 102); panelSprite.print(a.lastReason);
    if (a.lastRecall[0]) {
      panelSprite.setTextColor(TFT_YELLOW, TFT_BLACK);
      panelSprite.setCursor(4, 118); panelSprite.printf("mem:%s", a.lastRecall);
    }
    panelSprite.setTextColor(TFT_DARKGREY, TFT_BLACK);
    panelSprite.setCursor(4, PAN_H - 10); panelSprite.printf("@%d,%d R:det M:set", a.x, a.y);
  }
  panelSprite.pushSprite(PAN_X, PAN_Y);
}

void renderExpandedView() {
  fullSprite.fillSprite(0x0841);
  AI& a = ais[selectedAI];
  // Top banner
  fullSprite.fillRect(0, 0, SW, 24, 0x10A3);
  fullSprite.setTextSize(2);
  fullSprite.setTextColor(a.alive ? TFT_CYAN : TFT_RED, 0x10A3);
  fullSprite.setCursor(4, 4); fullSprite.print(a.name);
  fullSprite.setTextSize(1);
  fullSprite.setTextColor(TFT_YELLOW, 0x10A3);
  fullSprite.setCursor(52, 4); fullSprite.printf("SOUL %d  %.2fd", a.soul, a.age / 2400.0f);
  fullSprite.setTextColor(TFT_LIGHTGREY, 0x10A3);
  fullSprite.setCursor(52, 14);
  if (a.isKing) fullSprite.printf("KING (%d followers)", a.followerCount);
  else if (a.kingName[0]) fullSprite.printf("loyal -> %s", a.kingName);
  else fullSprite.printf("action: %s", a.lastAction);

  // 7-Tab header bar
  const char* tabs[7] = {"POV","DNA","NED","BRN","REL","LNG","SD"};
  int tw = SW / 7;
  for (int i = 0; i < 7; i++) {
    bool sel = (i == rSectionIdx);
    fullSprite.fillRect(i * tw + 1, 25, tw - 2, 12, sel ? 0x2189 : 0x0862);
    fullSprite.setTextColor(sel ? TFT_CYAN : TFT_DARKGREY, sel ? 0x2189 : 0x0862);
    fullSprite.setCursor(i * tw + 10, 27); fullSprite.print(tabs[i]);
  }

  int y0 = 40, ch = SH - 54;
  if (!a.alive) {
    fullSprite.setTextColor(TFT_RED, 0x0841);
    fullSprite.setCursor(110, 115); fullSprite.print("SIGNAL LOST");
  } else if (rSectionIdx == 0) {
    // 0: Doom-style 1st-person raycaster POV
    int ox = 4, w = SW - 8, h = ch - 18, hz = h / 2;
    fullSprite.fillRect(ox, y0, w, hz, isNight() ? 0x0883 : 0x19CE);
    fullSprite.fillRect(ox, y0 + hz, w, h - hz, isNight() ? 0x0902 : 0x1A64);
    float dx = (a.facing==1?1:a.facing==3?-1:0), dy = (a.facing==2?1:a.facing==0?-1:0);
    float px = -dy * 0.66f, py = dx * 0.66f;
    float posX = a.x + 0.5f, posY = a.y + 0.5f;
    for (int x = 0; x < w; x += 2) {
      float cam = 2.0f * x / w - 1.0f;
      float rdx = dx + px * cam, rdy = dy + py * cam;
      int mx = (int)posX, my = (int)posY;
      float ddx = (rdx == 0) ? 1e20f : fabsf(1.0f / rdx);
      float ddy = (rdy == 0) ? 1e20f : fabsf(1.0f / rdy);
      int sx = rdx < 0 ? -1 : 1, sy = rdy < 0 ? -1 : 1;
      float sdx = rdx < 0 ? (posX - mx) * ddx : (mx + 1.0f - posX) * ddx;
      float sdy = rdy < 0 ? (posY - my) * ddy : (my + 1.0f - posY) * ddy;
      bool hit = false; int side = 0; Tile ht = T_GRASS;
      for (int st = 0; st < 16 && !hit; st++) {
        if (sdx < sdy) { sdx += ddx; mx += sx; side = 0; }
        else { sdy += ddy; my += sy; side = 1; }
        if (mx < 0 || mx >= WORLD_W || my < 0 || my >= WORLD_H) break;
        Tile t = (Tile)world[my][mx];
        if (t == T_FOREST || t == T_STONE || t == T_BUILT) { hit = true; ht = t; }
      }
      if (hit) {
        float dist = max(0.1f, (side == 0) ? (sdx - ddx) : (sdy - ddy));
        int lh = min(h, (int)(h / dist));
        uint16_t col = (ht == T_FOREST) ? 0x1B85 : (ht == T_STONE) ? 0x6B8F : 0x9D36;
        if (side) col = darken(col, 3);
        fullSprite.fillRect(ox + x, y0 + hz - lh / 2, 2, lh, col);
      }
    }
    fullSprite.setTextColor(TFT_GREEN, 0x0841);
    fullSprite.setCursor(6, y0 + h + 4); fullSprite.printf("> %s (%s)", a.lastAction, a.lastReason);
  } else if (rSectionIdx == 1) {
    // 1: Neural DNA & Polar Trait Genome
    int cx = SW / 2, cy = y0 + ch / 2 - 4, maxR = min(SW, ch) / 2 - 10;
    fullSprite.drawCircle(cx, cy, maxR, 0x1125);
    fullSprite.drawCircle(cx, cy, maxR * 2 / 3, 0x1125);
    fullSprite.drawCircle(cx, cy, maxR / 3, 0x1125);
    int ramCells = constrain(a.soul / 10 + 2, 2, 16);
    int nodes = max(6, ramCells + 2);
    int px[20], py[20];
    float t = tick * 0.06f;
    for (int i = 0; i < nodes; i++) {
      float ang = i * 6.28318f / nodes + t * 0.15f;
      float r = maxR * (0.45f + 0.45f * (((i * 5) % nodes) / (float)nodes));
      px[i] = cx + (int)(cosf(ang) * r);
      py[i] = cy + (int)(sinf(ang) * r);
    }
    for (int i = 0; i < nodes; i++) {
      int hop = (i * 3 + 2) % nodes;
      fullSprite.drawLine(px[i], py[i], px[hop], py[hop], ((tick + i * 7) % 30 < 6) ? TFT_CYAN : 0x1249);
      fullSprite.fillCircle(px[i], py[i], 2, (i < ramCells) ? TFT_CYAN : TFT_DARKGREY);
    }
    fullSprite.fillCircle(cx, cy, 4, a.color);
    fullSprite.setTextColor(TFT_LIGHTGREY, 0x0841);
    fullSprite.setCursor(6, y0 + 6);  fullSprite.printf("AGG %d%%", (int)(a.aggression * 100));
    fullSprite.setCursor(6, y0 + 18); fullSprite.printf("CUR %d%%", (int)(a.curiosity * 100));
    fullSprite.setCursor(6, y0 + 30); fullSprite.printf("TRS %d%%", (int)(a.trust * 100));
    fullSprite.setCursor(SW - 72, y0 + 6);  fullSprite.printf("RAM %d/16", ramCells);
    fullSprite.setCursor(SW - 72, y0 + 18); fullSprite.printf("EPS %.2f", a.epsilon);
    fullSprite.setCursor(SW - 72, y0 + 30); fullSprite.printf("SD %luB", (unsigned long)(a.sdRecordCount * 16));
  } else if (rSectionIdx == 2) {
    // 2: Needs & Senses
    const char* nlbl[3] = {"HUNGER","THIRST","ENERGY"};
    float nv[3] = {a.hunger, a.thirst, a.energy};
    uint16_t nc[3] = {TFT_RED, TFT_CYAN, TFT_GREEN};
    for (int i = 0; i < 3; i++) {
      int y = y0 + 10 + i * 24;
      fullSprite.setTextColor(TFT_LIGHTGREY, 0x0841);
      fullSprite.setCursor(8, y); fullSprite.print(nlbl[i]);
      fullSprite.fillRect(58, y - 1, 200, 10, 0x18E3);
      fullSprite.fillRect(58, y - 1, (int)(nv[i] * 200), 10, nc[i]);
      fullSprite.setTextColor(TFT_WHITE, 0x0841);
      fullSprite.setCursor(266, y); fullSprite.printf("%d%%", (int)(nv[i] * 100));
    }
    fullSprite.setTextColor(TFT_YELLOW, 0x0841);
    fullSprite.setCursor(8, y0 + 92); fullSprite.printf("FOV:%d  HEAR:%d  CARRY:%s", a.fov, a.hearing, CARRY_NAMES[a.carrying]);
    fullSprite.setTextColor(TFT_LIGHTGREY, 0x0841);
    fullSprite.setCursor(8, y0 + 108); fullSprite.printf("KILLS:%d HELPS:%d TRADES:%d", a.kills, a.helps, a.trades);
  } else if (rSectionIdx == 3) {
    // 3: Q-Table Brain bars (14 actions)
    fullSprite.setTextColor(TFT_CYAN, 0x0841);
    fullSprite.setCursor(8, y0 + 4); fullSprite.printf("Q-STATE #%d  eps=%.2f  act=%d", a.currentState, a.epsilon, a.chosenAction);
    int bw = (SW - 16) / Q_ACTIONS, mid = y0 + 82;
    for (int i = 0; i < Q_ACTIONS; i++) {
      int qx = 8 + i * bw;
      int qv = (a.currentState >= 0) ? (a.qtable[a.currentState][i] / 10) : 0;
      int bh = constrain(qv * 3, -44, 44);
      fullSprite.fillRect(qx, y0 + 32, bw - 2, 96, 0x10A2);
      fullSprite.drawFastHLine(qx, mid, bw - 2, TFT_DARKGREY);
      if (bh >= 0) fullSprite.fillRect(qx, mid - bh, bw - 2, max(1, bh), TFT_GREEN);
      else fullSprite.fillRect(qx, mid, bw - 2, -bh, TFT_RED);
      if (i == a.chosenAction) fullSprite.drawRect(qx, y0 + 32, bw - 2, 96, TFT_YELLOW);
    }
  } else if (rSectionIdx == 4) {
    // 4: Relations & Loyalty
    fullSprite.setTextColor(TFT_MAGENTA, 0x0841);
    fullSprite.setCursor(8, y0 + 4); fullSprite.print("RELATIONS: TRUST & LOYALTY");
    for (int i = 0; i < a.numRel && i < 7; i++) {
      int y = y0 + 20 + i * 18;
      fullSprite.setTextColor(strcmp(a.kingName, a.rels[i].name) == 0 ? TFT_YELLOW : TFT_WHITE, 0x0841);
      fullSprite.setCursor(8, y); fullSprite.print(a.rels[i].name);
      fullSprite.fillRect(44, y, 80, 7, 0x18E3);
      int tr = a.rels[i].trust;
      if (tr >= 0) fullSprite.fillRect(84, y, tr * 40 / 100, 7, TFT_GREEN);
      else fullSprite.fillRect(84 + tr * 40 / 100, y, (-tr) * 40 / 100, 7, TFT_RED);
      fullSprite.fillRect(136, y, 90, 7, 0x18E3);
      fullSprite.fillRect(136, y, a.rels[i].loyalty * 90 / 100, 7, a.rels[i].loyalty >= 55 ? TFT_YELLOW : TFT_CYAN);
      fullSprite.setTextColor(TFT_LIGHTGREY, 0x0841);
      fullSprite.setCursor(232, y); fullSprite.printf("T%+d L%d", tr, a.rels[i].loyalty);
    }
  } else if (rSectionIdx == 5) {
    // 5: Emergent Language Matrix
    const char* cn[N_CONCEPTS] = {"FD","WT","DN","FR","HL","BG","KL","CM"};
    int sz = 14, gx = 32, gy = y0 + 18;
    fullSprite.setTextColor(TFT_LIGHTGREY, 0x0841);
    for (int c = 0; c < N_CONCEPTS; c++) { fullSprite.setCursor(gx + c * sz + 1, gy - 10); fullSprite.print(cn[c]); }
    for (int s = 0; s < N_SOUNDS; s++) {
      fullSprite.setCursor(8, gy + s * sz + 3); fullSprite.printf("S%d", s);
      for (int c = 0; c < N_CONCEPTS; c++) {
        int val = a.ear[s][c];
        uint16_t cell = (val > 0) ? ((min(63, 12 + val * 3)) << 5) : 0x10A2;
        fullSprite.fillRect(gx + c * sz, gy + s * sz, sz - 1, sz - 1, cell);
        if (a.mouth[c] == s) fullSprite.drawRect(gx + c * sz, gy + s * sz, sz - 1, sz - 1, TFT_YELLOW);
      }
    }
  } else {
    // 6: Quantized SD Long-Term Memory (/memories/<NAME>.dat)
    fullSprite.setTextColor(TFT_CYAN, 0x0841);
    fullSprite.setCursor(8, y0 + 4);
    fullSprite.printf("/memories/%s.dat (%lu x 16B)", a.name, (unsigned long)a.sdRecordCount);
    if (sdReady) {
      char path[32]; snprintf(path, sizeof(path), "/memories/%s.dat", a.name);
      File f = SD.open(path, FILE_READ);
      if (f) {
        size_t sz = f.size();
        size_t count = sz / sizeof(MemRecord);
        size_t show = min((size_t)9, count);
        if (show > 0) {
          f.seek((count - show) * sizeof(MemRecord));
          for (size_t i = 0; i < show; i++) {
            MemRecord rec;
            if (f.read((uint8_t*)&rec, sizeof(rec)) != sizeof(rec)) break;
            fullSprite.setTextColor(i == show - 1 ? TFT_WHITE : TFT_LIGHTGREY, 0x0841);
            fullSprite.setCursor(8, y0 + 20 + i * 15);
            fullSprite.printf("t%05lu E%u @%u,%u %.3s v%+d", (unsigned long)rec.tick, rec.eventType, rec.x, rec.y, rec.other, rec.value);
          }
        }
        f.close();
      }
    } else {
      fullSprite.setTextColor(TFT_DARKGREY, 0x0841);
      fullSprite.setCursor(8, y0 + 26); fullSprite.print("(Insert FAT32 MicroSD for .dat logs)");
    }
  }

  // Bottom hint bar
  fullSprite.fillRect(0, SH - 12, SW, 12, 0x0862);
  fullSprite.setTextColor(TFT_DARKGREY, 0x0862);
  fullSprite.setCursor(4, SH - 10); fullSprite.print("A/D:tab  p/P:AI  R:map  0-4:spd");
  fullSprite.pushSprite(0, 0);
}

void adjustSetting(int idx, int dir) {
  switch (idx) {
    case 0: zoomIdx = constrain(zoomIdx + dir, 0, 3); break;
    case 1: speedIdx = constrain(speedIdx + dir, 0, 4); break;
    case 2: followMode = !followMode; break;
    case 3: showFOV = !showFOV; break;
    case 4: showFog = !showFog; break;
    case 5: showBonds = !showBonds; break;
    case 6: learningEnabled = !learningEnabled; break;
    case 7: langEnabled = !langEnabled; break;
    case 8: socialEnabled = !socialEnabled; break;
    case 9: if (sdReady) { sdSaveWorld(); addEvent(TFT_CYAN, "Saved /world.sav"); } break;
  }
}

// ---------------- INPUT & MAIN LOOP ----------------
int lastUp=HIGH, lastDn=HIGH, lastLf=HIGH, lastRt=HIGH, lastCk=HIGH;
bool edge(int cur, int &last) { bool p = (cur == LOW && last == HIGH); last = cur; return p; }
int readKey() { Wire.requestFrom((uint8_t)KB_I2C_ADDR, (uint8_t)1); return Wire.available() ? Wire.read() : 0; }
void centerCamOnSel() { camX = ais[selectedAI].x - tilesVisX()/2; camY = ais[selectedAI].y - tilesVisY()/2; }
void cycleSel(int dir) {
  for (int i = 0; i < MAX_AI; i++) { selectedAI = (selectedAI + dir + MAX_AI) % MAX_AI; if (ais[selectedAI].alive) break; }
}

unsigned long lastTickMs = 0;

void setup() {
  Serial.begin(115200);
  pinMode(PERI_POWERON, OUTPUT); digitalWrite(PERI_POWERON, HIGH);
  delay(500);
  pinMode(TFT_BL_PIN, OUTPUT); digitalWrite(TFT_BL_PIN, HIGH);
  // Deselect all shared SPI CS pins before init (prevents T-Deck SPI lockup)
  pinMode(TFT_CS_PIN, OUTPUT);  digitalWrite(TFT_CS_PIN, HIGH);
  pinMode(LORA_CS_PIN, OUTPUT); digitalWrite(LORA_CS_PIN, HIGH);
  pinMode(SD_CS_PIN, OUTPUT);   digitalWrite(SD_CS_PIN, HIGH);

  Wire.begin(KB_I2C_SDA, KB_I2C_SCL);
  pinMode(TB_UP, INPUT_PULLUP); pinMode(TB_DOWN, INPUT_PULLUP);
  pinMode(TB_LEFT, INPUT_PULLUP); pinMode(TB_RIGHT, INPUT_PULLUP);
  pinMode(TB_CLICK, INPUT_PULLUP);

  SPI.begin(SPI_SCK_PIN, SPI_MISO_PIN, SPI_MOSI_PIN, SD_CS_PIN);
  sdReady = SD.begin(SD_CS_PIN, SPI, 16000000);
  if (sdReady) sdEnsureDirs();

  tft.init(); tft.setRotation(1); tft.fillScreen(TFT_BLACK);
  layoutPanels(); allocMapSprites();
  randomSeed(micros());

  if (!sdLoadWorld()) {
    genWorld();
    for (int i = 0; i < MAX_AI; i++) aiSpawn(i);
    addEvent(TFT_CYAN, "World seeded (%d AIs)", MAX_AI);
  }
  renderHUD(); renderMap(); renderPanel();
}

void loop() {
  bool pUp = edge(digitalRead(TB_UP), lastUp);
  bool pDn = edge(digitalRead(TB_DOWN), lastDn);
  bool pLf = edge(digitalRead(TB_LEFT), lastLf);
  bool pRt = edge(digitalRead(TB_RIGHT), lastRt);
  bool pCk = edge(digitalRead(TB_CLICK), lastCk);
  int key  = readKey();
  bool redrawUI = false;

  if (key >= '0' && key <= '4') { speedIdx = key - '0'; redrawUI = true; }

  if (expandedMode) {
    if (key=='r' || key=='R') {
      expandedMode = false; fullSprite.deleteSprite(); layoutPanels(); allocMapSprites(); redrawUI = true;
    } else if (pLf || key=='a' || key=='A') { rSectionIdx = (rSectionIdx + 6) % 7; redrawUI = true; }
    else if (pRt || key=='d' || key=='D' || pCk) { rSectionIdx = (rSectionIdx + 1) % 7; redrawUI = true; }
    else if (key=='p' || key==']' || key=='n') { cycleSel(+1); redrawUI = true; }
    else if (key=='P' || key=='[') { cycleSel(-1); redrawUI = true; }
  } else if (panelMode == PANEL_SETTINGS) {
    if (key=='m' || key=='M') { panelMode = PANEL_AI; redrawUI = true; }
    else if (pUp || key=='w' || key=='W') { settingsIdx = (settingsIdx + 9) % 10; redrawUI = true; }
    else if (pDn || key=='s' || key=='S') { settingsIdx = (settingsIdx + 1) % 10; redrawUI = true; }
    else if (pLf || key=='a' || key=='A') { adjustSetting(settingsIdx, -1); redrawUI = true; }
    else if (pRt || pCk || key=='d' || key=='D' || key==' ') { adjustSetting(settingsIdx, +1); redrawUI = true; }
  } else {
    int step = max(1, tilesVisX() / 6);
    if (pUp || key=='w' || key=='W') { followMode = false; camY -= step; }
    if (pDn || key=='s' || key=='S') { followMode = false; camY += step; }
    if (pLf || key=='a' || key=='A') { followMode = false; camX -= step; }
    if (pRt || key=='d' || key=='D') { followMode = false; camX += step; }
    if (pCk || key==' ') { followMode = !followMode; centerCamOnSel(); redrawUI = true; }
    if (key=='p' || key==']' || key=='n') { cycleSel(+1); redrawUI = true; }
    if (key=='P' || key=='[') { cycleSel(-1); redrawUI = true; }
    if (key=='+' || key=='=') zoomIdx = min(3, zoomIdx + 1);
    if (key=='-' || key=='_') zoomIdx = max(0, zoomIdx - 1);
    if (key=='z' || key=='Z') zoomIdx = (zoomIdx + 1) % 4;
    if (key=='e' || key=='E') { panelOpen = !panelOpen; freeMapSprites(); layoutPanels(); allocMapSprites(); redrawUI = true; }
    if (key=='m' || key=='M') { if (!panelOpen) { panelOpen = true; freeMapSprites(); layoutPanels(); allocMapSprites(); } panelMode = PANEL_SETTINGS; redrawUI = true; }
    if (key=='r' || key=='R') {
      expandedMode = true; freeMapSprites(); fullSprite.setColorDepth(16); fullSprite.createSprite(SW, SH); redrawUI = true;
    }
  }

  if (followMode && !expandedMode && ais[selectedAI].alive) centerCamOnSel();

  int tickMs = currentSpeedMs();
  unsigned long now = millis();
  if (tickMs > 0 && now - lastTickMs >= (unsigned long)tickMs) {
    worldTick();
    lastTickMs = now;
    redrawUI = true;
  }

  if (expandedMode) {
    if (redrawUI) renderExpandedView();
  } else {
    if (redrawUI) { renderHUD(); renderPanel(); }
    renderMap();
  }
  delay(10);
}
`;

export function downloadTDeckFirmwareZip(): void {
  const blob = buildZipBlob([
    { path: 'tdeck-world-esp32/platformio.ini', content: TDECK_PLATFORMIO_INI },
    { path: 'tdeck-world-esp32/src/main.cpp', content: TDECK_MAIN_CPP },
    { path: 'tdeck-world-esp32/README.md', content: TDECK_README_MD },
  ]);
  triggerFileDownload(blob, 'tdeck-world-esp32.zip');
}
