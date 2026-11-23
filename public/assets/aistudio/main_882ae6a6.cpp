// =============================================================================
//  T-Deck World — Stage 1.1
//  Fixes: sprite-based rendering (no flicker), slower tick rate, zoom levels,
//  collapsible side panel, clearer visuals, more keyboard controls.
// =============================================================================

#include <Arduino.h>
#include <TFT_eSPI.h>
#include <Wire.h>
#include <math.h>
#include <string.h>
#include <stdarg.h>

// ---------------- HARDWARE ----------------
#define KB_I2C_SDA        18
#define KB_I2C_SCL         8
#define KB_I2C_ADDR     0x55
#define TB_UP              3
#define TB_DOWN           15
#define TB_LEFT            1
#define TB_RIGHT           2
#define TB_CLICK           0
#define PERI_POWERON      10
#define TFT_BL_PIN        42

TFT_eSPI tft = TFT_eSPI();
TFT_eSprite mapSprite = TFT_eSprite(&tft);
TFT_eSprite panelSprite = TFT_eSprite(&tft);
TFT_eSprite hudSprite = TFT_eSprite(&tft);
TFT_eSprite fullSprite = TFT_eSprite(&tft);
bool expandedMode    = false;
bool povFullscreen   = false;         // legacy — kept for E on map
// --- Scrollable section R-view state ---
int  rSectionIdx       = 0;
int  rSectionScrollTop = 0;
bool rSectionFullscr   = false;

// ---------------- SCREEN LAYOUT ----------------
static const int SW = 320;
static const int SH = 240;
static const int HUD_H = 22;      // 2 rows: stats + event ticker

// Panel can be shown or hidden (hidden -> full-width map)
bool  panelOpen = true;
int   PAN_W_OPEN = 128;
int   PAN_X, PAN_Y, PAN_W, PAN_H;
int   MAP_X, MAP_Y, MAP_W, MAP_H;

// ---------------- EVENTS (ticker) ----------------
struct Event { char text[40]; int tick; uint16_t col; };
static const int EVENT_LOG_SIZE = 8;
Event eventLog[EVENT_LOG_SIZE];
int eventHead = 0;

void addEvent(uint16_t col, const char* fmt, ...) {
  va_list ap; va_start(ap, fmt);
  vsnprintf(eventLog[eventHead].text, sizeof(eventLog[0].text), fmt, ap);
  va_end(ap);
  eventLog[eventHead].text[sizeof(eventLog[0].text) - 1] = 0;
  eventLog[eventHead].tick = 0;    // set after we have tick available
  eventLog[eventHead].col = col;
  eventHead = (eventHead + 1) % EVENT_LOG_SIZE;
}

// ---------------- WORLD ----------------
static const int WORLD_W = 64;
static const int WORLD_H = 64;

// Zoom = how many tiles fit across the horizontal viewport.
// Tiles stretch to fill the viewport exactly (non-square tiles — slight aspect bend).
int zoomLevels[] = {64, 40, 24, 12};    // tiles visible horizontally
int zoomIdx = 1;    // default (mid zoom)
int tilesVisX() { return min(WORLD_W, zoomLevels[zoomIdx]); }
int tilesVisY() {
  // match aspect — visible vertical tiles proportional to viewport
  float ppx = (float)MAP_W / tilesVisX();
  int v = (int)(MAP_H / ppx + 0.5f);
  return min(WORLD_H, v);
}
float tilePpx() { return (float)MAP_W / tilesVisX(); }
float tilePpy() { return (float)MAP_H / tilesVisY(); }
// Back-compat for callers expecting integer tile size (used by shape radius etc.)
int tilePx() { return max(2, (int)min(tilePpx(), tilePpy())); }
int viewTilesX() { return tilesVisX(); }
int viewTilesY() { return tilesVisY(); }

enum Tile : uint8_t {
  T_GRASS = 0, T_WATER = 1, T_FOREST = 2, T_STONE = 3,
  T_SAND = 4, T_FOOD = 5, T_BUILT = 6, T_MEMORIAL = 7,
  T_PIT = 8,
  T_COUNT
};
static const uint16_t TILE_COLOR[T_COUNT] = {
  0x6EC6,   // grass (mid green)
  0x2D5F,   // water (blue)
  0x2A45,   // forest (dark green)
  0x8410,   // stone (grey)
  0xEEC9,   // sand (tan)
  0xF800,   // food (red)
  0x7BEF,   // built (wall — light grey)
  0xFFE0,   // memorial (yellow)
  0x2104    // pit (very dark)
};

uint8_t world[WORLD_H][WORLD_W];

int camX = 16, camY = 16;
int tick = 0;
int timeOfDay() { return tick % 2400; }
bool isNight() { int t = timeOfDay(); return t < 400 || t > 2000; }

// Speeds (ms per tick). 0 = paused.
int speedMs[] = {0, 500, 250, 100, 40};
int speedIdx = 2;          // default: 250ms (4 ticks/sec)
int currentSpeedMs() { return speedMs[speedIdx]; }

// Tunable world parameters — exposed through settings menu
int paramFoodRegrowRate = 60;
int paramRandomHurtRate = 3;
int paramMemorialDecay  = 3000;
int paramPopulationCap  = 8;

// ---------------- AI ----------------
static const int MAX_AI = 8;

// ---- Language: mouth / ear system ----
// Sound palette (discrete phonemes) and concept palette.
// Mouth[concept] = which sound this AI emits for that concept (random at birth).
// Ear[sound][concept] = association strength, learned through co-occurrence.
static const int N_SOUNDS   = 8;
static const int N_CONCEPTS = 8;
enum Concept {
  C_FOOD = 0, C_WATER = 1, C_ENEMY = 2, C_PAIN = 3,
  C_FRIEND = 4, C_DANGER = 5, C_KILL = 6, C_CALM = 7
};
static const char* CONCEPT_NAME[N_CONCEPTS] = {
  "food", "watr", "enmy", "pain", "frnd", "dngr", "kill", "calm"
};

// ---- Q-Learning state space ----
// State = need (0..3) + threat*4 (0,4,8) + foodKnown*12 + waterKnown*24
// → 4 * 3 * 2 * 2 = 48 states
static const int Q_STATES  = 48;
static const int Q_ACTIONS = 12;

// 0..7 existing, 8..11 new "world-shaping" actions
static const char* ACT_NAME[Q_ACTIONS] = {
  "seek", "drink", "flee", "hunt",
  "help", "expl", "rest", "wait",
  "build", "break", "dig", "jump"
};

struct AI {
  bool     alive;
  char     name[4];
  int      x, y;
  int      prevX, prevY;      // previous position (for interpolation)
  unsigned long moveStartMs;  // when the last move happened
  int8_t   facing;
  int      soul;
  int      age;
  int      birthTick;
  uint8_t  shape;
  uint16_t color;
  float    hunger, thirst, energy;
  float    aggression, curiosity, trust;
  int      hearing, fov;
  int      kills, helps, foodEaten;
  char     lastAction[16];
  char     lastReason[28];
  uint8_t  seen[WORLD_H][WORLD_W / 8];
  // ---- Brain ----
  int16_t  qtable[Q_STATES][Q_ACTIONS];   // Q-values * 10 (fixed point)
  int      prevState;        // state at last decision
  int      prevAction;       // action taken at last decision
  float    prevHunger, prevThirst, prevEnergy;
  int      prevSoul;
  int      currentState;     // for display
  int      chosenAction;     // for display
  bool     wasRandom;        // for display: was last action exploratory?
  float    epsilon;          // current exploration rate
  // ---- Language ----
  uint8_t  mouth[N_CONCEPTS];               // concept → sound (random at birth)
  int8_t   ear[N_SOUNDS][N_CONCEPTS];       // sound → concept associations (learned)
  int8_t   lastEmittedSound;                // -1 = none
  int8_t   lastEmittedConcept;              // -1 = none
  int      lastEmittedTick;                 // for visual ring animation
  int8_t   lastHeardSound;                  // -1 = none
  int8_t   lastHeardConcept;                // what the listener thinks it heard
  int      lastHeardTick;
  char     lastHeardFrom[4];                // name of speaker, null-terminated
  // ---- Relationships ----
  // Small per-AI memory of other AIs: name + trust (-100..+100) + last seen
  char     rel_name[4][4];     // up to 4 known AIs
  int8_t   rel_trust[4];       // signed trust
  int      rel_lastTick[4];
  // ---- Lineage ----
  char     parent1[4], parent2[4];          // names of parents (empty for newborns from pool)
  int      lastReproTick;                   // cooldown
  int      numChildren;
  // ---- Inventory / physics ----
  uint8_t  carrying;        // 0=nothing, 1=wood, 2=stone, 3=berry
  int      trapTick;        // when AI first fell into pit (0 = not trapped)
};
enum CarryItem { CARRY_NONE = 0, CARRY_WOOD = 1, CARRY_STONE = 2, CARRY_BERRY = 3 };
static const char* CARRY_NAMES[4] = { "-", "wood", "stone", "berry" };
AI ais[MAX_AI];

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

void aiMarkSeen(AI& a, int x, int y) {
  if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return;
  a.seen[y][x >> 3] |= (1 << (x & 7));
}
bool aiHasSeen(const AI& a, int x, int y) {
  if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return false;
  return (a.seen[y][x >> 3] >> (x & 7)) & 1;
}

// Forward decl — defined after world helpers
bool hasLOS(int x1, int y1, int x2, int y2);

void aiPerceive(AI& a) {
  int depth = a.fov;
  // Always mark the AI's own tile
  aiMarkSeen(a, a.x, a.y);
  for (int d = 1; d <= depth; d++) {
    for (int w = -d; w <= d; w++) {
      int dx = 0, dy = 0;
      switch (a.facing) {
        case 0: dx = w; dy = -d; break;
        case 1: dx = d; dy = w;  break;
        case 2: dx = w; dy = d;  break;
        case 3: dx = -d; dy = w; break;
      }
      int tx = a.x + dx, ty = a.y + dy;
      // Only mark tiles that have clear line-of-sight from the AI's position
      if (hasLOS(a.x, a.y, tx, ty)) aiMarkSeen(a, tx, ty);
    }
  }
}

// ---------------- WORLD GEN ----------------
void genWorld() {
  for (int y = 0; y < WORLD_H; y++)
    for (int x = 0; x < WORLD_W; x++) world[y][x] = T_GRASS;
  for (int i = 0; i < 8; i++) {
    int cx = random(4, WORLD_W - 4), cy = random(4, WORLD_H - 4), r = random(2, 5);
    for (int y = cy - r; y <= cy + r; y++)
      for (int x = cx - r; x <= cx + r; x++) {
        int dx = x - cx, dy = y - cy;
        if (dx*dx + dy*dy <= r*r && x >= 0 && x < WORLD_W && y >= 0 && y < WORLD_H)
          world[y][x] = T_WATER;
      }
  }
  for (int i = 0; i < 12; i++) {
    int cx = random(2, WORLD_W - 2), cy = random(2, WORLD_H - 2), r = random(2, 6);
    for (int y = cy - r; y <= cy + r; y++)
      for (int x = cx - r; x <= cx + r; x++) {
        int dx = x - cx, dy = y - cy;
        if (dx*dx + dy*dy <= r*r && x >= 0 && x < WORLD_W && y >= 0 && y < WORLD_H
            && world[y][x] == T_GRASS && random(0, 100) < 70) world[y][x] = T_FOREST;
      }
  }
  for (int i = 0; i < 6; i++) {
    int cx = random(2, WORLD_W - 2), cy = random(2, WORLD_H - 2), r = random(1, 3);
    for (int y = cy - r; y <= cy + r; y++)
      for (int x = cx - r; x <= cx + r; x++) {
        int dx = x - cx, dy = y - cy;
        if (dx*dx + dy*dy <= r*r && x >= 0 && x < WORLD_W && y >= 0 && y < WORLD_H
            && world[y][x] == T_GRASS) world[y][x] = T_STONE;
      }
  }
  for (int y = 0; y < WORLD_H; y++)
    for (int x = 0; x < WORLD_W; x++) {
      if (world[y][x] != T_GRASS) continue;
      bool near = false;
      for (int dy = -1; dy <= 1 && !near; dy++)
        for (int dx = -1; dx <= 1; dx++) {
          int nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < WORLD_W && ny >= 0 && ny < WORLD_H && world[ny][nx] == T_WATER)
            { near = true; break; }
        }
      if (near) world[y][x] = T_SAND;
    }
  for (int i = 0; i < 40; i++) {
    int x = random(0, WORLD_W), y = random(0, WORLD_H);
    if (world[y][x] == T_GRASS || world[y][x] == T_FOREST) world[y][x] = T_FOOD;
  }
}

bool isPassable(Tile t) {
  return t == T_GRASS || t == T_SAND || t == T_FOREST || t == T_FOOD || t == T_MEMORIAL || t == T_PIT;
}
bool isSolid(Tile t) {
  return t == T_FOREST || t == T_STONE || t == T_BUILT;
}

// Line-of-sight between two tiles — Bresenham, stops at solid tiles.
// Returns true if nothing solid blocks the path (solid tile AT the endpoint doesn't block —
// you can see the thing you're looking AT, you just can't see past it).
bool hasLOS(int x1, int y1, int x2, int y2) {
  int dx = abs(x2 - x1), dy = abs(y2 - y1);
  int sx = (x1 < x2) ? 1 : -1;
  int sy = (y1 < y2) ? 1 : -1;
  int err = dx - dy;
  int x = x1, y = y1;
  int safety = dx + dy + 2;
  while (safety-- > 0) {
    if (x == x2 && y == y2) return true;
    int e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx)  { err += dx; y += sy; }
    if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return false;
    if ((x != x2 || y != y2) && isSolid((Tile)world[y][x])) return false;
  }
  return false;
}
static const int MONSTER_THRESHOLD = 200;
bool isMonster(int soul) { return soul >= MONSTER_THRESHOLD; }

// ---------------- MEMORIAL DATA ----------------
// When a famous AI dies with a witness, we save a fragment of their brain + mouth map.
// Living AIs that walk onto the memorial tile inherit a bit of that knowledge.
struct MemorialData {
  bool    used;
  int     x, y;
  int     qState;              // which state's row we captured
  int16_t qRow[Q_ACTIONS];
  uint8_t mouth[N_CONCEPTS];
  char    fromName[4];
  int     birthTick;
};
static const int MEMORIAL_MAX = 16;
MemorialData memorials[MEMORIAL_MAX];

// ---------------- AI LIFE ----------------
static const int SOUL_POOL_MAX = 2048;
int soulPool = SOUL_POOL_MAX;

void aiSpawn(int idx) {
  AI& a = ais[idx];
  memset(&a, 0, sizeof(a));
  makeName(a.name);
  for (int tries = 0; tries < 200; tries++) {
    int x = random(2, WORLD_W - 2), y = random(2, WORLD_H - 2);
    if (isPassable((Tile)world[y][x]) && world[y][x] != T_MEMORIAL) {
      bool occ = false;
      for (int i = 0; i < MAX_AI; i++)
        if (i != idx && ais[i].alive && ais[i].x == x && ais[i].y == y) { occ = true; break; }
      if (!occ) { a.x = x; a.y = y; break; }
    }
  }
  a.alive = true;
  a.facing = random(0, 4);
  a.prevX = a.x; a.prevY = a.y;
  a.moveStartMs = millis();
  a.soul = 16;
  a.birthTick = tick;
  a.shape = random(0, 8);
  // Palette of distinct colors, none blue (water conflict)
  static const uint16_t PALETTE[12] = {
    0xF800, 0xFD20, 0xFFE0, 0x07E0, 0x07FF, 0x8410,
    0xF81F, 0xFBE0, 0xFC9E, 0xC618, 0xE73C, 0xFFFF
  };
  a.color = PALETTE[random(0, 12)];
  soulPool -= a.soul;
  a.hunger = 0.3f + random(0, 100) / 500.0f;
  a.thirst = 0.2f + random(0, 100) / 500.0f;
  a.energy = 0.8f + random(0, 100) / 500.0f;
  a.aggression = random(0, 100) / 100.0f;
  a.curiosity  = random(0, 100) / 100.0f;
  a.trust      = random(0, 100) / 100.0f;
  a.hearing = 3 + random(0, 6);
  a.fov = 2 + a.soul / 32;
  strcpy(a.lastAction, "born");
  strcpy(a.lastReason, "newborn");
  // ---- Brain: start blank, with tiny dispositional bias ----
  for (int s = 0; s < Q_STATES; s++)
    for (int ac = 0; ac < Q_ACTIONS; ac++)
      a.qtable[s][ac] = 0;
  // Bias priors by disposition (so personality is still visible on day 1)
  int aggBias   = (int)(a.aggression * 10.0f);   // +Q on hunt
  int trustBias = (int)(a.trust      *  6.0f);   // +Q on help
  int curBias   = (int)(a.curiosity  *  5.0f);   // +Q on explore
  for (int s = 0; s < Q_STATES; s++) {
    a.qtable[s][3] += aggBias;
    a.qtable[s][4] += trustBias;
    a.qtable[s][5] += curBias;
  }
  a.prevState   = -1;
  a.prevAction  = -1;
  a.prevHunger  = a.hunger;
  a.prevThirst  = a.thirst;
  a.prevEnergy  = a.energy;
  a.prevSoul    = a.soul;
  a.currentState = -1;
  a.chosenAction = -1;
  a.wasRandom   = false;
  a.epsilon     = 0.5f;

  // Language: random mouth mapping, zero ear
  for (int c = 0; c < N_CONCEPTS; c++) a.mouth[c] = random(0, N_SOUNDS);
  for (int s = 0; s < N_SOUNDS; s++)
    for (int c = 0; c < N_CONCEPTS; c++) a.ear[s][c] = 0;
  a.lastEmittedSound   = -1;
  a.lastEmittedConcept = -1;
  a.lastEmittedTick    = -9999;
  a.lastHeardSound     = -1;
  a.lastHeardConcept   = -1;
  a.lastHeardTick      = -9999;
  a.lastHeardFrom[0]   = 0;

  // Relationships: empty
  for (int i = 0; i < 4; i++) {
    a.rel_name[i][0] = 0;
    a.rel_trust[i] = 0;
    a.rel_lastTick[i] = -9999;
  }
  // Lineage: parent fields empty (pool-spawned)
  a.parent1[0] = 0; a.parent2[0] = 0;
  a.lastReproTick = -9999;
  a.numChildren = 0;
  a.carrying = CARRY_NONE;
  a.trapTick = 0;

  aiPerceive(a);
}

// ---- Relationships ----
// Find/create relationship slot. Returns index, or -1 if full+unknown.
int aiRelSlot(AI& a, const char* otherName) {
  // Existing?
  for (int i = 0; i < 4; i++)
    if (a.rel_name[i][0] && strcmp(a.rel_name[i], otherName) == 0) return i;
  // Free slot?
  for (int i = 0; i < 4; i++)
    if (a.rel_name[i][0] == 0) {
      strncpy(a.rel_name[i], otherName, 3); a.rel_name[i][3] = 0;
      a.rel_trust[i] = 0;
      a.rel_lastTick[i] = tick;
      return i;
    }
  // Replace the one with oldest contact (if forgotten > 500 ticks)
  int oldest = 0;
  for (int i = 1; i < 4; i++) if (a.rel_lastTick[i] < a.rel_lastTick[oldest]) oldest = i;
  if (tick - a.rel_lastTick[oldest] > 500) {
    strncpy(a.rel_name[oldest], otherName, 3); a.rel_name[oldest][3] = 0;
    a.rel_trust[oldest] = 0;
    a.rel_lastTick[oldest] = tick;
    return oldest;
  }
  return -1;
}
void aiRelUpdate(AI& a, const char* otherName, int delta) {
  int s = aiRelSlot(a, otherName);
  if (s < 0) return;
  int t = a.rel_trust[s] + delta;
  if (t > 100) t = 100; if (t < -100) t = -100;
  a.rel_trust[s] = (int8_t)t;
  a.rel_lastTick[s] = tick;
}
int aiRelGet(const AI& a, const char* otherName) {
  for (int i = 0; i < 4; i++)
    if (a.rel_name[i][0] && strcmp(a.rel_name[i], otherName) == 0) return a.rel_trust[i];
  return 0;
}

// ---- Language: emit + hear ----
bool langEnabled = true;

void aiHear(AI& listener, const AI& speaker, int sound, int concept) {
  if (!listener.alive) return;
  listener.lastHeardSound    = sound;
  listener.lastHeardConcept  = concept;
  listener.lastHeardTick     = tick;
  strncpy(listener.lastHeardFrom, speaker.name, 3);
  listener.lastHeardFrom[3]  = 0;
  // Co-occurrence: strengthen ear[sound][concept]
  if (listener.ear[sound][concept] < 100)
    listener.ear[sound][concept]++;
  // Decay other associations for this sound slightly (so one sound tends to one concept)
  for (int c = 0; c < N_CONCEPTS; c++)
    if (c != concept && listener.ear[sound][c] > 0 && (random(0, 4) == 0))
      listener.ear[sound][c]--;
}

void aiEmit(AI& speaker, int concept) {
  if (!langEnabled) return;
  if (concept < 0 || concept >= N_CONCEPTS) return;
  int sound = speaker.mouth[concept];
  speaker.lastEmittedSound   = sound;
  speaker.lastEmittedConcept = concept;
  speaker.lastEmittedTick    = tick;
  // Propagate to all within hearing of each listener
  for (int i = 0; i < MAX_AI; i++) {
    AI& l = ais[i];
    if (!l.alive || &l == &speaker) continue;
    int dx = l.x - speaker.x, dy = l.y - speaker.y;
    if (dx*dx + dy*dy > l.hearing * l.hearing) continue;
    aiHear(l, speaker, sound, concept);
  }
}

// ---- Q-learning helpers ----
bool learningEnabled = true;

int qComputeState(float hun, float thi, float ene, bool foodK, bool waterK, int threat) {
  // need: 0=OK, 1=FOOD, 2=WATER, 3=REST
  int need = 0;
  float h = hun, w = thi, e = 1.0f - ene;
  float maxN = max(h, max(w, e));
  if (maxN < 0.4f) need = 0;
  else if (h == maxN) need = 1;
  else if (w == maxN) need = 2;
  else need = 3;
  int st = need + threat * 4 + (foodK ? 12 : 0) + (waterK ? 24 : 0);
  if (st < 0) st = 0; if (st >= Q_STATES) st = Q_STATES - 1;
  return st;
}
int qBestAction(AI& a, int state) {
  int best = 0;
  for (int i = 1; i < Q_ACTIONS; i++)
    if (a.qtable[state][i] > a.qtable[state][best]) best = i;
  return best;
}
int qPickAction(AI& a, int state) {
  float r = random(0, 10000) / 10000.0f;
  a.wasRandom = (r < a.epsilon);
  if (a.wasRandom) return random(0, Q_ACTIONS);
  return qBestAction(a, state);
}
void qUpdate(AI& a, int state, int action, float reward, int newState, bool terminal) {
  const float alpha = 0.15f;
  const float gamma = 0.9f;
  float current = a.qtable[state][action] / 10.0f;
  float target;
  if (terminal) target = reward;
  else {
    int bestNext = qBestAction(a, newState);
    float maxNext = a.qtable[newState][bestNext] / 10.0f;
    target = reward + gamma * maxNext;
  }
  float nv = current + alpha * (target - current);
  int ni = (int)(nv * 10.0f);
  if (ni > 32000) ni = 32000;
  if (ni < -32000) ni = -32000;
  a.qtable[state][action] = (int16_t)ni;
}

void aiDie(AI& a, const char* cause) {
  bool famous = (a.soul > 48) || (a.kills >= 2) || (a.age > 1500) || (a.helps >= 3);
  bool witness = false;
  for (int i = 0; i < MAX_AI; i++) {
    if (!ais[i].alive || &ais[i] == &a) continue;
    int dx = ais[i].x - a.x, dy = ais[i].y - a.y;
    if (dx*dx + dy*dy <= ais[i].hearing * ais[i].hearing) { witness = true; break; }
  }
  if (famous && witness && random(0, 100) < 60) {
    if (world[a.y][a.x] == T_GRASS || world[a.y][a.x] == T_SAND || world[a.y][a.x] == T_FOREST) {
      world[a.y][a.x] = T_MEMORIAL;
      // Save a fragment of their brain
      int slot = -1;
      for (int i = 0; i < MEMORIAL_MAX; i++) if (!memorials[i].used) { slot = i; break; }
      if (slot < 0) slot = random(0, MEMORIAL_MAX);   // overwrite oldest random
      MemorialData& m = memorials[slot];
      m.used = true;
      m.x = a.x; m.y = a.y;
      m.qState = random(0, Q_STATES);
      memcpy(m.qRow, a.qtable[m.qState], sizeof(m.qRow));
      memcpy(m.mouth, a.mouth, sizeof(m.mouth));
      strncpy(m.fromName, a.name, 3); m.fromName[3] = 0;
      m.birthTick = tick;
    }
  }
  // Emit event
  if (famous) {
    addEvent(0xFBE0, "%s died (age %.1fd k%d)", a.name, a.age / 2400.0f, a.kills);
  }
  (void)cause;
  soulPool += a.soul;
  a.alive = false;
}

bool aiTryMoveImpl(AI& a, int dx, int dy, bool canEscapePit) {
  if (dx == 0 && dy == 0) return false;
  // Pit physics: if standing in a pit, can't walk out — must jump
  if (!canEscapePit && world[a.y][a.x] == T_PIT) {
    if (a.trapTick == 0) a.trapTick = tick;
    return false;
  }
  int nx = a.x + dx, ny = a.y + dy;
  if (nx < 0 || nx >= WORLD_W || ny < 0 || ny >= WORLD_H) return false;
  if (!isPassable((Tile)world[ny][nx])) return false;
  for (int i = 0; i < MAX_AI; i++) {
    if (!ais[i].alive || &ais[i] == &a) continue;
    if (ais[i].x == nx && ais[i].y == ny) return false;
  }
  a.prevX = a.x; a.prevY = a.y;
  a.moveStartMs = millis();
  a.x = nx; a.y = ny;
  // Falling INTO a pit starts the trap timer
  if (world[ny][nx] == T_PIT) a.trapTick = tick;
  else a.trapTick = 0;
  if (abs(dx) > abs(dy)) a.facing = (dx > 0) ? 1 : 3;
  else                   a.facing = (dy > 0) ? 2 : 0;
  if (world[ny][nx] == T_FOOD) {
    world[ny][nx] = T_GRASS;
    a.hunger = max(0.0f, a.hunger - 0.6f);
    a.soul += 2;
    a.foodEaten++;
    soulPool -= 2;
    strcpy(a.lastAction, "ate berry");
    snprintf(a.lastReason, sizeof(a.lastReason), "hunger %.2f", a.hunger);
    aiEmit(a, C_FOOD);
    if (a.carrying == CARRY_NONE) a.carrying = CARRY_BERRY;   // can also carry berries
  }
  if (world[ny][nx] == T_MEMORIAL) {
    // Find memorial data and inherit a fragment
    for (int i = 0; i < MEMORIAL_MAX; i++) {
      if (!memorials[i].used) continue;
      if (memorials[i].x != nx || memorials[i].y != ny) continue;
      MemorialData& m = memorials[i];
      // Blend Q row (50/50) into AI's same state
      for (int act = 0; act < Q_ACTIONS; act++)
        a.qtable[m.qState][act] = (a.qtable[m.qState][act] + m.qRow[act]) / 2;
      // Occasionally adopt one of the dead's mouth mappings
      for (int c = 0; c < N_CONCEPTS; c++)
        if (random(0, 3) == 0) a.mouth[c] = m.mouth[c];
      a.soul += 3;
      strcpy(a.lastAction, "learned");
      snprintf(a.lastReason, sizeof(a.lastReason), "from %s", m.fromName);
      addEvent(TFT_YELLOW, "%s read %s's memory", a.name, m.fromName);
      break;
    }
  }
  return true;
}
// Default move — cannot escape pit
bool aiTryMove(AI& a, int dx, int dy) { return aiTryMoveImpl(a, dx, dy, false); }
// Jump — can escape pit
bool aiTryJump(AI& a, int dx, int dy) { return aiTryMoveImpl(a, dx, dy, true); }

AI* aiNearest(AI& a, int r, bool weakerOnly=false) {
  AI* best = nullptr; int bestD = r*r + 1;
  for (int i = 0; i < MAX_AI; i++) {
    if (!ais[i].alive || &ais[i] == &a) continue;
    int dx = ais[i].x - a.x, dy = ais[i].y - a.y;
    int d2 = dx*dx + dy*dy;
    if (d2 > r*r) continue;
    if (weakerOnly && ais[i].soul >= a.soul) continue;
    // Must have line-of-sight — can't detect enemies through walls
    if (!hasLOS(a.x, a.y, ais[i].x, ais[i].y)) continue;
    if (d2 < bestD) { bestD = d2; best = &ais[i]; }
  }
  return best;
}

bool aiFindRememberedTile(const AI& a, Tile wanted, int& ox, int& oy, int maxR=20) {
  int bd = maxR*maxR + 1; bool found = false;
  for (int y = a.y - maxR; y <= a.y + maxR; y++)
    for (int x = a.x - maxR; x <= a.x + maxR; x++) {
      if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) continue;
      if (!aiHasSeen(a, x, y)) continue;
      if (world[y][x] != wanted) continue;
      int dx = x - a.x, dy = y - a.y, d2 = dx*dx + dy*dy;
      if (d2 < bd) { bd = d2; ox = x; oy = y; found = true; }
    }
  return found;
}

int sgn(int v) { return (v > 0) - (v < 0); }

void aiStepToward(AI& a, int tx, int ty) {
  int dx = sgn(tx - a.x), dy = sgn(ty - a.y);
  if (!aiTryMove(a, dx, dy)) {
    if (abs(tx - a.x) >= abs(ty - a.y)) {
      if (!aiTryMove(a, dx, 0)) aiTryMove(a, 0, dy);
    } else {
      if (!aiTryMove(a, 0, dy)) aiTryMove(a, dx, 0);
    }
  }
}

void aiAttack(AI& a, AI& other) {
  int damage = max(1, a.soul / 8 + (int)(a.aggression * 4.0f));
  int selfdmg = max(1, other.soul / 10);
  other.soul -= damage;
  a.soul -= selfdmg;
  soulPool += damage + selfdmg;
  aiRelUpdate(other, a.name, -30);         // victim hates attacker
  aiRelUpdate(a, other.name, -10);         // attacker slightly resents resistance
  aiEmit(a, C_ENEMY);                      // attacker broadcasts "enemy"
  aiEmit(other, C_PAIN);                   // victim cries pain
  if (other.soul <= 0) {
    int gain = max(4, damage);
    bool crossMonster = !isMonster(a.soul) && isMonster(a.soul + gain);
    a.soul += gain; soulPool -= gain;
    a.kills++;
    strcpy(a.lastAction, "killed");
    snprintf(a.lastReason, sizeof(a.lastReason), "%s +%d", other.name, gain);
    aiEmit(a, C_KILL);
    addEvent(0xF800, "%s killed %s", a.name, other.name);
    if (crossMonster) addEvent(0xF81F, "** %s became MONSTER **", a.name);
    aiDie(other, "killed");
  } else {
    strcpy(a.lastAction, "attack");
    snprintf(a.lastReason, sizeof(a.lastReason), "%s dmg%d", other.name, damage);
  }
}

void aiTick(AI& a) {
  if (!a.alive) return;
  a.age++;

  // Snapshot "before" state for reward computation
  float befHunger = a.hunger, befThirst = a.thirst, befEnergy = a.energy;
  int   befSoul   = a.soul;

  // Natural decay
  a.hunger = min(1.0f, a.hunger + 0.0008f);
  a.thirst = min(1.0f, a.thirst + 0.0010f);
  if (isNight()) a.energy = max(0.0f, a.energy - 0.0006f);
  else           a.energy = min(1.0f, a.energy + 0.0003f);
  if (a.age % 50 == 0 && a.soul > 16) { a.soul--; soulPool++; }
  if (a.hunger > 0.95f && a.age % 30 == 0) { a.soul--; soulPool++; }
  if (a.thirst > 0.95f && a.age % 20 == 0) { a.soul--; soulPool++; }
  if (paramRandomHurtRate > 0 && random(0, 20000) < paramRandomHurtRate) {
    int dmg = 2 + random(0, 6);
    a.soul -= dmg; soulPool += dmg;
    strcpy(a.lastAction, "hurt");
    strcpy(a.lastReason, "??? unknown");
    aiEmit(a, C_PAIN);
  }

  // Death handling with terminal Q-update
  if (a.soul <= 0) {
    if (learningEnabled && a.prevState >= 0 && a.prevAction >= 0) {
      qUpdate(a, a.prevState, a.prevAction, -20.0f, 0, /*terminal=*/true);
    }
    aiDie(a, "soul0");
    return;
  }

  aiPerceive(a);

  // Proximity trust buildup — see a neighbor, +1 trust (slow)
  if (a.age % 10 == 0) {
    for (int i = 0; i < MAX_AI; i++) {
      if (!ais[i].alive || &ais[i] == &a) continue;
      int dx = ais[i].x - a.x, dy = ais[i].y - a.y;
      if (dx*dx + dy*dy <= a.fov * a.fov) {
        aiRelUpdate(a, ais[i].name, +1);
      }
    }
  }

  // Observe environment
  AI* enemy = aiNearest(a, a.fov, false);
  AI* prey  = aiNearest(a, a.fov, true);
  int fx = 0, fy = 0, wx = 0, wy = 0;
  bool foundFood  = aiFindRememberedTile(a, T_FOOD, fx, fy, a.fov + 10);
  bool foundWater = aiFindRememberedTile(a, T_WATER, wx, wy, a.fov + 10);
  int threat = 0;
  if (enemy && enemy->soul > a.soul * 1.3f) threat = 2;
  else if (prey) threat = 1;

  // Compute current state
  int state = qComputeState(a.hunger, a.thirst, a.energy, foundFood, foundWater, threat);
  a.currentState = state;

  // ε by age-stage
  if      (a.age < 200)  a.epsilon = 0.50f;
  else if (a.age < 600)  a.epsilon = 0.25f;
  else if (a.age < 1500) a.epsilon = 0.10f;
  else                   a.epsilon = 0.05f;

  // ---- Q-update for previous step (TD) ----
  if (learningEnabled && a.prevState >= 0 && a.prevAction >= 0) {
    // Reward shaping
    float r = 0.1f;                                    // survival bonus
    r += (a.prevHunger  - a.hunger)  * 4.0f;           // hunger down → good
    r += (a.prevThirst  - a.thirst)  * 4.0f;
    r += (a.energy      - a.prevEnergy) * 1.5f;
    r += (a.soul        - a.prevSoul) * 1.2f;          // soul change dominates
    // Disposition-coloured reward (personality filter)
    switch (a.prevAction) {
      case 3: r += a.aggression * 1.0f; break;         // hunt felt rewarding
      case 4: r += a.trust      * 0.8f; break;         // help felt rewarding
      case 5: r += a.curiosity  * 0.4f; break;         // explore felt rewarding
    }
    qUpdate(a, a.prevState, a.prevAction, r, state, /*terminal=*/false);
  }

  // ---- Pick next action via ε-greedy ----
  int action = learningEnabled ? qPickAction(a, state) : qBestAction(a, state);
  a.chosenAction = action;

  // Snapshot prev for next tick
  a.prevState  = state;
  a.prevAction = action;
  a.prevHunger = a.hunger;
  a.prevThirst = a.thirst;
  a.prevEnergy = a.energy;
  a.prevSoul   = a.soul;

  // ---- Execute action ----
  switch (action) {
    case 0:  // seek food
      if (foundFood) {
        aiStepToward(a, fx, fy);
        strcpy(a.lastAction, "seek food");
        snprintf(a.lastReason, sizeof(a.lastReason), "to food");
      } else {
        aiTryMove(a, random(-1, 2), random(-1, 2));
        strcpy(a.lastAction, "wander");
        strcpy(a.lastReason, "no food known");
      }
      break;
    case 1: { // drink
      bool nw = false;
      for (int ddy = -1; ddy <= 1 && !nw; ddy++)
        for (int ddx = -1; ddx <= 1; ddx++) {
          int nx = a.x + ddx, ny = a.y + ddy;
          if (nx>=0 && nx<WORLD_W && ny>=0 && ny<WORLD_H && world[ny][nx]==T_WATER) nw = true;
        }
      if (nw) {
        a.thirst = max(0.0f, a.thirst - 0.7f);
        a.soul++; soulPool--;
        strcpy(a.lastAction, "drank");
        snprintf(a.lastReason, sizeof(a.lastReason), "thirst-> %.2f", a.thirst);
        aiEmit(a, C_WATER);
      } else if (foundWater) {
        aiStepToward(a, wx, wy);
        strcpy(a.lastAction, "seek water");
        strcpy(a.lastReason, "to pond");
      } else {
        aiTryMove(a, random(-1, 2), random(-1, 2));
        strcpy(a.lastAction, "wander");
        strcpy(a.lastReason, "no water known");
      }
      break;
    }
    case 2:  // flee
      if (enemy) {
        aiTryMove(a, -sgn(enemy->x - a.x), -sgn(enemy->y - a.y));
        strcpy(a.lastAction, "flee");
        snprintf(a.lastReason, sizeof(a.lastReason), "from %s", enemy->name);
        aiEmit(a, C_DANGER);
      } else {
        aiTryMove(a, random(-1, 2), random(-1, 2));
        strcpy(a.lastAction, "scatter");
        strcpy(a.lastReason, "nothing to flee");
      }
      break;
    case 3: { // hunt
      if (prey) {
        int dxy = abs(prey->x - a.x) + abs(prey->y - a.y);
        if (dxy <= 1) aiAttack(a, *prey);
        else {
          aiStepToward(a, prey->x, prey->y);
          strcpy(a.lastAction, "stalk");
          snprintf(a.lastReason, sizeof(a.lastReason), "%s", prey->name);
        }
      } else {
        aiTryMove(a, random(-1, 2), random(-1, 2));
        strcpy(a.lastAction, "hunt?");
        strcpy(a.lastReason, "no prey");
      }
      break;
    }
    case 4:  // help
      if (prey) {
        aiStepToward(a, prey->x, prey->y);
        if (abs(prey->x - a.x) + abs(prey->y - a.y) <= 1 && a.soul > 20) {
          a.soul--; prey->soul++; a.helps++;
          strcpy(a.lastAction, "helped");
          snprintf(a.lastReason, sizeof(a.lastReason), "gave to %s", prey->name);
          aiRelUpdate(*prey, a.name, +15);   // helpee gains trust in helper
          aiRelUpdate(a, prey->name, +5);    // helper also feels bond
          aiEmit(a, C_FRIEND);
        } else {
          strcpy(a.lastAction, "aid");
          snprintf(a.lastReason, sizeof(a.lastReason), "%s", prey->name);
        }
      } else {
        strcpy(a.lastAction, "idle");
        strcpy(a.lastReason, "no one to help");
      }
      break;
    case 5:  // explore
      aiTryMove(a, random(-1, 2), random(-1, 2));
      strcpy(a.lastAction, "explore");
      snprintf(a.lastReason, sizeof(a.lastReason), "curiosity");
      break;
    case 6:  // rest
      a.energy = min(1.0f, a.energy + 0.02f);
      strcpy(a.lastAction, "rest");
      snprintf(a.lastReason, sizeof(a.lastReason), "ene %.2f", a.energy);
      break;
    case 7:  // wait
      strcpy(a.lastAction, "wait");
      strcpy(a.lastReason, "observing");
      break;
    case 8: { // build — consume carried wood/stone to place wall in facing tile
      int tx = a.x, ty = a.y;
      switch (a.facing) { case 0: ty--; break; case 1: tx++; break; case 2: ty++; break; case 3: tx--; break; }
      bool needMat = (a.carrying == CARRY_WOOD || a.carrying == CARRY_STONE);
      if (!needMat) {
        strcpy(a.lastAction, "build?");
        strcpy(a.lastReason, "no material");
      } else if (tx >= 0 && tx < WORLD_W && ty >= 0 && ty < WORLD_H && world[ty][tx] == T_GRASS) {
        world[ty][tx] = T_BUILT;
        a.carrying = CARRY_NONE;
        strcpy(a.lastAction, "built");
        snprintf(a.lastReason, sizeof(a.lastReason), "wall @%d,%d", tx, ty);
      } else {
        strcpy(a.lastAction, "build?");
        strcpy(a.lastReason, "can't here");
      }
      break;
    }
    case 9: { // destroy / mine — remove solid tile in facing, pick up resource
      int tx = a.x, ty = a.y;
      switch (a.facing) { case 0: ty--; break; case 1: tx++; break; case 2: ty++; break; case 3: tx--; break; }
      if (tx >= 0 && tx < WORLD_W && ty >= 0 && ty < WORLD_H) {
        Tile t = (Tile)world[ty][tx];
        if (t == T_FOREST || t == T_STONE || t == T_BUILT || t == T_PIT) {
          world[ty][tx] = T_GRASS;
          a.soul += (t == T_STONE) ? 2 : 1;
          soulPool -= (t == T_STONE) ? 2 : 1;
          // Pick up resource if hands free
          if (a.carrying == CARRY_NONE) {
            if (t == T_FOREST || t == T_BUILT) a.carrying = CARRY_WOOD;
            else if (t == T_STONE) a.carrying = CARRY_STONE;
          }
          strcpy(a.lastAction, "broke");
          snprintf(a.lastReason, sizeof(a.lastReason),
                   t == T_FOREST ? "tree->wood" : t == T_STONE ? "stone" :
                   t == T_BUILT ? "wall->wood" : "pit");
          break;
        }
      }
      strcpy(a.lastAction, "break?");
      strcpy(a.lastReason, "nothing to break");
      break;
    }
    case 10: { // dig — turn FACING tile into a pit (trap others, strategic)
      int tx = a.x, ty = a.y;
      switch (a.facing) { case 0: ty--; break; case 1: tx++; break; case 2: ty++; break; case 3: tx--; break; }
      if (tx >= 0 && tx < WORLD_W && ty >= 0 && ty < WORLD_H
          && (world[ty][tx] == T_GRASS || world[ty][tx] == T_SAND)) {
        world[ty][tx] = T_PIT;
        a.energy = max(0.0f, a.energy - 0.08f);
        strcpy(a.lastAction, "dug");
        snprintf(a.lastReason, sizeof(a.lastReason), "pit @%d,%d", tx, ty);
      } else {
        strcpy(a.lastAction, "dig?");
        strcpy(a.lastReason, "can't here");
      }
      break;
    }
    case 11: { // jump — 2 tiles forward, can escape pit, can jump OVER a wall
      int dx = 0, dy = 0;
      switch (a.facing) { case 0: dy = -1; break; case 1: dx = 1; break; case 2: dy = 1; break; case 3: dx = -1; break; }
      a.energy = max(0.0f, a.energy - 0.08f);
      // First tile — can escape pits (jumping out)
      bool wasInPit = (world[a.y][a.x] == T_PIT);
      int landX = a.x + 2 * dx, landY = a.y + 2 * dy;
      // Can we land 2 tiles over a wall?
      bool canLand = (landX >= 0 && landX < WORLD_W && landY >= 0 && landY < WORLD_H
                      && isPassable((Tile)world[landY][landX]));
      bool landOccupied = false;
      for (int i = 0; i < MAX_AI; i++)
        if (ais[i].alive && &ais[i] != &a && ais[i].x == landX && ais[i].y == landY)
          { landOccupied = true; break; }
      // Was the middle tile a wall we jumped over?
      int midX = a.x + dx, midY = a.y + dy;
      bool overWall = (midX >= 0 && midX < WORLD_W && midY >= 0 && midY < WORLD_H
                        && isSolid((Tile)world[midY][midX]));
      if (canLand && !landOccupied) {
        a.prevX = a.x; a.prevY = a.y;
        a.moveStartMs = millis();
        a.x = landX; a.y = landY;
        a.trapTick = (world[landY][landX] == T_PIT) ? tick : 0;
        strcpy(a.lastAction, wasInPit ? "jump out" : "jumped");
        snprintf(a.lastReason, sizeof(a.lastReason),
                 wasInPit ? "escaped pit!" : overWall ? "over wall" : "2 tiles");
      } else if (aiTryJump(a, dx, dy)) {
        strcpy(a.lastAction, "hop");
        snprintf(a.lastReason, sizeof(a.lastReason), "1 tile");
      } else {
        strcpy(a.lastAction, "jump?");
        strcpy(a.lastReason, "blocked");
      }
      break;
    }
    default:
      strcpy(a.lastAction, "idle");
      strcpy(a.lastReason, "no verb");
  }
  // Suppress unused warning
  (void)befHunger; (void)befThirst; (void)befEnergy; (void)befSoul;
}

bool reproEnabled = true;

// Reproduction: two trusting adjacent AIs → offspring with inherited brain
void aiReproduce(AI& p1, AI& p2) {
  if (!reproEnabled) return;
  if (soulPool < 20) return;
  if (tick - p1.lastReproTick < 1000 || tick - p2.lastReproTick < 1000) return;
  // Find a dead slot for newborn
  int slot = -1;
  for (int i = 0; i < MAX_AI; i++)
    if (!ais[i].alive) { slot = i; break; }
  if (slot < 0) return;
  // Find empty adjacent tile around p1
  int bx = -1, by = -1;
  for (int dy = -1; dy <= 1 && bx < 0; dy++)
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      int nx = p1.x + dx, ny = p1.y + dy;
      if (nx<0||nx>=WORLD_W||ny<0||ny>=WORLD_H) continue;
      if (!isPassable((Tile)world[ny][nx])) continue;
      bool occ = false;
      for (int i = 0; i < MAX_AI; i++)
        if (ais[i].alive && ais[i].x == nx && ais[i].y == ny) { occ = true; break; }
      if (!occ) { bx = nx; by = ny; break; }
    }
  if (bx < 0) return;
  // Spawn newborn at that slot
  aiSpawn(slot);
  AI& c = ais[slot];
  c.x = bx; c.y = by;
  c.prevX = bx; c.prevY = by;
  // Inherit Q-table: parent average
  for (int s = 0; s < Q_STATES; s++)
    for (int ac = 0; ac < Q_ACTIONS; ac++)
      c.qtable[s][ac] = (p1.qtable[s][ac] + p2.qtable[s][ac]) / 2;
  // Inherit mouth: pick from either parent per concept
  for (int cc = 0; cc < N_CONCEPTS; cc++)
    c.mouth[cc] = (random(0, 2) == 0) ? p1.mouth[cc] : p2.mouth[cc];
  // Inherit ear map (average, cap at int8 bounds)
  for (int s = 0; s < N_SOUNDS; s++)
    for (int cc = 0; cc < N_CONCEPTS; cc++)
      c.ear[s][cc] = (p1.ear[s][cc] + p2.ear[s][cc]) / 2;
  // Blend dispositions with small noise
  c.aggression = constrain((p1.aggression + p2.aggression) / 2.0f + ((random(-100, 101) / 100.0f) * 0.1f), 0.0f, 1.0f);
  c.curiosity  = constrain((p1.curiosity  + p2.curiosity)  / 2.0f + ((random(-100, 101) / 100.0f) * 0.1f), 0.0f, 1.0f);
  c.trust      = constrain((p1.trust      + p2.trust)      / 2.0f + ((random(-100, 101) / 100.0f) * 0.1f), 0.0f, 1.0f);
  // Inherit shape OR mix: child gets one parent's shape, one's color (visible lineage)
  c.shape = (random(0, 2) == 0) ? p1.shape : p2.shape;
  c.color = (random(0, 2) == 0) ? p1.color : p2.color;
  // Lineage
  strncpy(c.parent1, p1.name, 3); c.parent1[3] = 0;
  strncpy(c.parent2, p2.name, 3); c.parent2[3] = 0;
  p1.numChildren++; p2.numChildren++;
  p1.lastReproTick = tick;
  p2.lastReproTick = tick;
  p1.soul = max(1, p1.soul - 4);
  p2.soul = max(1, p2.soul - 4);
  soulPool -= 10;
  c.soul = 10;
  // Initial trust between child and parents
  aiRelUpdate(c, p1.name, +50);
  aiRelUpdate(c, p2.name, +50);
  aiRelUpdate(p1, c.name, +40);
  aiRelUpdate(p2, c.name, +40);
  strcpy(p1.lastAction, "birth");
  snprintf(p1.lastReason, sizeof(p1.lastReason), "with %s -> %s", p2.name, c.name);
  strcpy(p2.lastAction, "birth");
  snprintf(p2.lastReason, sizeof(p2.lastReason), "with %s -> %s", p1.name, c.name);
  addEvent(0x07E0, "%s born to %s+%s", c.name, p1.name, p2.name);
}

void worldTick() {
  tick++;
  if (paramFoodRegrowRate > 0 && tick % paramFoodRegrowRate == 0) {
    for (int i = 0; i < 3; i++) {
      int x = random(0, WORLD_W), y = random(0, WORLD_H);
      if (world[y][x] == T_GRASS || world[y][x] == T_FOREST) world[y][x] = T_FOOD;
    }
  }
  if (paramMemorialDecay > 0 && tick % paramMemorialDecay == 0) {
    for (int y = 0; y < WORLD_H; y++)
      for (int x = 0; x < WORLD_W; x++)
        if (world[y][x] == T_MEMORIAL && random(0, 100) < 10) world[y][x] = T_GRASS;
  }
  for (int i = 0; i < MAX_AI; i++) aiTick(ais[i]);

  // Reproduction attempts — periodic; mutual-trust adjacent pairs
  if (reproEnabled && tick % 50 == 0) {
    for (int i = 0; i < MAX_AI; i++) {
      if (!ais[i].alive || ais[i].soul < 30) continue;
      for (int j = i + 1; j < MAX_AI; j++) {
        if (!ais[j].alive || ais[j].soul < 30) continue;
        int dx = ais[i].x - ais[j].x, dy = ais[i].y - ais[j].y;
        if (dx*dx + dy*dy > 2) continue;
        int t1 = aiRelGet(ais[i], ais[j].name);
        int t2 = aiRelGet(ais[j], ais[i].name);
        if (t1 >= 30 && t2 >= 30 && random(0, 100) < 15) {
          aiReproduce(ais[i], ais[j]);
          break;
        }
      }
    }
  }

  // Respawn from pool: newborns when population below cap
  int aliveCnt = 0;
  for (int i = 0; i < MAX_AI; i++) if (ais[i].alive) aliveCnt++;
  for (int i = 0; i < MAX_AI; i++)
    if (!ais[i].alive && soulPool >= 16 && aliveCnt < paramPopulationCap) {
      aiSpawn(i); aliveCnt++;
    }
}

// ---------------- RENDER (sprite-based, no flicker) ----------------
int selectedAI = 0;
bool mapDirty = true, panelDirty = true, hudDirty = true;

// Settings panel state
enum PanelMode { PANEL_AI, PANEL_SETTINGS };
PanelMode panelMode = PANEL_AI;
int settingsIdx = 0;

// Observer toggles
bool followMode   = false;
bool showFog      = false;
bool showFOV      = true;
bool showHearing  = false;
bool showSound    = true;    // draw ring on map when AI emits a sound

// Draw an AI as one of 8 shapes
void drawAIShape(TFT_eSprite &s, int cx, int cy, int r, uint8_t shape, uint16_t col, bool selected) {
  uint16_t outline = selected ? TFT_YELLOW : TFT_BLACK;
  switch (shape) {
    case 0:   // circle
      s.fillCircle(cx, cy, r, col); s.drawCircle(cx, cy, r, outline); break;
    case 1:   // square
      s.fillRect(cx - r, cy - r, r * 2 + 1, r * 2 + 1, col);
      s.drawRect(cx - r, cy - r, r * 2 + 1, r * 2 + 1, outline); break;
    case 2:   // triangle up
      s.fillTriangle(cx, cy - r, cx - r, cy + r, cx + r, cy + r, col);
      s.drawTriangle(cx, cy - r, cx - r, cy + r, cx + r, cy + r, outline); break;
    case 3:   // diamond
      s.fillTriangle(cx, cy - r, cx - r, cy, cx, cy + r, col);
      s.fillTriangle(cx, cy - r, cx + r, cy, cx, cy + r, col);
      s.drawLine(cx, cy - r, cx - r, cy, outline);
      s.drawLine(cx - r, cy, cx, cy + r, outline);
      s.drawLine(cx, cy + r, cx + r, cy, outline);
      s.drawLine(cx + r, cy, cx, cy - r, outline); break;
    case 4:   // triangle down
      s.fillTriangle(cx - r, cy - r, cx + r, cy - r, cx, cy + r, col);
      s.drawTriangle(cx - r, cy - r, cx + r, cy - r, cx, cy + r, outline); break;
    case 5:   // cross
      s.fillRect(cx - r, cy - r/2, r * 2 + 1, r + 1, col);
      s.fillRect(cx - r/2, cy - r, r + 1, r * 2 + 1, col); break;
    case 6:   // ring
      s.fillCircle(cx, cy, r, col);
      s.fillCircle(cx, cy, max(1, r/2), TFT_BLACK);
      if (selected) s.drawCircle(cx, cy, r, outline); break;
    case 7:   // pentagon-ish (5 sides via triangles)
      s.fillTriangle(cx, cy - r, cx - r, cy, cx - r/2, cy + r, col);
      s.fillTriangle(cx, cy - r, cx + r, cy, cx + r/2, cy + r, col);
      s.fillTriangle(cx - r/2, cy + r, cx + r/2, cy + r, cx, cy, col);
      break;
  }
}

uint16_t darken(uint16_t c, int amt) {
  int r = (c >> 11) & 0x1F; r = max(0, r - amt);
  int g = (c >> 5)  & 0x3F; g = max(0, g - amt*2);
  int b = c & 0x1F;         b = max(0, b - amt);
  return (r << 11) | (g << 5) | b;
}

void layoutPanels() {
  if (panelOpen) {
    PAN_W = PAN_W_OPEN;
    PAN_X = SW - PAN_W;
    MAP_W = SW - PAN_W - 2;
    MAP_X = 0;
  } else {
    PAN_W = 0; PAN_X = SW; MAP_W = SW; MAP_X = 0;
  }
  PAN_Y = HUD_H; PAN_H = SH - HUD_H;
  MAP_Y = HUD_H; MAP_H = SH - HUD_H;
}

void allocMapSprites() {
  mapSprite.setColorDepth(16);
  mapSprite.createSprite(MAP_W, MAP_H);
  panelSprite.setColorDepth(16);
  panelSprite.createSprite(PAN_W_OPEN, SH - HUD_H);
  hudSprite.setColorDepth(16);
  hudSprite.createSprite(SW, HUD_H);
}
void freeMapSprites() {
  mapSprite.deleteSprite(); panelSprite.deleteSprite(); hudSprite.deleteSprite();
}
void allocFullSprite() {
  fullSprite.setColorDepth(16);
  fullSprite.createSprite(SW, SH);
}
void freeFullSprite() {
  fullSprite.deleteSprite();
}
// legacy shims (old names still used elsewhere)
void allocSprites() { allocMapSprites(); }
void freeSprites()  { freeMapSprites();  }

void renderHUD() {
  hudSprite.fillSprite(TFT_BLACK);
  hudSprite.setTextSize(1);
  hudSprite.setTextColor(isNight() ? 0x3DDF : TFT_WHITE, TFT_BLACK);
  int alive = 0;
  for (int i = 0; i < MAX_AI; i++) if (ais[i].alive) alive++;
  const char* spd[] = {"PAUSE", "0.5x", "1x", "2x", "5x"};
  hudSprite.setCursor(2, 2);
  hudSprite.printf("t%05d pop%d pool%d %s %s",
    tick, alive, soulPool, spd[speedIdx], isNight() ? "NGT" : "DAY");
  // Event ticker — show the most recent event
  int latest = (eventHead - 1 + EVENT_LOG_SIZE) % EVENT_LOG_SIZE;
  if (eventLog[latest].text[0]) {
    hudSprite.setTextColor(eventLog[latest].col, TFT_BLACK);
    hudSprite.setCursor(2, 12);
    hudSprite.print(eventLog[latest].text);
  }
  hudSprite.drawFastHLine(0, HUD_H - 1, SW, TFT_DARKGREY);
  hudSprite.pushSprite(0, 0);
}

void renderMap() {
  mapSprite.fillSprite(TFT_BLACK);
  int nd = isNight() ? 4 : 0;
  int vtx = tilesVisX(), vty = tilesVisY();
  float ppx = tilePpx();
  float ppy = tilePpy();
  int maxCamX = max(0, WORLD_W - vtx);
  int maxCamY = max(0, WORLD_H - vty);
  camX = constrain(camX, 0, maxCamX);
  camY = constrain(camY, 0, maxCamY);

  // Tiles — compute int screen rects from float positions (eliminates gaps)
  for (int vy = 0; vy < vty; vy++) {
    int wy = camY + vy; if (wy < 0 || wy >= WORLD_H) continue;
    int sy  = (int)(vy * ppy);
    int sy2 = (int)((vy + 1) * ppy);
    int sh  = sy2 - sy;
    for (int vx = 0; vx < vtx; vx++) {
      int wx = camX + vx; if (wx < 0 || wx >= WORLD_W) continue;
      int sx  = (int)(vx * ppx);
      int sx2 = (int)((vx + 1) * ppx);
      int sw  = sx2 - sx;
      uint16_t c = TILE_COLOR[world[wy][wx]];
      if (nd) c = darken(c, nd);
      mapSprite.fillRect(sx, sy, sw, sh, c);
    }
  }

  // Fog of war overlay (for selected AI) — applied BEFORE drawing AIs
  if (showFog && ais[selectedAI].alive) {
    const AI& sel = ais[selectedAI];
    for (int vy = 0; vy < vty; vy++) {
      int wy = camY + vy;
      if (wy < 0 || wy >= WORLD_H) continue;
      int sy = (int)(vy * ppy), sh = (int)((vy+1) * ppy) - sy;
      for (int vx = 0; vx < vtx; vx++) {
        int wx = camX + vx;
        if (wx < 0 || wx >= WORLD_W) continue;
        int sx = (int)(vx * ppx), sw = (int)((vx+1) * ppx) - sx;
        if (!aiHasSeen(sel, wx, wy)) {
          mapSprite.fillRect(sx, sy, sw, sh, 0x18C3);
        }
      }
    }
  }
  int px = tilePx();   // integer tile size for radii/text
  // Hearing radius (selected AI)
  if (showHearing && ais[selectedAI].alive) {
    const AI& sel = ais[selectedAI];
    int cx = (int)((sel.x - camX) * ppx + ppx/2);
    int cy = (int)((sel.y - camY) * ppy + ppy/2);
    mapSprite.drawCircle(cx, cy, (int)(sel.hearing * ppx), 0x4A49);
  }
  // FOV cone (selected AI)
  if (showFOV && ais[selectedAI].alive) {
    const AI& sel = ais[selectedAI];
    int cx = (int)((sel.x - camX) * ppx + ppx/2);
    int cy = (int)((sel.y - camY) * ppy + ppy/2);
    int depth = sel.fov;
    int dpx = (int)(depth * ppx);
    int dpy = (int)(depth * ppy);
    int sw = cx, sh = cy, ex = cx, ey = cy;
    switch (sel.facing) {
      case 0: sw = cx - dpx; sh = cy - dpy;  ex = cx + dpx; ey = cy - dpy; break;
      case 1: sw = cx + dpx; sh = cy - dpy;  ex = cx + dpx; ey = cy + dpy; break;
      case 2: sw = cx - dpx; sh = cy + dpy;  ex = cx + dpx; ey = cy + dpy; break;
      case 3: sw = cx - dpx; sh = cy - dpy;  ex = cx - dpx; ey = cy + dpy; break;
    }
    mapSprite.drawLine(cx, cy, sw, sh, TFT_YELLOW);
    mapSprite.drawLine(cx, cy, ex, ey, TFT_YELLOW);
    mapSprite.drawLine(sw, sh, ex, ey, TFT_YELLOW);
  }
  // Trust bonds — thin yellow lines between mutually-trusting AIs
  for (int i = 0; i < MAX_AI; i++) {
    if (!ais[i].alive) continue;
    int vxi = ais[i].x - camX, vyi = ais[i].y - camY;
    if (vxi < 0 || vxi >= vtx || vyi < 0 || vyi >= vty) continue;
    int cxi = (int)(vxi * ppx + ppx/2), cyi = (int)(vyi * ppy + ppy/2);
    for (int j = i + 1; j < MAX_AI; j++) {
      if (!ais[j].alive) continue;
      int t1 = aiRelGet(ais[i], ais[j].name);
      int t2 = aiRelGet(ais[j], ais[i].name);
      if (t1 < 40 || t2 < 40) continue;
      int vxj = ais[j].x - camX, vyj = ais[j].y - camY;
      if (vxj < 0 || vxj >= vtx || vyj < 0 || vyj >= vty) continue;
      int cxj = (int)(vxj * ppx + ppx/2), cyj = (int)(vyj * ppy + ppy/2);
      uint16_t bondCol = (t1 >= 70 && t2 >= 70) ? 0xFFE0 : 0x5AEB;  // bright yellow for strong, dim for ally
      mapSprite.drawLine(cxi, cyi, cxj, cyj, bondCol);
    }
  }

  // AIs — each with their own shape and color, at interpolated pos
  unsigned long nowMs = millis();
  int tickMs = max(1, currentSpeedMs());
  for (int i = 0; i < MAX_AI; i++) {
    if (!ais[i].alive) continue;
    // interpolation factor 0..1
    float t = 0.0f;
    if (tickMs > 0) {
      t = (nowMs - ais[i].moveStartMs) / (float)tickMs;
      if (t < 0) t = 0; if (t > 1) t = 1;
    } else t = 1.0f;
    float fx = ais[i].prevX + (ais[i].x - ais[i].prevX) * t;
    float fy = ais[i].prevY + (ais[i].y - ais[i].prevY) * t;
    float vxf = fx - camX, vyf = fy - camY;
    if (vxf < -0.5f || vxf >= vtx || vyf < -0.5f || vyf >= vty) continue;
    int cx = (int)(vxf * ppx + ppx / 2);
    int cy = (int)(vyf * ppy + ppy / 2);
    int rMin = (int)(min(ppx, ppy) / 2 + 1);
    int r  = max(2, min(rMin, ais[i].soul / 12 + 2));
    // Monster aura — red pulsing outer ring
    if (isMonster(ais[i].soul)) {
      int pulse = (tick / 4) % 3;
      mapSprite.drawCircle(cx, cy, r + 3 + pulse, 0xF800);
    }
    drawAIShape(mapSprite, cx, cy, r, ais[i].shape, ais[i].color, i == selectedAI);
    // Health dot under AI (soul-level indicator)
    uint16_t hpCol = (ais[i].soul > 50) ? 0x07E0 :
                     (ais[i].soul > 20) ? 0xFFE0 : 0xF800;
    mapSprite.fillRect(cx - 2, cy + r + 1, 4, 1, hpCol);
    // First letter above the shape if tiles are big enough
    if (ppx >= 8.0f) {
      mapSprite.setTextSize(1);
      mapSprite.setTextColor(TFT_WHITE, TFT_BLACK);
      mapSprite.setCursor(cx - 2, cy - (int)(ppy/2) - 7);
      mapSprite.write(ais[i].name[0]);
    }
    // Facing tick for selected AI
    if (i == selectedAI) {
      int ffx = cx, ffy = cy;
      switch (ais[i].facing) {
        case 0: ffy -= r + 3; break;
        case 1: ffx += r + 3; break;
        case 2: ffy += r + 3; break;
        case 3: ffx -= r + 3; break;
      }
      mapSprite.drawLine(cx, cy, ffx, ffy, TFT_YELLOW);
    }
    // Sound ring animation (expands over ~3 ticks)
    if (showSound && ais[i].lastEmittedTick >= 0) {
      int age = tick - ais[i].lastEmittedTick;
      if (age >= 0 && age < 3) {
        int ringPx = (int)((age + 1) * min(ppx, ppy));
        // Color by concept
        static const uint16_t cCol[N_CONCEPTS] = {
          0xF800, 0x3DDF, 0xFC00, 0xF81F, 0x07E0, 0xFBE0, 0xF800, 0xC618
        };
        int cIdx = ais[i].lastEmittedConcept;
        if (cIdx < 0 || cIdx >= N_CONCEPTS) cIdx = 0;
        mapSprite.drawCircle(cx, cy, ringPx, cCol[cIdx]);
      }
    }
  }
  mapSprite.pushSprite(MAP_X, MAP_Y);
}

// ============ True settings system ============
enum SettingType { ST_HEADER, ST_TOGGLE, ST_ENUM, ST_INT, ST_ACTION };

// Tunable params are defined earlier near the top (used by aiTick/worldTick).

// Forward decls for actions
void act_resetWorld();
void act_resetAIs();
void act_resetDefaults();
void act_killSelected();

struct SettingItem {
  SettingType  type;
  const char*  label;
  void*        ptr;          // bool* / int*
  int          mn, mx, step;
  const char** enumLabels;
  void       (*fn)();
};

static const char* SPEED_LABELS[] = {"PAUSE", "0.5x", "1x", "2x", "5x"};
static const char* ZOOM_LABELS[]  = {"far", "mid", "near", "huge"};

SettingItem SETTINGS[] = {
  { ST_HEADER, "-- DISPLAY --",   nullptr,          0,0,0, nullptr, nullptr },
  { ST_ENUM,   "Zoom",            &zoomIdx,         0,3,1, ZOOM_LABELS, nullptr },
  { ST_ENUM,   "Speed",           &speedIdx,        0,4,1, SPEED_LABELS, nullptr },
  { ST_TOGGLE, "Follow sel AI",   &followMode,      0,0,0, nullptr, nullptr },
  { ST_TOGGLE, "Show FOV cone",   &showFOV,         0,0,0, nullptr, nullptr },
  { ST_TOGGLE, "Show fog",        &showFog,         0,0,0, nullptr, nullptr },
  { ST_TOGGLE, "Show hearing",    &showHearing,     0,0,0, nullptr, nullptr },
  { ST_TOGGLE, "Show sounds",     &showSound,       0,0,0, nullptr, nullptr },

  { ST_HEADER, "-- SIMULATION --",nullptr,          0,0,0, nullptr, nullptr },
  { ST_TOGGLE, "Q-Learning",      &learningEnabled, 0,0,0, nullptr, nullptr },
  { ST_TOGGLE, "Language",        &langEnabled,     0,0,0, nullptr, nullptr },
  { ST_TOGGLE, "Reproduction",    &reproEnabled,    0,0,0, nullptr, nullptr },

  { ST_HEADER, "-- WORLD --",     nullptr,          0,0,0, nullptr, nullptr },
  { ST_INT,    "Food regrow",     &paramFoodRegrowRate, 10,  300, 10,  nullptr, nullptr },
  { ST_INT,    "Random hurt",     &paramRandomHurtRate,  0,   50,  1,  nullptr, nullptr },
  { ST_INT,    "Mem decay",       &paramMemorialDecay, 500, 10000, 500, nullptr, nullptr },
  { ST_INT,    "Pop cap",         &paramPopulationCap,   1, MAX_AI,  1, nullptr, nullptr },

  { ST_HEADER, "-- DATA --",      nullptr,          0,0,0, nullptr, nullptr },
  { ST_ACTION, "Reset AIs",       nullptr,          0,0,0, nullptr, act_resetAIs },
  { ST_ACTION, "Reset world",     nullptr,          0,0,0, nullptr, act_resetWorld },
  { ST_ACTION, "Kill selected",   nullptr,          0,0,0, nullptr, act_killSelected },
  { ST_ACTION, "Defaults",        nullptr,          0,0,0, nullptr, act_resetDefaults },
};
static const int SETTINGS_COUNT = sizeof(SETTINGS) / sizeof(SETTINGS[0]);
int settingsScrollTop = 0;    // first visible item

// Count how many non-header items for navigation (we still allow landing on headers to skip)
bool settingIsSelectable(int idx) { return SETTINGS[idx].type != ST_HEADER; }

void act_resetWorld() {
  genWorld();
  for (int i = 0; i < MAX_AI; i++) if (ais[i].alive) { soulPool += ais[i].soul; ais[i].alive = false; }
  for (int i = 0; i < MEMORIAL_MAX; i++) memorials[i].used = false;
  for (int i = 0; i < EVENT_LOG_SIZE; i++) eventLog[i].text[0] = 0;
  soulPool = SOUL_POOL_MAX;
  for (int i = 0; i < MAX_AI; i++) aiSpawn(i);
  tick = 0;
  addEvent(TFT_CYAN, "World reset");
}
void act_resetAIs() {
  for (int i = 0; i < MAX_AI; i++) if (ais[i].alive) { soulPool += ais[i].soul; ais[i].alive = false; }
  soulPool = SOUL_POOL_MAX;
  for (int i = 0; i < MAX_AI; i++) aiSpawn(i);
}
void act_killSelected() {
  if (ais[selectedAI].alive) aiDie(ais[selectedAI], "user");
}
void act_resetDefaults() {
  followMode = false; showFog = false; showFOV = true;
  showHearing = false; showSound = true;
  learningEnabled = true; langEnabled = true; reproEnabled = true;
  speedIdx = 2; zoomIdx = 1;
  paramFoodRegrowRate = 60; paramRandomHurtRate = 3;
  paramMemorialDecay = 3000; paramPopulationCap = MAX_AI;
}

void renderSettingsPanel() {
  panelSprite.fillSprite(TFT_BLACK);
  // Title bar
  panelSprite.setTextColor(TFT_CYAN, TFT_BLACK);
  panelSprite.setTextSize(2);
  panelSprite.setCursor(2, 2); panelSprite.print("Settings");
  panelSprite.setTextSize(1);
  panelSprite.setTextColor(TFT_DARKGREY, TFT_BLACK);
  panelSprite.setCursor(85, 8); panelSprite.printf("%d/%d", settingsIdx+1, SETTINGS_COUNT);
  panelSprite.drawFastHLine(0, 20, PAN_W, TFT_DARKGREY);

  // List area
  int listTop = 24;
  int listBot = PAN_H - 24;
  int rowH    = 10;
  int visibleRows = (listBot - listTop) / rowH;

  // Auto-scroll so settingsIdx stays visible
  if (settingsIdx < settingsScrollTop) settingsScrollTop = settingsIdx;
  if (settingsIdx >= settingsScrollTop + visibleRows) settingsScrollTop = settingsIdx - visibleRows + 1;
  if (settingsScrollTop < 0) settingsScrollTop = 0;

  int y = listTop;
  for (int i = settingsScrollTop; i < SETTINGS_COUNT && i < settingsScrollTop + visibleRows; i++) {
    SettingItem& it = SETTINGS[i];
    bool sel = (i == settingsIdx);

    if (it.type == ST_HEADER) {
      panelSprite.setTextColor(0x3DDF, TFT_BLACK);
      panelSprite.setCursor(2, y);
      panelSprite.print(it.label);
      y += rowH;
      continue;
    }

    // Row highlight
    uint16_t bg = sel ? 0x2124 : TFT_BLACK;
    if (sel) panelSprite.fillRect(0, y - 1, PAN_W - 3, rowH, bg);

    panelSprite.setTextColor(sel ? TFT_YELLOW : TFT_WHITE, bg);
    panelSprite.setCursor(2, y);
    panelSprite.print(sel ? ">" : " ");
    panelSprite.print(it.label);

    // Value (right-aligned)
    char buf[16] = {0};
    switch (it.type) {
      case ST_TOGGLE: {
        bool v = *(bool*)it.ptr;
        snprintf(buf, sizeof(buf), "[%s]", v ? "ON" : "OFF");
        break;
      }
      case ST_ENUM: {
        int v = *(int*)it.ptr;
        snprintf(buf, sizeof(buf), "[%s]", it.enumLabels[v]);
        break;
      }
      case ST_INT: {
        int v = *(int*)it.ptr;
        snprintf(buf, sizeof(buf), "[%d]", v);
        break;
      }
      case ST_ACTION:
        snprintf(buf, sizeof(buf), "[do]");
        break;
      default: break;
    }
    if (buf[0]) {
      int bufW = strlen(buf) * 6;
      panelSprite.setTextColor(sel ? TFT_CYAN : TFT_LIGHTGREY, bg);
      panelSprite.setCursor(PAN_W - bufW - 5, y);
      panelSprite.print(buf);
    }
    y += rowH;
  }

  // Scrollbar on the right edge
  if (SETTINGS_COUNT > visibleRows) {
    int rangeH = listBot - listTop;
    int barH = max(4, (visibleRows * rangeH) / SETTINGS_COUNT);
    int barY = listTop + (settingsScrollTop * rangeH) / SETTINGS_COUNT;
    panelSprite.fillRect(PAN_W - 3, listTop, 2, rangeH, 0x1082);
    panelSprite.fillRect(PAN_W - 3, barY,    2, barH,   TFT_CYAN);
  }

  // Footer
  panelSprite.drawFastHLine(0, PAN_H - 23, PAN_W, TFT_DARKGREY);
  panelSprite.setTextColor(TFT_DARKGREY, TFT_BLACK);
  panelSprite.setCursor(2, PAN_H - 20); panelSprite.print("W/S:nav  A/D:change");
  panelSprite.setCursor(2, PAN_H - 11); panelSprite.print("spc:do   m:close");
  panelSprite.pushSprite(PAN_X, PAN_Y);
}

void renderPanel() {
  if (!panelOpen) return;
  if (panelMode == PANEL_SETTINGS) { renderSettingsPanel(); return; }
  panelSprite.fillSprite(TFT_BLACK);
  AI& a = ais[selectedAI];
  panelSprite.setTextSize(1);

  // -------- 1) Name (big) + alive indicator
  int y = 2;
  panelSprite.setTextColor(a.alive ? TFT_CYAN : TFT_RED, TFT_BLACK);
  panelSprite.setTextSize(2);
  panelSprite.setCursor(4, y); panelSprite.print(a.name);
  panelSprite.setTextSize(1);
  // Shape mini-icon beside name
  if (a.alive) drawAIShape(panelSprite, PAN_W_OPEN - 10, y + 7, 6, a.shape, a.color, false);
  y += 18;

  if (!a.alive) {
    panelSprite.setTextColor(TFT_DARKGREY, TFT_BLACK);
    panelSprite.setCursor(4, y); panelSprite.print("(dead)"); y += 10;
    panelSprite.setCursor(4, y); panelSprite.printf("age %d k%d h%d", a.age, a.kills, a.helps);
    panelSprite.pushSprite(PAN_X, PAN_Y);
    return;
  }

  // -------- 2) Vitals row 1: soul, age
  float ageD = a.age / 2400.0f;
  const char* stage = a.age < 200 ? "inf" : a.age < 800 ? "yng" :
                      a.age < 3000 ? "adu" : "eld";
  panelSprite.setTextColor(TFT_WHITE, TFT_BLACK);
  panelSprite.setCursor(4, y);
  panelSprite.printf("S%d %.1fd %s", a.soul, ageD, stage);
  y += 9;
  panelSprite.setCursor(4, y);
  panelSprite.printf("k%d h%d f%d", a.kills, a.helps, a.foodEaten);
  y += 9;
  // Inventory + trap status
  panelSprite.setTextColor(a.carrying ? 0xFFE0 : TFT_DARKGREY, TFT_BLACK);
  panelSprite.setCursor(4, y);
  panelSprite.printf("carry:%s", CARRY_NAMES[a.carrying]);
  if (a.trapTick > 0) {
    panelSprite.setTextColor(TFT_RED, TFT_BLACK);
    panelSprite.setCursor(70, y);
    panelSprite.print("TRAP");
  }
  y += 11;

  // -------- 3) Needs — 3 compact horizontal bars with inline value
  int bw = PAN_W_OPEN - 42;      // room for label and value
  const char* nn[3] = {"hun", "thi", "ene"};
  float nvals[3] = {a.hunger, a.thirst, a.energy};
  uint16_t ncols[3] = {0xF800, 0x3DDF, 0x07E0};
  for (int i = 0; i < 3; i++) {
    panelSprite.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
    panelSprite.setCursor(2, y); panelSprite.print(nn[i]);
    panelSprite.drawRect(22, y, bw, 5, TFT_DARKGREY);
    panelSprite.fillRect(23, y + 1, (int)(nvals[i] * (bw - 2)), 3, ncols[i]);
    panelSprite.setCursor(PAN_W_OPEN - 18, y); panelSprite.printf("%2d", (int)(nvals[i] * 99));
    y += 7;
  }
  y += 2;

  // -------- 4) Disposition + senses on one compact line
  panelSprite.setTextColor(TFT_YELLOW, TFT_BLACK);
  panelSprite.setCursor(2, y); panelSprite.printf("a%.1fc%.1ft%.1f", a.aggression, a.curiosity, a.trust);
  y += 9;
  panelSprite.setCursor(2, y); panelSprite.printf("fov%d ear%d",  a.fov, a.hearing);
  y += 11;

  // -------- 5) Brain state line
  panelSprite.setTextColor(TFT_CYAN, TFT_BLACK);
  int st = a.currentState < 0 ? 0 : a.currentState;
  bool waterK = st >= 24; if (waterK) st -= 24;
  bool foodK  = st >= 12; if (foodK)  st -= 12;
  int threat  = st / 4;   st -= threat * 4;
  int need    = st;
  const char* needs[4] = {"OK","FOOD","WATR","REST"};
  const char* thrN[3]  = {"-",  "prey","ENMY"};
  panelSprite.setCursor(2, y);
  panelSprite.printf("S%d %s t%s F%c W%c",
                     a.currentState, needs[need], thrN[threat],
                     foodK ? '+' : '-', waterK ? '+' : '-');
  y += 9;
  panelSprite.setTextColor(a.wasRandom ? 0xF81F : TFT_GREEN, TFT_BLACK);
  panelSprite.setCursor(2, y);
  panelSprite.printf("eps%.2f %s", a.epsilon, a.wasRandom ? "RAND" : "ok");
  y += 11;

  // -------- 6) Top-3 Q actions
  if (a.currentState >= 0) {
    // find top 3
    int order[Q_ACTIONS]; for (int i = 0; i < Q_ACTIONS; i++) order[i] = i;
    // partial sort by Q value descending (insertion)
    for (int i = 1; i < Q_ACTIONS; i++) {
      int key = order[i];
      int kq = a.qtable[a.currentState][key];
      int j = i - 1;
      while (j >= 0 && a.qtable[a.currentState][order[j]] < kq) { order[j+1] = order[j]; j--; }
      order[j+1] = key;
    }
    for (int i = 0; i < 3; i++) {
      int ai = order[i];
      bool picked = (ai == a.chosenAction);
      panelSprite.setTextColor(picked ? TFT_YELLOW : TFT_LIGHTGREY, TFT_BLACK);
      panelSprite.setCursor(2, y);
      float qv = a.qtable[a.currentState][ai] / 10.0f;
      panelSprite.printf("%s%s %+.1f", picked ? ">" : " ", ACT_NAME[ai], qv);
      y += 8;
    }
  }
  y += 2;

  // -------- 7) Language — compact one-line mouth summary + last heard
  panelSprite.setTextColor(0xFBE0, TFT_BLACK);
  panelSprite.setCursor(2, y); panelSprite.print("mouth f/w/e/p:");
  y += 8;
  panelSprite.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
  panelSprite.setCursor(2, y);
  panelSprite.printf("%d%d%d%d-%d%d%d%d",
    a.mouth[C_FOOD], a.mouth[C_WATER], a.mouth[C_ENEMY], a.mouth[C_PAIN],
    a.mouth[C_FRIEND], a.mouth[C_DANGER], a.mouth[C_KILL], a.mouth[C_CALM]);
  y += 9;
  if (a.lastHeardSound >= 0 && tick - a.lastHeardTick < 40) {
    int bestC = 0;
    for (int c = 1; c < N_CONCEPTS; c++)
      if (a.ear[a.lastHeardSound][c] > a.ear[a.lastHeardSound][bestC]) bestC = c;
    panelSprite.setTextColor(TFT_YELLOW, TFT_BLACK);
    panelSprite.setCursor(2, y);
    panelSprite.printf("hr %s S%d>%s", a.lastHeardFrom, a.lastHeardSound, CONCEPT_NAME[bestC]);
    y += 10;
  } else {
    panelSprite.setTextColor(TFT_DARKGREY, TFT_BLACK);
    panelSprite.setCursor(2, y); panelSprite.print("(silent)");
    y += 10;
  }

  // -------- 8) Relationships (top 3 by |trust|) + lineage
  panelSprite.setTextColor(0xFC9E, TFT_BLACK);
  panelSprite.setCursor(2, y); panelSprite.print("rel:");
  // Parents / kids one-liner
  if (a.parent1[0] || a.numChildren) {
    panelSprite.setTextColor(TFT_DARKGREY, TFT_BLACK);
    int tx = 26;
    if (a.parent1[0]) {
      panelSprite.setCursor(tx, y); panelSprite.printf("p:%s", a.parent1); tx += 28;
    }
    if (a.numChildren) { panelSprite.setCursor(tx, y); panelSprite.printf("c:%d", a.numChildren); }
  }
  y += 8;
  // Sort relationships by abs(trust) descending (small array, just scan)
  int order[4] = {0, 1, 2, 3};
  for (int i = 1; i < 4; i++) {
    int k = order[i]; int kv = abs((int)a.rel_trust[k]);
    int j = i - 1;
    while (j >= 0 && abs((int)a.rel_trust[order[j]]) < kv) { order[j+1] = order[j]; j--; }
    order[j+1] = k;
  }
  int shown = 0;
  for (int i = 0; i < 4 && shown < 3; i++) {
    int si = order[i];
    if (!a.rel_name[si][0]) continue;
    int t = a.rel_trust[si];
    uint16_t c = (t > 30) ? TFT_GREEN : (t < -30) ? 0xF800 : TFT_LIGHTGREY;
    panelSprite.setTextColor(c, TFT_BLACK);
    panelSprite.setCursor(2, y);
    panelSprite.printf("%s %+d", a.rel_name[si], t);
    y += 8;
    shown++;
  }
  if (shown == 0) { panelSprite.setTextColor(TFT_DARKGREY, TFT_BLACK);
    panelSprite.setCursor(2, y); panelSprite.print("(none)"); y += 8;
  }

  // -------- 8) Action line
  panelSprite.setTextColor(TFT_GREEN, TFT_BLACK);
  panelSprite.setCursor(2, y); panelSprite.print(">"); panelSprite.print(a.lastAction);
  y += 8;
  panelSprite.setTextColor(TFT_DARKGREY, TFT_BLACK);
  panelSprite.setCursor(2, y); panelSprite.print(a.lastReason);
  y += 8;

  // -------- 9) Position + facing (bottom)
  int bottomY = PAN_H - 8;
  panelSprite.setTextColor(TFT_DARKGREY, TFT_BLACK);
  panelSprite.setCursor(2, bottomY);
  const char* dirStr[4] = {"N", "E", "S", "W"};
  panelSprite.printf("@%d,%d f%s", a.x, a.y, dirStr[a.facing]);

  panelSprite.pushSprite(PAN_X, PAN_Y);
}

// ---------------- EXPANDED VIEW ----------------
// Helper: draw a circular gauge (filled from top clockwise by `val` 0..1).
void drawGauge(TFT_eSprite &s, int cx, int cy, int r, float val, uint16_t col, const char* label, float dispValue) {
  val = max(0.0f, min(1.0f, val));
  // Outer ring
  s.drawCircle(cx, cy, r,     TFT_DARKGREY);
  s.drawCircle(cx, cy, r - 1, TFT_DARKGREY);
  // Filled arc as radial lines
  int segments = (int)(val * 60.0f);
  for (int i = 0; i < segments; i++) {
    float a = -PI/2.0f + (i / 60.0f) * (2.0f * PI);
    int ex = cx + (int)(cosf(a) * (r - 3));
    int ey = cy + (int)(sinf(a) * (r - 3));
    s.drawLine(cx, cy, ex, ey, col);
  }
  // Center text (value)
  s.setTextSize(1);
  s.setTextColor(TFT_WHITE, TFT_BLACK);
  char buf[6]; snprintf(buf, sizeof(buf), "%.0f%%", dispValue * 100.0f);
  int tw = strlen(buf) * 6;
  s.setCursor(cx - tw/2, cy - 3); s.print(buf);
  // Label below
  s.setTextColor(col, TFT_BLACK);
  int lw = strlen(label) * 6;
  s.setCursor(cx - lw/2, cy + r + 3); s.print(label);
}

// Doom-style raycaster. Casts one ray per screen column, draws wall slice at
// correct perspective height. Solid tiles (forest, stone, built) are walls.
// Ground = grass green, sky = dim blue (darker at night).
void drawPOV(TFT_eSprite &s, int ox, int oy, int w, int h, const AI& a) {
  uint16_t sky = isNight() ? 0x0841 : 0x4A5F;
  uint16_t gnd = darken(TILE_COLOR[T_GRASS], isNight() ? 4 : 0);

  // Facing direction unit vector
  float dirX = 0, dirY = 0;
  switch (a.facing) {
    case 0: dirX =  0; dirY = -1; break;
    case 1: dirX =  1; dirY =  0; break;
    case 2: dirX =  0; dirY =  1; break;
    case 3: dirX = -1; dirY =  0; break;
  }
  // Camera plane perpendicular to direction, ~66° FOV
  float planeX = -dirY * 0.66f;
  float planeY =  dirX * 0.66f;
  float posX   = a.x + 0.5f;
  float posY   = a.y + 0.5f;

  // Z-buffer (per-column wall depth) for sprite occlusion
  const int ZBUF_MAX = 180;
  float zBuffer[ZBUF_MAX];
  for (int i = 0; i < ZBUF_MAX; i++) zBuffer[i] = 1e9f;

  int horizon = h / 2;

  // Walls
  for (int x = 0; x < w; x++) {
    float cameraX = 2.0f * x / (float)w - 1.0f;
    float rayDirX = dirX + planeX * cameraX;
    float rayDirY = dirY + planeY * cameraX;
    int mapX = (int)posX;
    int mapY = (int)posY;
    float deltaDistX = (rayDirX == 0) ? 1e30f : fabsf(1.0f / rayDirX);
    float deltaDistY = (rayDirY == 0) ? 1e30f : fabsf(1.0f / rayDirY);
    float sideDistX, sideDistY;
    int stepX, stepY;
    if (rayDirX < 0) { stepX = -1; sideDistX = (posX - mapX) * deltaDistX; }
    else             { stepX =  1; sideDistX = (mapX + 1.0f - posX) * deltaDistX; }
    if (rayDirY < 0) { stepY = -1; sideDistY = (posY - mapY) * deltaDistY; }
    else             { stepY =  1; sideDistY = (mapY + 1.0f - posY) * deltaDistY; }

    int hit = 0, side = 0;
    Tile hitTile = T_GRASS;
    int steps = 20;
    while (!hit && steps-- > 0) {
      if (sideDistX < sideDistY) { sideDistX += deltaDistX; mapX += stepX; side = 0; }
      else                        { sideDistY += deltaDistY; mapY += stepY; side = 1; }
      if (mapX < 0 || mapX >= WORLD_W || mapY < 0 || mapY >= WORLD_H) break;
      Tile t = (Tile)world[mapY][mapX];
      if (isSolid(t)) { hit = 1; hitTile = t; }
    }

    if (hit) {
      float perpWallDist = (side == 0) ? (sideDistX - deltaDistX) : (sideDistY - deltaDistY);
      if (perpWallDist < 0.01f) perpWallDist = 0.01f;
      if (x < ZBUF_MAX) zBuffer[x] = perpWallDist;
      int lineH = (int)(h / perpWallDist);
      if (lineH > h) lineH = h;
      int drawStart = horizon - lineH / 2;
      int drawEnd   = horizon + lineH / 2;
      if (drawStart < 0) drawStart = 0;
      if (drawEnd > h)   drawEnd   = h;

      uint16_t wallC = TILE_COLOR[hitTile];
      if (hitTile == T_FOREST) wallC = 0x1A25;
      if (hitTile == T_STONE)  wallC = 0x8C51;
      if (hitTile == T_BUILT)  wallC = 0xA534;
      if (side == 1)           wallC = darken(wallC, 3);
      if (isNight())           wallC = darken(wallC, 4);
      // Distance fog — darker as walls get far away
      int fogAmt = (int)(perpWallDist * 0.8f);
      if (fogAmt > 10) fogAmt = 10;
      if (fogAmt > 0) wallC = darken(wallC, fogAmt);

      s.drawFastVLine(ox + x, oy,                drawStart,            sky);
      s.drawFastVLine(ox + x, oy + drawStart,    drawEnd - drawStart,  wallC);
      s.drawFastVLine(ox + x, oy + drawEnd,      h - drawEnd,          gnd);
    } else {
      s.drawFastVLine(ox + x, oy,         horizon,     sky);
      s.drawFastVLine(ox + x, oy + horizon, h - horizon, gnd);
    }
  }

  // Sprites: other AIs + food/memorial markers as billboards
  struct Spr { float tx, ty; uint16_t col; int kind; };     // kind: 0=ai, 1=food, 2=memorial
  Spr sprites[64];
  int ns = 0;
  for (int i = 0; i < MAX_AI && ns < 64; i++) {
    if (!ais[i].alive) continue;
    if (ais[i].x == a.x && ais[i].y == a.y) continue;
    sprites[ns++] = { ais[i].x + 0.5f - posX, ais[i].y + 0.5f - posY, ais[i].color, 0 };
  }
  // Scan a small neighborhood for food/memorials
  for (int dy = -8; dy <= 8 && ns < 64; dy++)
    for (int dx = -8; dx <= 8 && ns < 64; dx++) {
      int tx = a.x + dx, ty = a.y + dy;
      if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) continue;
      if (world[ty][tx] == T_FOOD)
        sprites[ns++] = { tx + 0.5f - posX, ty + 0.5f - posY, TFT_RED, 1 };
      else if (world[ty][tx] == T_MEMORIAL)
        sprites[ns++] = { tx + 0.5f - posX, ty + 0.5f - posY, TFT_YELLOW, 2 };
      else if (world[ty][tx] == T_PIT)
        sprites[ns++] = { tx + 0.5f - posX, ty + 0.5f - posY, 0x2104, 3 };
    }

  float invDet = 1.0f / (planeX * dirY - dirX * planeY);
  // sort sprites by distance (far to near) — simple insertion sort
  for (int i = 1; i < ns; i++) {
    Spr key = sprites[i];
    float keyD2 = key.tx*key.tx + key.ty*key.ty;
    int j = i - 1;
    while (j >= 0 && (sprites[j].tx*sprites[j].tx + sprites[j].ty*sprites[j].ty) < keyD2) {
      sprites[j+1] = sprites[j]; j--;
    }
    sprites[j+1] = key;
  }
  for (int i = 0; i < ns; i++) {
    float transX = invDet * (dirY * sprites[i].tx - dirX * sprites[i].ty);
    float transY = invDet * (-planeY * sprites[i].tx + planeX * sprites[i].ty);
    if (transY <= 0.1f) continue;
    int screenX = (int)((w / 2.0f) * (1.0f + transX / transY));
    int sprH = abs((int)(h / transY));
    int sprW = sprH;
    if (sprites[i].kind != 0) { sprH /= 3; sprW /= 3; }
    int y0 = horizon - sprH / 2;
    int y1 = horizon + sprH / 2;
    int x0 = screenX - sprW / 2;
    int x1 = screenX + sprW / 2;
    if (y0 < 0) y0 = 0; if (y1 > h) y1 = h;
    // Fog the sprite color by distance
    uint16_t col = sprites[i].col;
    int fog = (int)(transY * 0.8f);
    if (fog > 10) fog = 10;
    if (fog > 0) col = darken(col, fog);
    // Memorial pulse glow
    if (sprites[i].kind == 2) {
      int pulse = (tick % 20) < 10 ? 2 : 0;
      col = TFT_YELLOW;
      sprH += pulse * 2;
      y0 -= pulse; y1 += pulse;
    }
    // Pits: draw as low dark rectangle just below horizon (a hole in the ground)
    if (sprites[i].kind == 3) {
      sprH /= 2; sprW /= 1;      // wider than tall
      y0 = horizon + sprH / 3;
      y1 = horizon + sprH;
      if (y1 > h) y1 = h;
    }
    for (int xs = x0; xs < x1; xs++) {
      if (xs < 0 || xs >= w) continue;
      if (xs < ZBUF_MAX && zBuffer[xs] <= transY) continue;
      s.drawFastVLine(ox + xs, oy + y0, y1 - y0, col);
    }
  }

  // Border + label
  s.drawRect(ox, oy, w, h, TFT_DARKGREY);
  s.setTextColor(TFT_DARKGREY);
  s.setCursor(ox + 2, oy + 2); s.print("POV");
  // Compass in corner (shows which way is north)
  s.setCursor(ox + w - 10, oy + 2);
  const char* d[4] = {"N", "E", "S", "W"};
  s.setTextColor(TFT_YELLOW);
  s.print(d[a.facing]);
}

// Stippled semi-transparent overlay (every other pixel darkened)
void stippleBox(TFT_eSprite &s, int x, int y, int w, int h) {
  for (int yy = y; yy < y + h; yy++) {
    int start = x + (yy & 1);
    for (int xx = start; xx < x + w; xx += 2)
      s.drawPixel(xx, yy, TFT_BLACK);
  }
}
// Text with 1-pixel dark shadow for readability on any background
void drawShadowText(TFT_eSprite &s, int x, int y, uint16_t col, const char* txt) {
  s.setTextColor(TFT_BLACK);
  s.setCursor(x + 1, y + 1); s.print(txt);
  s.setTextColor(col);
  s.setCursor(x, y); s.print(txt);
}

// Fullscreen POV with overlays: name, stats, action, Q-bars, compass.
void renderPOVFullscreen() {
  AI& a = ais[selectedAI];
  // Fill entire screen with POV render
  drawPOV(fullSprite, 0, 0, SW, SH, a);

  // ---------- Top-left: NAME + shape (stippled dark overlay) ----------
  stippleBox(fullSprite, 0, 0, 92, 26);
  fullSprite.setTextSize(2);
  drawShadowText(fullSprite, 4, 4, a.alive ? TFT_CYAN : TFT_RED, a.name);
  fullSprite.setTextSize(1);
  if (a.alive) drawAIShape(fullSprite, 80, 12, 6, a.shape, a.color, false);

  // ---------- Top-right: state, soul, age, compass ----------
  stippleBox(fullSprite, SW - 112, 0, 112, 50);
  int st = a.currentState < 0 ? 0 : a.currentState;
  bool waterK = st >= 24; if (waterK) st -= 24;
  bool foodK  = st >= 12; if (foodK)  st -= 12;
  int threat  = st / 4;   st -= threat * 4;
  int need    = st;
  const char* needs[4] = {"OK","FOOD","WATR","REST"};
  const char* thrN[3]  = {"-","prey","ENMY"};
  const char* dirs[4]  = {"N","E","S","W"};
  char buf[28];
  snprintf(buf, sizeof(buf), "%s t:%s F%c W%c", needs[need], thrN[threat],
           foodK ? '+' : '-', waterK ? '+' : '-');
  drawShadowText(fullSprite, SW - 108, 2, TFT_YELLOW, buf);
  snprintf(buf, sizeof(buf), "S%d a%.1fd", a.soul, a.age / 2400.0f);
  drawShadowText(fullSprite, SW - 108, 12, TFT_WHITE, buf);
  snprintf(buf, sizeof(buf), "eps%.2f %s", a.epsilon, a.wasRandom ? "RAND" : "ok");
  drawShadowText(fullSprite, SW - 108, 22, a.wasRandom ? 0xF81F : TFT_GREEN, buf);
  // Compass arrow
  int cx = SW - 14, cy = 40;
  fullSprite.drawCircle(cx, cy, 8, TFT_WHITE);
  int ax = cx, ay = cy;
  switch (a.facing) {
    case 0: ay = cy - 6; break;
    case 1: ax = cx + 6; break;
    case 2: ay = cy + 6; break;
    case 3: ax = cx - 6; break;
  }
  fullSprite.drawLine(cx, cy, ax, ay, TFT_YELLOW);
  fullSprite.fillCircle(ax, ay, 2, TFT_YELLOW);
  drawShadowText(fullSprite, cx - 3, cy + 10, TFT_WHITE, dirs[a.facing]);

  // ---------- Left mid: 3 need circles with values ----------
  stippleBox(fullSprite, 0, 54, 56, 70);
  drawGauge(fullSprite, 14, 66, 9, a.hunger, 0xF800, "h", a.hunger);
  drawGauge(fullSprite, 42, 66, 9, a.thirst, 0x3DDF, "t", a.thirst);
  drawGauge(fullSprite, 28, 100, 9, a.energy, 0x07E0, "e", a.energy);

  // ---------- Right mid: top-3 relationships + parents ----------
  stippleBox(fullSprite, SW - 90, 56, 90, 54);
  drawShadowText(fullSprite, SW - 86, 58, 0xFC9E, "rel:");
  // Sort rels
  int order[4] = {0, 1, 2, 3};
  for (int i = 1; i < 4; i++) {
    int k = order[i]; int kv = abs((int)a.rel_trust[k]);
    int j = i - 1;
    while (j >= 0 && abs((int)a.rel_trust[order[j]]) < kv) { order[j+1] = order[j]; j--; }
    order[j+1] = k;
  }
  int ry = 68;
  int shown = 0;
  for (int i = 0; i < 4 && shown < 3; i++) {
    int si = order[i];
    if (!a.rel_name[si][0]) continue;
    int t = a.rel_trust[si];
    uint16_t c = (t > 30) ? TFT_GREEN : (t < -30) ? 0xF800 : TFT_LIGHTGREY;
    snprintf(buf, sizeof(buf), "%s %+d", a.rel_name[si], t);
    drawShadowText(fullSprite, SW - 86, ry, c, buf);
    ry += 10;
    shown++;
  }
  if (a.parent1[0]) {
    snprintf(buf, sizeof(buf), "p:%s %s", a.parent1, a.parent2);
    drawShadowText(fullSprite, SW - 86, 100, TFT_DARKGREY, buf);
  }

  // ---------- Bottom: action bar + compact Q-bars ----------
  int qY = SH - 60;
  stippleBox(fullSprite, 0, qY, SW, 60);
  // Action name + reason
  drawShadowText(fullSprite, 4, qY + 2, TFT_GREEN, ">");
  drawShadowText(fullSprite, 12, qY + 2, TFT_GREEN, a.lastAction);
  drawShadowText(fullSprite, 4, qY + 12, TFT_LIGHTGREY, a.lastReason);
  // Position
  snprintf(buf, sizeof(buf), "@%d,%d", a.x, a.y);
  drawShadowText(fullSprite, SW - 50, qY + 2, TFT_DARKGREY, buf);
  // Language snippet
  if (a.lastHeardSound >= 0 && tick - a.lastHeardTick < 40) {
    int bestC = 0;
    for (int c = 1; c < N_CONCEPTS; c++)
      if (a.ear[a.lastHeardSound][c] > a.ear[a.lastHeardSound][bestC]) bestC = c;
    snprintf(buf, sizeof(buf), "hr %s>%s", a.lastHeardFrom, CONCEPT_NAME[bestC]);
    drawShadowText(fullSprite, SW - 100, qY + 12, TFT_YELLOW, buf);
  }
  // Q-bars: 12 slim vertical bars across the width
  int qbY = qY + 24;
  int qbH = 16;
  int qbTotalW = SW - 8;
  int qbW = qbTotalW / Q_ACTIONS;
  const char* icons[Q_ACTIONS] = {"F","D","!","K","+","?","Z","-","B","X","V","J"};
  for (int i = 0; i < Q_ACTIONS; i++) {
    int qx = 4 + i * qbW;
    float qv = (a.currentState >= 0) ? a.qtable[a.currentState][i] / 10.0f : 0.0f;
    bool picked = (i == a.chosenAction);
    fullSprite.fillRect(qx, qbY, qbW - 1, qbH, 0x1082);
    int mid = qbY + qbH / 2;
    fullSprite.drawFastHLine(qx, mid, qbW - 1, TFT_DARKGREY);
    int bar = (int)(qv * 1.5f);
    bar = max(-qbH/2, min(qbH/2, bar));
    uint16_t bc = (bar >= 0) ? 0x07E0 : 0xF800;
    if (bar > 0) fullSprite.fillRect(qx, mid - bar, qbW - 1, bar, bc);
    else if (bar < 0) fullSprite.fillRect(qx, mid, qbW - 1, -bar, bc);
    if (picked) fullSprite.drawRect(qx, qbY, qbW - 1, qbH, TFT_YELLOW);
    // Icon label below
    fullSprite.setTextColor(picked ? TFT_YELLOW : TFT_LIGHTGREY, TFT_BLACK);
    fullSprite.setCursor(qx + qbW/2 - 2, qbY + qbH + 1);
    fullSprite.print(icons[i]);
  }
  // Footer hint
  drawShadowText(fullSprite, 4, SH - 8, TFT_DARKGREY, "E:back  R:map  p/P:AI");

  fullSprite.pushSprite(0, 0);
}

// Draw a titled section box
void drawSection(TFT_eSprite &s, int x, int y, int w, int h,
                 const char* title, uint16_t titleCol) {
  s.drawRect(x, y, w, h, 0x18C3);
  s.fillRect(x + 1, y + 1, w - 2, 9, 0x10A2);
  s.setTextColor(titleCol, 0x10A2);
  s.setCursor(x + 4, y + 2);
  s.setTextSize(1);
  s.print(title);
}

// ============================================================================
//  Scrollable section-based R-view
//  Each section has a preview (small, in the scrollable list) and a fullscreen
//  version (large, when user presses E on it).
// ============================================================================

// Draw the organic "growth / DNA" visualization inside (x,y,w,h).
// Each AI's layout is deterministic by their name — unique DNA pattern per AI.
void drawGrowthViz(TFT_eSprite &s, const AI& a, int x, int y, int w, int h) {
  s.fillRect(x, y, w, h, 0x0021);
  int cx = x + w / 2;
  int cy = y + h / 2;
  float maxR = (min(w, h) / 2.0f) - 4.0f;

  // Deterministic seed from AI name
  uint32_t seed = (uint32_t)a.name[0] * 73 + (uint32_t)a.name[1] * 97 + (uint32_t)a.name[2] * 131;
  float baseRot = (seed & 0xFF) / 256.0f * (float)PI * 2.0f;

  // Node count grows with soul (1 → 16)
  int targetNodes = constrain(a.soul / 10 + 2, 2, 16);
  float t = tick * 0.04f;

  // Sparks drift in background (ambient RAM cells)
  for (int i = 0; i < 5; i++) {
    float sp = baseRot + i * 1.37f;
    float dx = cos(t * 0.6f + sp) * (maxR * 0.9f);
    float dy = sin(t * 0.5f + sp * 1.3f) * (maxR * 0.9f);
    int sx = cx + (int)dx;
    int sy = cy + (int)dy;
    if (sx > x && sx < x + w && sy > y && sy < y + h)
      s.drawPixel(sx, sy, 0x6BDF);
  }

  // Edges first (so nodes render on top)
  for (int i = 0; i < targetNodes; i++) {
    int j = (i * 3 + 1) % targetNodes;
    if (j == i) continue;
    float a1 = baseRot + (i * (float)PI * 2.0f / targetNodes);
    float a2 = baseRot + (j * (float)PI * 2.0f / targetNodes);
    float r1 = maxR * (0.3f + 0.7f * ((i + 1.0f) / targetNodes));
    float r2 = maxR * (0.3f + 0.7f * ((j + 1.0f) / targetNodes));
    float breath1 = sinf(t + i * 0.7f) * 1.2f;
    float breath2 = sinf(t + j * 0.7f) * 1.2f;
    int x1 = cx + (int)(cosf(a1) * (r1 + breath1));
    int y1 = cy + (int)(sinf(a1) * (r1 + breath1));
    int x2 = cx + (int)(cosf(a2) * (r2 + breath2));
    int y2 = cy + (int)(sinf(a2) * (r2 + breath2));
    // Edge color by Q-activity
    uint16_t ec = 0x18E3;
    if ((tick + i * 7) % 60 < 8) ec = 0x5EFF;    // sporadic activity flash
    s.drawLine(x1, y1, x2, y2, ec);
  }

  // Nodes (one per "RAM cell")
  for (int i = 0; i < targetNodes; i++) {
    float ang = baseRot + (i * (float)PI * 2.0f / targetNodes);
    float r   = maxR * (0.3f + 0.7f * ((i + 1.0f) / targetNodes));
    float breath = sinf(t + i * 0.7f) * 1.2f;
    int nx = cx + (int)(cosf(ang) * (r + breath));
    int ny = cy + (int)(sinf(ang) * (r + breath));
    // Node pulse brightness
    int flash = ((tick + i * 11) % 90 < 5) ? 2 : 0;
    s.fillCircle(nx, ny, 1 + flash, 0xDFFF);
    s.drawCircle(nx, ny, 2 + flash, 0x3DDF);
  }

  // Core node — breathing yellow/white soul center
  int corePulse = (tick / 6) % 3;
  s.fillCircle(cx, cy, 2 + corePulse, 0xFFFF);
  s.drawCircle(cx, cy, 4 + corePulse, 0x07FF);
}
// ---------------- Section preview renderers (used in list) ----------------
void sec_POV_preview     (const AI& a, int x, int y, int w, int h) {
  drawPOV(fullSprite, x, y, w, h, a);
}
void sec_GROWTH_preview  (const AI& a, int x, int y, int w, int h) {
  drawGrowthViz(fullSprite, a, x, y, w, h);
}
void sec_NEEDS_preview   (const AI& a, int x, int y, int w, int h) {
  fullSprite.fillRect(x, y, w, h, 0x0841);
  int gy = y + h / 2 + 2;
  drawGauge(fullSprite, x + 28, gy, 20, a.hunger, 0xF800, "hun", a.hunger);
  drawGauge(fullSprite, x + 90, gy, 20, a.thirst, 0x3DDF, "thi", a.thirst);
  drawGauge(fullSprite, x +152, gy, 20, a.energy, 0x07E0, "ene", a.energy);
  // Dispositions on the right
  fullSprite.setTextColor(TFT_YELLOW, 0x0841);
  fullSprite.setCursor(x + 192, y + 4); fullSprite.print("DISPOSITION");
  fullSprite.setTextColor(TFT_WHITE, 0x0841);
  fullSprite.setCursor(x + 192, y + 18);  fullSprite.printf("aggression  %.2f", a.aggression);
  fullSprite.setCursor(x + 192, y + 28);  fullSprite.printf("curiosity   %.2f", a.curiosity);
  fullSprite.setCursor(x + 192, y + 38);  fullSprite.printf("trust       %.2f", a.trust);
  fullSprite.setCursor(x + 192, y + 50);  fullSprite.printf("fov %d  ear %d", a.fov, a.hearing);
}
void sec_BRAIN_preview   (const AI& a, int x, int y, int w, int h) {
  fullSprite.fillRect(x, y, w, h, 0x0841);
  int st = a.currentState < 0 ? 0 : a.currentState;
  bool waterK = st >= 24; if (waterK) st -= 24;
  bool foodK  = st >= 12; if (foodK)  st -= 12;
  int threat  = st / 4;   st -= threat * 4;
  int need    = st;
  const char* needs[4] = {"OK","FOOD","WATR","REST"};
  const char* thrN[3]  = {"-","prey","ENMY"};
  fullSprite.setTextColor(TFT_WHITE, 0x0841);
  fullSprite.setCursor(x + 4, y + 3);
  fullSprite.printf("state #%d  need:%s  threat:%s  F%c W%c",
    a.currentState, needs[need], thrN[threat],
    foodK ? '+' : '-', waterK ? '+' : '-');
  fullSprite.setTextColor(a.wasRandom ? 0xF81F : TFT_GREEN, 0x0841);
  fullSprite.setCursor(x + 4, y + 13);
  fullSprite.printf("eps %.2f  %s", a.epsilon, a.wasRandom ? "exploring" : "greedy");
  // Taller Q-bars
  int qbY = y + 25;
  int qbTotalW = w - 8;
  int qbW = qbTotalW / Q_ACTIONS;
  int qbH = h - 38;
  const char* icons[Q_ACTIONS] = {"F","D","!","K","+","?","Z","-","B","X","V","J"};
  for (int i = 0; i < Q_ACTIONS; i++) {
    int qx = x + 4 + i * qbW;
    float qv = (a.currentState >= 0) ? a.qtable[a.currentState][i] / 10.0f : 0.0f;
    bool picked = (i == a.chosenAction);
    int mid = qbY + qbH / 2;
    fullSprite.fillRect(qx, qbY, qbW - 1, qbH, 0x1082);
    fullSprite.drawFastHLine(qx, mid, qbW - 1, TFT_DARKGREY);
    int bar = (int)(qv * 1.8f);
    bar = max(-qbH/2, min(qbH/2, bar));
    uint16_t bc = (bar >= 0) ? 0x07E0 : 0xF800;
    if (bar > 0)      fullSprite.fillRect(qx, mid - bar, qbW - 1, bar, bc);
    else if (bar < 0) fullSprite.fillRect(qx, mid, qbW - 1, -bar, bc);
    if (picked) fullSprite.drawRect(qx - 1, qbY - 1, qbW + 1, qbH + 2, TFT_YELLOW);
    fullSprite.setTextColor(picked ? TFT_YELLOW : TFT_LIGHTGREY, 0x0841);
    fullSprite.setCursor(qx + qbW/2 - 2, qbY + qbH + 1);
    fullSprite.print(icons[i]);
  }
}
void sec_RELATIONS_preview (const AI& a, int x, int y, int w, int h) {
  fullSprite.fillRect(x, y, w, h, 0x0841);
  int order[4] = {0, 1, 2, 3};
  for (int i = 1; i < 4; i++) {
    int k = order[i]; int kv = abs((int)a.rel_trust[k]);
    int j = i - 1;
    while (j >= 0 && abs((int)a.rel_trust[order[j]]) < kv) { order[j+1] = order[j]; j--; }
    order[j+1] = k;
  }
  // Left side: 4 relations with bigger trust bars + label
  int ry = y + 3;
  int shown = 0;
  for (int i = 0; i < 4; i++) {
    int si = order[i];
    if (!a.rel_name[si][0]) continue;
    int t = a.rel_trust[si];
    uint16_t c = (t > 30) ? TFT_GREEN : (t < -30) ? 0xF800 : TFT_LIGHTGREY;
    fullSprite.setTextColor(c, 0x0841);
    fullSprite.setCursor(x + 4, ry);
    fullSprite.printf("%s %+4d", a.rel_name[si], t);
    int tbW = 70, tbX = x + 70;
    fullSprite.drawRect(tbX, ry, tbW, 6, TFT_DARKGREY);
    int zero = tbX + tbW/2;
    fullSprite.drawFastVLine(zero, ry, 6, TFT_WHITE);
    if (t > 0)      fullSprite.fillRect(zero, ry + 1, (t * (tbW/2)) / 100, 4, TFT_GREEN);
    else if (t < 0) fullSprite.fillRect(zero + (t * (tbW/2)) / 100, ry + 1, -(t * (tbW/2)) / 100, 4, TFT_RED);
    // Tier label
    const char* tier = t > 70 ? "mate" : t > 40 ? "ally" : t > 10 ? "frnd" :
                        t < -70 ? "enmy" : t < -30 ? "rival" : "nutrl";
    fullSprite.setTextColor(c, 0x0841);
    fullSprite.setCursor(x + 145, ry);
    fullSprite.print(tier);
    ry += 10;
    shown++;
    if (shown >= 4) break;
  }
  if (shown == 0) {
    fullSprite.setTextColor(TFT_DARKGREY, 0x0841);
    fullSprite.setCursor(x + 4, y + h/2); fullSprite.print("(no one yet)");
  }
  // Right side: lineage + counts
  fullSprite.setTextColor(0xFC9E, 0x0841);
  fullSprite.setCursor(x + 190, y + 3); fullSprite.print("LINEAGE");
  fullSprite.setTextColor(TFT_LIGHTGREY, 0x0841);
  fullSprite.setCursor(x + 190, y + 15);
  if (a.parent1[0]) fullSprite.printf("parents: %s + %s", a.parent1, a.parent2);
  else              fullSprite.print("spawned from pool");
  fullSprite.setCursor(x + 190, y + 27); fullSprite.printf("children: %d", a.numChildren);
  fullSprite.setCursor(x + 190, y + 39); fullSprite.printf("kills: %d  helps: %d", a.kills, a.helps);
  fullSprite.setCursor(x + 190, y + 51); fullSprite.printf("food eaten: %d", a.foodEaten);
}
void sec_LANGUAGE_preview(const AI& a, int x, int y, int w, int h) {
  fullSprite.fillRect(x, y, w, h, 0x0841);
  // Larger 8x8 ear grid on the left
  int cellSz = 7;
  int gx = x + 20, gy = y + 10;
  // Column headers
  fullSprite.setTextColor(TFT_DARKGREY, 0x0841);
  for (int c = 0; c < N_CONCEPTS; c++) {
    fullSprite.setCursor(gx + c * cellSz + 1, y + 2);
    fullSprite.write(CONCEPT_NAME[c][0]);
  }
  // Rows
  for (int snd = 0; snd < N_SOUNDS; snd++) {
    fullSprite.setTextColor(TFT_LIGHTGREY, 0x0841);
    fullSprite.setCursor(x + 2, gy + snd * cellSz);
    fullSprite.printf("S%d", snd);
    for (int c = 0; c < N_CONCEPTS; c++) {
      int v = a.ear[snd][c];
      uint8_t g = (uint8_t)min(63, v * 2);
      uint16_t col = (g << 5);
      int px = gx + c * cellSz;
      int py = gy + snd * cellSz;
      fullSprite.fillRect(px, py, cellSz - 1, cellSz - 1, col);
      if (a.mouth[c] == snd) fullSprite.drawRect(px, py, cellSz - 1, cellSz - 1, TFT_YELLOW);
    }
  }
  // Right side
  int rx = gx + N_CONCEPTS * cellSz + 12;
  fullSprite.setTextColor(0xFBE0, 0x0841);
  fullSprite.setCursor(rx, y + 3); fullSprite.print("MOUTH");
  fullSprite.setTextColor(TFT_WHITE, 0x0841);
  fullSprite.setCursor(rx, y + 14);
  fullSprite.printf("f%d w%d e%d p%d", a.mouth[C_FOOD], a.mouth[C_WATER], a.mouth[C_ENEMY], a.mouth[C_PAIN]);
  fullSprite.setCursor(rx, y + 24);
  fullSprite.printf("F%d d%d k%d c%d", a.mouth[C_FRIEND], a.mouth[C_DANGER], a.mouth[C_KILL], a.mouth[C_CALM]);
  // Last heard
  if (a.lastHeardSound >= 0 && tick - a.lastHeardTick < 50) {
    int bestC = 0;
    for (int c = 1; c < N_CONCEPTS; c++)
      if (a.ear[a.lastHeardSound][c] > a.ear[a.lastHeardSound][bestC]) bestC = c;
    fullSprite.setTextColor(TFT_YELLOW, 0x0841);
    fullSprite.setCursor(rx, y + 40);
    fullSprite.printf("hr S%d %s", a.lastHeardSound, a.lastHeardFrom);
    fullSprite.setTextColor(TFT_LIGHTGREY, 0x0841);
    fullSprite.setCursor(rx, y + 50);
    fullSprite.printf(">'%s'", CONCEPT_NAME[bestC]);
  } else {
    fullSprite.setTextColor(TFT_DARKGREY, 0x0841);
    fullSprite.setCursor(rx, y + 45);
    fullSprite.print("(silent)");
  }
}

// Fullscreen renderers — large versions of each section
void sec_POV_full(const AI& a)        { renderPOVFullscreen(); }
void sec_GROWTH_full(const AI& a) {
  fullSprite.fillSprite(0x0021);
  drawGrowthViz(fullSprite, a, 10, 10, SW - 20, SH - 40);
  fullSprite.setTextColor(TFT_CYAN, 0x0021);
  fullSprite.setTextSize(2);
  fullSprite.setCursor(10, SH - 24);
  fullSprite.print("GROWTH  ");
  fullSprite.setTextSize(1);
  fullSprite.setTextColor(TFT_WHITE, 0x0021);
  fullSprite.printf("%s  soul %d  nodes %d", a.name, a.soul, constrain(a.soul/10 + 2, 2, 16));
  fullSprite.setTextColor(TFT_DARKGREY, 0x0021);
  fullSprite.setCursor(SW - 90, SH - 12);
  fullSprite.print("E:back R:map");
  fullSprite.pushSprite(0, 0);
}
void sec_NEEDS_full(const AI& a) {
  fullSprite.fillSprite(0x0841);
  fullSprite.setTextColor(TFT_GREEN, 0x0841); fullSprite.setTextSize(2);
  fullSprite.setCursor(10, 10); fullSprite.print("NEEDS");
  fullSprite.setTextSize(1);
  drawGauge(fullSprite, 60, 80,  28, a.hunger, 0xF800, "hunger", a.hunger);
  drawGauge(fullSprite, 160, 80, 28, a.thirst, 0x3DDF, "thirst", a.thirst);
  drawGauge(fullSprite, 260, 80, 28, a.energy, 0x07E0, "energy", a.energy);
  fullSprite.setTextColor(TFT_YELLOW, 0x0841);
  fullSprite.setCursor(10, 140); fullSprite.print("DISPOSITION");
  fullSprite.setTextColor(TFT_WHITE, 0x0841);
  fullSprite.setCursor(10, 155); fullSprite.printf("aggression  %.2f", a.aggression);
  fullSprite.setCursor(10, 167); fullSprite.printf("curiosity   %.2f", a.curiosity);
  fullSprite.setCursor(10, 179); fullSprite.printf("trust       %.2f", a.trust);
  fullSprite.setCursor(160, 155); fullSprite.printf("fov    %d tiles", a.fov);
  fullSprite.setCursor(160, 167); fullSprite.printf("hearing %d tiles", a.hearing);
  fullSprite.setTextColor(TFT_DARKGREY, 0x0841);
  fullSprite.setCursor(SW - 90, SH - 12); fullSprite.print("E:back R:map");
  fullSprite.pushSprite(0, 0);
}
void sec_BRAIN_full(const AI& a) {
  fullSprite.fillSprite(0x0841);
  fullSprite.setTextColor(TFT_CYAN, 0x0841); fullSprite.setTextSize(2);
  fullSprite.setCursor(10, 10); fullSprite.print("BRAIN");
  fullSprite.setTextSize(1);
  int st = a.currentState < 0 ? 0 : a.currentState;
  bool waterK = st >= 24; if (waterK) st -= 24;
  bool foodK  = st >= 12; if (foodK)  st -= 12;
  int threat  = st / 4;   st -= threat * 4;
  int need    = st;
  const char* needs[4] = {"OK","FOOD","WATR","REST"};
  const char* thrN[3]  = {"-","prey","ENMY"};
  fullSprite.setTextColor(TFT_WHITE, 0x0841);
  fullSprite.setCursor(10, 36);
  fullSprite.printf("state #%d   need:%s   threat:%s   food:%c water:%c",
    a.currentState, needs[need], thrN[threat], foodK ? '+' : '-', waterK ? '+' : '-');
  fullSprite.setCursor(10, 48); fullSprite.printf("eps %.3f   %s  (%s)",
    a.epsilon, a.wasRandom ? "RAND" : "greedy",
    a.age < 200 ? "exploring" : a.age < 1500 ? "learning" : "stable");
  // Full Q-table — vertical bars
  int qbY = 70;
  int qbTotalW = SW - 20;
  int qbW = qbTotalW / Q_ACTIONS;
  int qbH = 60;
  const char* icons[Q_ACTIONS] = {"F","D","!","K","+","?","Z","-","B","X","V","J"};
  for (int i = 0; i < Q_ACTIONS; i++) {
    int qx = 10 + i * qbW;
    float qv = (a.currentState >= 0) ? a.qtable[a.currentState][i] / 10.0f : 0.0f;
    bool picked = (i == a.chosenAction);
    int mid = qbY + qbH / 2;
    fullSprite.fillRect(qx, qbY, qbW - 2, qbH, 0x1082);
    fullSprite.drawFastHLine(qx, mid, qbW - 2, TFT_DARKGREY);
    int bar = (int)(qv * 2.2f);
    bar = max(-qbH/2, min(qbH/2, bar));
    uint16_t bc = (bar >= 0) ? 0x07E0 : 0xF800;
    if (bar > 0)      fullSprite.fillRect(qx, mid - bar, qbW - 2, bar, bc);
    else if (bar < 0) fullSprite.fillRect(qx, mid, qbW - 2, -bar, bc);
    if (picked) fullSprite.drawRect(qx - 1, qbY - 1, qbW, qbH + 2, TFT_YELLOW);
    fullSprite.setTextColor(picked ? TFT_YELLOW : TFT_LIGHTGREY, 0x0841);
    fullSprite.setCursor(qx + qbW/2 - 2, qbY + qbH + 2);
    fullSprite.print(icons[i]);
    fullSprite.setCursor(qx + 2, qbY + qbH + 12);
    fullSprite.printf("%+.1f", qv);
  }
  fullSprite.setTextColor(TFT_GREEN, 0x0841);
  fullSprite.setCursor(10, 180); fullSprite.printf("ACTION: %s", a.lastAction);
  fullSprite.setTextColor(TFT_LIGHTGREY, 0x0841);
  fullSprite.setCursor(10, 192); fullSprite.print(a.lastReason);
  fullSprite.setTextColor(TFT_DARKGREY, 0x0841);
  fullSprite.setCursor(SW - 90, SH - 12); fullSprite.print("E:back R:map");
  fullSprite.pushSprite(0, 0);
}
void sec_RELATIONS_full(const AI& a) {
  fullSprite.fillSprite(0x0841);
  fullSprite.setTextColor(0xFC9E, 0x0841); fullSprite.setTextSize(2);
  fullSprite.setCursor(10, 10); fullSprite.print("RELATIONS");
  fullSprite.setTextSize(1);
  int ry = 48;
  for (int i = 0; i < 4; i++) {
    if (!a.rel_name[i][0]) continue;
    int t = a.rel_trust[i];
    uint16_t c = (t > 30) ? TFT_GREEN : (t < -30) ? 0xF800 : TFT_LIGHTGREY;
    fullSprite.setTextColor(c, 0x0841);
    fullSprite.setCursor(10, ry);
    fullSprite.printf("%s", a.rel_name[i]);
    fullSprite.setCursor(60, ry);
    fullSprite.printf("%+4d", t);
    int tbW = 160, tbX = 110;
    fullSprite.drawRect(tbX, ry + 1, tbW, 6, TFT_DARKGREY);
    int zero = tbX + tbW/2;
    fullSprite.drawFastVLine(zero, ry + 1, 6, TFT_WHITE);
    if (t > 0)      fullSprite.fillRect(zero, ry + 2, (t * (tbW/2)) / 100, 4, TFT_GREEN);
    else if (t < 0) fullSprite.fillRect(zero + (t * (tbW/2)) / 100, ry + 2, -(t * (tbW/2)) / 100, 4, TFT_RED);
    const char* label = t > 70 ? "mate" : t > 40 ? "ally" : t > 10 ? "friend" :
                        t < -70 ? "enemy" : t < -30 ? "rival" : "neutral";
    fullSprite.setTextColor(TFT_WHITE, 0x0841);
    fullSprite.setCursor(280, ry); fullSprite.print(label);
    ry += 20;
  }
  // Lineage block
  fullSprite.setTextColor(TFT_YELLOW, 0x0841);
  fullSprite.setCursor(10, 160); fullSprite.print("LINEAGE");
  fullSprite.setTextColor(TFT_WHITE, 0x0841);
  fullSprite.setCursor(10, 174);
  if (a.parent1[0]) fullSprite.printf("parents:  %s  +  %s", a.parent1, a.parent2);
  else              fullSprite.print("spawned from pool (first generation)");
  fullSprite.setCursor(10, 186);
  fullSprite.printf("children bred:  %d", a.numChildren);
  fullSprite.setCursor(10, 198);
  fullSprite.printf("kills: %d    helps: %d    food: %d", a.kills, a.helps, a.foodEaten);
  fullSprite.setTextColor(TFT_DARKGREY, 0x0841);
  fullSprite.setCursor(SW - 90, SH - 12); fullSprite.print("E:back R:map");
  fullSprite.pushSprite(0, 0);
}
void sec_LANGUAGE_full(const AI& a) {
  fullSprite.fillSprite(0x0841);
  fullSprite.setTextColor(0xFBE0, 0x0841); fullSprite.setTextSize(2);
  fullSprite.setCursor(10, 10); fullSprite.print("LANGUAGE");
  fullSprite.setTextSize(1);
  // Big ear grid
  int cellSz = 16;
  int gx = 20, gy = 60;
  fullSprite.setTextColor(TFT_DARKGREY, 0x0841);
  for (int c = 0; c < N_CONCEPTS; c++) {
    fullSprite.setCursor(gx + c * cellSz + cellSz/2 - 10, gy - 10);
    fullSprite.print(CONCEPT_NAME[c]);
  }
  for (int snd = 0; snd < N_SOUNDS; snd++) {
    fullSprite.setCursor(gx - 14, gy + snd * cellSz + 4);
    fullSprite.setTextColor(TFT_LIGHTGREY, 0x0841);
    fullSprite.printf("S%d", snd);
    for (int c = 0; c < N_CONCEPTS; c++) {
      int v = a.ear[snd][c];
      uint8_t g = (uint8_t)min(63, v * 2);
      uint16_t col = (g << 5);
      int px = gx + c * cellSz;
      int py = gy + snd * cellSz;
      fullSprite.fillRect(px, py, cellSz - 1, cellSz - 1, col);
      if (a.mouth[c] == snd) fullSprite.drawRect(px, py, cellSz - 1, cellSz - 1, TFT_YELLOW);
    }
  }
  // Right side: last heard, mouth summary
  int rx = gx + N_CONCEPTS * cellSz + 10;
  fullSprite.setTextColor(TFT_YELLOW, 0x0841);
  fullSprite.setCursor(rx, 60); fullSprite.print("mouth map:");
  fullSprite.setTextColor(TFT_WHITE, 0x0841);
  for (int c = 0; c < N_CONCEPTS; c++) {
    fullSprite.setCursor(rx, 72 + c * 10);
    fullSprite.printf("%s -> S%d", CONCEPT_NAME[c], a.mouth[c]);
  }
  // Last-heard at bottom
  if (a.lastHeardSound >= 0 && tick - a.lastHeardTick < 50) {
    int bestC = 0;
    for (int c = 1; c < N_CONCEPTS; c++)
      if (a.ear[a.lastHeardSound][c] > a.ear[a.lastHeardSound][bestC]) bestC = c;
    fullSprite.setTextColor(TFT_YELLOW, 0x0841);
    fullSprite.setCursor(10, SH - 28);
    fullSprite.printf("heard S%d from %s  ->  '%s'",
      a.lastHeardSound, a.lastHeardFrom, CONCEPT_NAME[bestC]);
  }
  fullSprite.setTextColor(TFT_DARKGREY, 0x0841);
  fullSprite.setCursor(SW - 90, SH - 12); fullSprite.print("E:back R:map");
  fullSprite.pushSprite(0, 0);
}

// ---------------- Section table ----------------
struct Section {
  const char* name;
  uint16_t    color;
  void (*preview)(const AI&, int, int, int, int);
  void (*full)(const AI&);
};
Section SECTIONS[] = {
  { "POV",       TFT_CYAN,   sec_POV_preview,       sec_POV_full       },
  { "GROWTH",    0x3DDF,     sec_GROWTH_preview,    sec_GROWTH_full    },
  { "NEEDS",     0x07E0,     sec_NEEDS_preview,     sec_NEEDS_full     },
  { "BRAIN",     TFT_YELLOW, sec_BRAIN_preview,     sec_BRAIN_full     },
  { "RELATIONS", 0xFC9E,     sec_RELATIONS_preview, sec_RELATIONS_full },
  { "LANGUAGE",  0xFBE0,     sec_LANGUAGE_preview,  sec_LANGUAGE_full  },
};
static const int SEC_COUNT = sizeof(SECTIONS) / sizeof(SECTIONS[0]);

// ---------------- Scrollable R view ----------------
void renderExpanded() {
  if (povFullscreen) { renderPOVFullscreen(); return; }
  AI& a = ais[selectedAI];

  // Fullscreen: current section only
  if (rSectionFullscr) {
    if (rSectionIdx >= 0 && rSectionIdx < SEC_COUNT)
      SECTIONS[rSectionIdx].full(a);
    return;
  }

  fullSprite.fillSprite(0x0841);

  // ============ FIXED BANNER (y=0..28) ============
  fullSprite.fillRect(0, 0, SW, 28, 0x1082);
  fullSprite.setTextSize(3);
  fullSprite.setTextColor(a.alive ? TFT_CYAN : TFT_RED, 0x1082);
  fullSprite.setCursor(4, 4); fullSprite.print(a.name);
  if (a.alive) drawAIShape(fullSprite, 76, 14, 8, a.shape, a.color, false);
  if (a.alive && isMonster(a.soul)) {
    fullSprite.fillRect(92, 6, 42, 14, 0xF800);
    fullSprite.setTextSize(1);
    fullSprite.setTextColor(TFT_WHITE, 0xF800);
    fullSprite.setCursor(98, 10); fullSprite.print("MONSTR");
  }
  fullSprite.setTextSize(1);
  fullSprite.setTextColor(0xFFE0, 0x1082);
  fullSprite.setCursor(146, 4); fullSprite.printf("SOUL %d", a.soul);
  int sbW = 166, sbX = 146;
  fullSprite.drawRect(sbX, 14, sbW, 5, TFT_DARKGREY);
  int fill = min(sbW - 2, a.soul * (sbW - 2) / 256);
  uint16_t sbCol = isMonster(a.soul) ? 0xF81F : (a.soul > 50 ? 0x07E0 : a.soul > 20 ? 0xFFE0 : 0xF800);
  fullSprite.fillRect(sbX + 1, 15, fill, 3, sbCol);
  float ageDays = a.age / 2400.0f;
  const char* stage = a.age < 200 ? "infant" : a.age < 800 ? "young" :
                      a.age < 3000 ? "adult" : "elder";
  fullSprite.setTextColor(TFT_LIGHTGREY, 0x1082);
  fullSprite.setCursor(sbX, 21); fullSprite.printf("age %.2fd %s", ageDays, stage);

  // ============ SCROLLABLE SECTION LIST (y=30..228) ============
  int listTop = 30, listBot = SH - 12;
  int sectionH = 78;      // each section's visible height (taller for breathing room)
  int sectionGap = 3;
  int perSection = sectionH + sectionGap;

  // Auto-scroll to keep selected section visible
  int selTop = rSectionIdx * perSection;
  int selBot = selTop + sectionH;
  if (selTop < rSectionScrollTop) rSectionScrollTop = selTop;
  int viewportH = listBot - listTop;
  if (selBot > rSectionScrollTop + viewportH) rSectionScrollTop = selBot - viewportH;
  int maxScroll = max(0, SEC_COUNT * perSection - viewportH);
  if (rSectionScrollTop > maxScroll) rSectionScrollTop = maxScroll;
  if (rSectionScrollTop < 0) rSectionScrollTop = 0;

  // Clip region manually by only drawing sections that land in the viewport
  for (int i = 0; i < SEC_COUNT; i++) {
    int sy = listTop + i * perSection - rSectionScrollTop;
    if (sy + sectionH < listTop || sy > listBot) continue;
    int sx = 3;
    int sw = SW - 10;    // leave space for scrollbar
    bool sel = (i == rSectionIdx);
    // Section background + border
    fullSprite.fillRect(sx, sy, sw, sectionH, sel ? 0x10A2 : 0x0841);
    fullSprite.drawRect(sx, sy, sw, sectionH, sel ? TFT_YELLOW : 0x18C3);
    // Title bar
    fullSprite.fillRect(sx + 1, sy + 1, sw - 2, 10, sel ? 0x2124 : 0x10A2);
    fullSprite.setTextColor(SECTIONS[i].color, sel ? 0x2124 : 0x10A2);
    fullSprite.setCursor(sx + 4, sy + 2);
    fullSprite.print(sel ? ">" : " ");
    fullSprite.print(SECTIONS[i].name);
    if (sel) {
      fullSprite.setTextColor(TFT_DARKGREY, 0x2124);
      fullSprite.setCursor(sw - 36, sy + 2);
      fullSprite.print("E:expand");
    }
    // Preview content
    int px = sx + 2, py = sy + 12, pw = sw - 4, ph = sectionH - 13;
    // Clip-safe: draw preview only if fully inside viewport
    int clippedTop = max(py, listTop);
    int clippedBot = min(py + ph, listBot);
    if (clippedBot > clippedTop) {
      SECTIONS[i].preview(a, px, py, pw, ph);
    }
  }

  // Cover any overflow at top/bottom of list area
  fullSprite.fillRect(0, 28, SW, listTop - 28, 0x0841);
  fullSprite.fillRect(0, listBot, SW, SH - listBot, 0x0841);

  // Scrollbar on right
  if (SEC_COUNT * perSection > viewportH) {
    int rangeH = viewportH;
    int barH = max(10, (rangeH * rangeH) / (SEC_COUNT * perSection));
    int barY = listTop + (rSectionScrollTop * rangeH) / (SEC_COUNT * perSection);
    fullSprite.fillRect(SW - 4, listTop, 3, rangeH, 0x1082);
    fullSprite.fillRect(SW - 4, barY, 3, barH, TFT_CYAN);
  }

  // Footer
  fullSprite.setTextColor(TFT_DARKGREY, 0x0841);
  fullSprite.setCursor(4, SH - 10);
  fullSprite.print("W/S: nav   E: expand section   R: map   p/P: AI");

  fullSprite.pushSprite(0, 0);
}

// ---------------- INPUT ----------------
int lastUp=HIGH, lastDn=HIGH, lastLf=HIGH, lastRt=HIGH, lastCk=HIGH;
bool edge(int cur, int &last){ bool p=(cur==LOW&&last==HIGH); last=cur; return p; }
int readKey() {
  Wire.requestFrom((uint8_t)KB_I2C_ADDR, (uint8_t)1);
  if (Wire.available()) return Wire.read();
  return 0;
}
void centerCamOnSel() {
  AI& a = ais[selectedAI];
  camX = a.x - viewTilesX()/2; camY = a.y - viewTilesY()/2;
}
void cycleSel(int dir) {
  for (int i = 0; i < MAX_AI; i++) {
    selectedAI = (selectedAI + dir + MAX_AI) % MAX_AI;
    if (ais[selectedAI].alive) break;
  }
}

// ---------------- SETUP / LOOP ----------------
unsigned long lastTickMs = 0;

void setup() {
  Serial.begin(115200);
  Serial.println("=== T-Deck World v1.1 ===");
  pinMode(PERI_POWERON, OUTPUT); digitalWrite(PERI_POWERON, HIGH);
  delay(500);
  pinMode(TFT_BL_PIN, OUTPUT);   digitalWrite(TFT_BL_PIN, HIGH);
  Wire.begin(KB_I2C_SDA, KB_I2C_SCL);
  pinMode(TB_UP, INPUT_PULLUP); pinMode(TB_DOWN, INPUT_PULLUP);
  pinMode(TB_LEFT, INPUT_PULLUP); pinMode(TB_RIGHT, INPUT_PULLUP);
  pinMode(TB_CLICK, INPUT_PULLUP);

  tft.init();
  tft.setRotation(1);
  tft.fillScreen(TFT_BLACK);

  layoutPanels();
  allocSprites();

  randomSeed(micros());
  for (int i = 0; i < MEMORIAL_MAX; i++) memorials[i].used = false;
  for (int i = 0; i < EVENT_LOG_SIZE; i++) eventLog[i].text[0] = 0;
  genWorld();
  for (int i = 0; i < MAX_AI; i++) aiSpawn(i);
  addEvent(TFT_CYAN, "World seeded with %d souls", MAX_AI);

  // Splash
  tft.setTextColor(TFT_CYAN); tft.setTextSize(2);
  tft.setCursor(50, 20); tft.print("T-Deck World 2");
  tft.setTextSize(1); tft.setTextColor(TFT_WHITE);
  tft.setCursor(20, 50); tft.println("WASD or trackball: pan map");
  tft.setCursor(20, 62); tft.println("+/- or z: zoom in/out");
  tft.setCursor(20, 74); tft.println("p: next AI   P: prev AI");
  tft.setCursor(20, 86); tft.println("space/click: center on sel");
  tft.setCursor(20, 98); tft.println("R: EXPANDED detail (POV)");
  tft.setCursor(20,110); tft.println("E: hide side panel");
  tft.setCursor(20,122); tft.println("M: settings   0-4: speed");
  tft.setCursor(20,145); tft.setTextColor(TFT_YELLOW);
  tft.println("day = 2400 world ticks");
  tft.setCursor(20,157);
  tft.println("stages: infant/young/adult/elder");
  delay(3000);
  tft.fillScreen(TFT_BLACK);
  mapDirty = panelDirty = hudDirty = true;
}

void loop() {
  // Input
  int up=digitalRead(TB_UP), dn=digitalRead(TB_DOWN);
  int lf=digitalRead(TB_LEFT), rt=digitalRead(TB_RIGHT);
  int ck=digitalRead(TB_CLICK);
  bool pUp=edge(up,lastUp), pDn=edge(dn,lastDn);
  bool pLf=edge(lf,lastLf), pRt=edge(rt,lastRt);
  bool pCk=edge(ck,lastCk);
  int key=readKey();

  bool moved = false;
  int step = max(1, viewTilesX() / 6);

  // Global: toggle settings menu with 'm'
  if (key == 'm' || key == 'M') {
    panelMode = (panelMode == PANEL_AI) ? PANEL_SETTINGS : PANEL_AI;
    if (panelMode == PANEL_SETTINGS) {
      // Jump past the first HEADER
      while (settingsIdx < SETTINGS_COUNT && !settingIsSelectable(settingsIdx)) settingsIdx++;
      if (settingsIdx >= SETTINGS_COUNT) settingsIdx = 1;
    }
    panelDirty = true;
    key = 0;
  }

  // Global: exit expanded view with R (skip map/panel input handling)
  bool skipMapInput = false;
  if (expandedMode) {
    if (key == 'r' || key == 'R' || key == 27) {
      // Leave expanded entirely (go back to map)
      expandedMode    = false;
      povFullscreen   = false;
      rSectionFullscr = false;
      freeFullSprite();
      layoutPanels();
      allocMapSprites();
      tft.fillScreen(TFT_BLACK);
      mapDirty = panelDirty = hudDirty = true;
      key = 0;
    }
    if (key == 'e' || key == 'E') {
      // Toggle: section fullscreen on/off inside R view
      rSectionFullscr = !rSectionFullscr;
      tft.fillScreen(TFT_BLACK);
      mapDirty = panelDirty = hudDirty = true;
      key = 0;
    }
    // Navigate sections with W/S
    if (!rSectionFullscr) {
      if (key == 'w' || key == 'W' || pUp) {
        rSectionIdx = (rSectionIdx - 1 + SEC_COUNT) % SEC_COUNT;
        panelDirty = true;
      }
      if (key == 's' || key == 'S' || pDn) {
        rSectionIdx = (rSectionIdx + 1) % SEC_COUNT;
        panelDirty = true;
      }
    }
    if (key == 'p') { cycleSel(+1); panelDirty = true; }
    if (key == 'P') { cycleSel(-1); panelDirty = true; }
    if (key == 'n' || key == 'N' || key == ']') { cycleSel(+1); panelDirty = true; }
    if (key == '[') { cycleSel(-1); panelDirty = true; }
    if (key >= '0' && key <= '4') { speedIdx = key - '0'; hudDirty = true; }
    skipMapInput = true;
  }

  if (!skipMapInput && panelMode == PANEL_SETTINGS) {
    auto moveSel = [&](int dir) {
      for (int tries = 0; tries < SETTINGS_COUNT; tries++) {
        settingsIdx = (settingsIdx + dir + SETTINGS_COUNT) % SETTINGS_COUNT;
        if (settingIsSelectable(settingsIdx)) break;
      }
    };
    if (key == 'w' || key == 'W' || pUp) { moveSel(-1); panelDirty = true; }
    if (key == 's' || key == 'S' || pDn) { moveSel(+1); panelDirty = true; }

    auto adjust = [&](int dir) {
      SettingItem& s = SETTINGS[settingsIdx];
      switch (s.type) {
        case ST_TOGGLE: {
          bool* b = (bool*)s.ptr; *b = !*b; break;
        }
        case ST_ENUM: {
          int* v = (int*)s.ptr;
          *v = constrain(*v + dir * s.step, s.mn, s.mx);
          break;
        }
        case ST_INT: {
          int* v = (int*)s.ptr;
          *v = constrain(*v + dir * s.step, s.mn, s.mx);
          break;
        }
        case ST_ACTION:
          if (dir > 0 && s.fn) s.fn();
          break;
        default: break;
      }
    };
    if (key == 'a' || key == 'A' || pLf) { adjust(-1); panelDirty = true; mapDirty = true; hudDirty = true; }
    if (key == 'd' || key == 'D' || pRt) { adjust(+1); panelDirty = true; mapDirty = true; hudDirty = true; }
    // Space/Enter activates ACTION items
    if (key == ' ' || key == '\n') {
      SettingItem& s = SETTINGS[settingsIdx];
      if (s.type == ST_ACTION && s.fn) { s.fn(); panelDirty = true; mapDirty = true; hudDirty = true; }
    }
  } else if (!skipMapInput) {
    // AI info panel mode — WASD + trackball pan the map
    if (pUp) { camY -= step; moved = true; }
    if (pDn) { camY += step; moved = true; }
    if (pLf) { camX -= step; moved = true; }
    if (pRt) { camX += step; moved = true; }
    if (key) {
      if (key == 'w' || key == 'W') { camY -= step; moved = true; }
      if (key == 's' || key == 'S') { camY += step; moved = true; }
      if (key == 'a' || key == 'A') { camX -= step; moved = true; }
      if (key == 'd' || key == 'D') { camX += step; moved = true; }
      if (key == '+' || key == '=') { if (zoomIdx < 3) { zoomIdx++; moved = true; hudDirty = true; } }
      if (key == '-' || key == '_') { if (zoomIdx > 0) { zoomIdx--; moved = true; hudDirty = true; } }
      if (key == 'z' || key == 'Z') { zoomIdx = (zoomIdx + 1) % 4; moved = true; hudDirty = true; }
      // AI cycling: p = next, P = prev
      if (key == 'p') { cycleSel(+1); panelDirty = true; mapDirty = true; }
      if (key == 'P') { cycleSel(-1); panelDirty = true; mapDirty = true; }
      if (key == 'n' || key == 'N' || key == ']') { cycleSel(+1); panelDirty = true; mapDirty = true; }
      if (key == '[') { cycleSel(-1); panelDirty = true; mapDirty = true; }
      if (key == ' ') { centerCamOnSel(); moved = true; }
      if (key == 'r' || key == 'R') {
        // Enter EXPANDED detail view
        expandedMode = true;
        freeMapSprites();
        allocFullSprite();
        tft.fillScreen(TFT_BLACK);
        mapDirty = panelDirty = hudDirty = true;
      }
      if (key == 'e' || key == 'E' || key == 'h' || key == 'H') {
        // Hide/show side panel (full-width map)
        panelOpen = !panelOpen;
        freeMapSprites(); layoutPanels(); allocMapSprites();
        tft.fillScreen(TFT_BLACK);
        mapDirty = panelDirty = hudDirty = true;
      }
      if (key >= '0' && key <= '4') { speedIdx = key - '0'; hudDirty = true; }
    }
    if (pCk) { centerCamOnSel(); moved = true; }
  }

  // Follow mode auto-center every frame
  if (followMode && ais[selectedAI].alive) { centerCamOnSel(); moved = true; }

  if (moved) mapDirty = true;

  // World tick
  int tickMs = currentSpeedMs();
  unsigned long now = millis();
  if (tickMs > 0 && now - lastTickMs >= (unsigned long)tickMs) {
    worldTick();
    lastTickMs = now;
    mapDirty = true;
    panelDirty = true;
    hudDirty = true;
  }

  // Render
  if (expandedMode) {
    // POV fullscreen renders every frame (smooth motion); non-fullscreen renders once per tick
    if (povFullscreen) {
      renderExpanded();
    } else if (mapDirty || panelDirty || hudDirty) {
      renderExpanded();
      mapDirty = panelDirty = hudDirty = false;
    }
  } else {
    if (hudDirty)   { renderHUD();   hudDirty = false; }
    renderMap();                      // always render — smooth AI motion
    mapDirty = false;
    if (panelDirty) { renderPanel(); panelDirty = false; }
  }

  delay(10);
}
