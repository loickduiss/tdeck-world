import * as THREE from 'three';
import {
  CONCEPT_COLORS,
  MAX_AI,
  SPEED_MS,
  Tile,
  TILE_COLORS,
  WORLD_H,
  WORLD_W,
  WorldState,
} from '../sim/types';
import { idxOf, isMonster, nightFactor } from '../sim/engine';

// Pre-allocated scratch transforms (zero GC inside animation loop)
const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const _euler = new THREE.Euler();

const TILE_STEP = 0.26; // 64 * 0.26 = 16.64 world units across
const HALF_EXTENT = (WORLD_W * TILE_STEP) / 2;

export interface WorldDioramaHandle {
  group: THREE.Group;
  aiPickMeshes: THREE.Mesh[];
  syncFromWorld: (state: WorldState, selectedAI: number, dt: number) => void;
  dispose: () => void;
}

interface AIFigurine {
  root: THREE.Group;
  body: THREE.Mesh;
  bodyMat: THREE.MeshStandardMaterial;
  visor: THREE.Mesh;
  crown: THREE.Mesh;
  selRing: THREE.Mesh;
  monsterRing: THREE.Mesh;
  soundRing: THREE.Mesh;
  soundMat: THREE.MeshBasicMaterial;
  pickProxy: THREE.Mesh;
}

/**
 * Builds a composite 3D isometric tabletop terrain representing the live 64x64 continent
 * using InstancedMesh for terrain/trees/rocks/berries/memorials and 3-part AI figurines.
 */
export function buildWorldDiorama(): WorldDioramaHandle {
  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(obj: T): T => {
    disposables.push(obj);
    return obj;
  };

  const group = new THREE.Group();

  // Natural ocean floor surrounding the 64x64 continent (never floating in an empty void)
  const oceanGeo = track(new THREE.CircleGeometry(46, 64));
  oceanGeo.rotateX(-Math.PI / 2);
  const oceanMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x0e2a47,
      roughness: 0.28,
      metalness: 0.35,
    })
  );
  const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
  oceanMesh.position.y = 0.04;
  oceanMesh.receiveShadow = true;
  group.add(oceanMesh);

  // Subtle submerged continental shelf rim
  const shelfGeo = track(new THREE.BoxGeometry(WORLD_W * TILE_STEP + 0.8, 0.24, WORLD_H * TILE_STEP + 0.8));
  const shelfMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x1b2430,
      roughness: 0.85,
      metalness: 0.12,
    })
  );
  const shelfMesh = new THREE.Mesh(shelfGeo, shelfMat);
  shelfMesh.position.y = 0.12;
  shelfMesh.receiveShadow = true;
  group.add(shelfMesh);

  // 1. Instanced Base Terrain Tiles (4096 tiles)
  const totalTiles = WORLD_W * WORLD_H;
  const tileGeo = track(new THREE.BoxGeometry(TILE_STEP * 0.98, 0.22, TILE_STEP * 0.98));
  const tileMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.05,
    })
  );
  const tileInst = new THREE.InstancedMesh(tileGeo, tileMat, totalTiles);
  tileInst.receiveShadow = true;
  tileInst.frustumCulled = false;
  group.add(tileInst);

  // 2. Composite Instanced Pine Trees (trunks + foliage cones)
  const maxProps = 1400;
  const trunkGeo = track(new THREE.CylinderGeometry(0.032, 0.045, 0.2, 6));
  const trunkMat = track(new THREE.MeshStandardMaterial({ color: 0x4b3621, roughness: 0.92 }));
  const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, maxProps);
  trunkInst.castShadow = true;
  trunkInst.frustumCulled = false;
  group.add(trunkInst);

  const canopyGeo = track(new THREE.ConeGeometry(0.115, 0.34, 7));
  const canopyMat = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78 }));
  const canopyInst = new THREE.InstancedMesh(canopyGeo, canopyMat, maxProps);
  canopyInst.castShadow = true;
  canopyInst.frustumCulled = false;
  group.add(canopyInst);

  // 3. Instanced Stone Outcrops, Built Walls, Berry Clusters & Memorial Obelisks
  const rockGeo = track(new THREE.DodecahedronGeometry(0.11, 0));
  const rockMat = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0.1 }));
  const rockInst = new THREE.InstancedMesh(rockGeo, rockMat, 512);
  rockInst.castShadow = true;
  rockInst.frustumCulled = false;
  group.add(rockInst);

  const wallGeo = track(new THREE.BoxGeometry(TILE_STEP * 0.92, 0.34, TILE_STEP * 0.92));
  const wallMat = track(new THREE.MeshStandardMaterial({ color: 0xa2b0c0, roughness: 0.65, metalness: 0.2 }));
  const wallInst = new THREE.InstancedMesh(wallGeo, wallMat, 512);
  wallInst.castShadow = true;
  wallInst.frustumCulled = false;
  group.add(wallInst);

  const berryGeo = track(new THREE.SphereGeometry(0.068, 8, 8));
  const berryMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0x7f1d1d,
      emissiveIntensity: 0.45,
      roughness: 0.35,
    })
  );
  const berryInst = new THREE.InstancedMesh(berryGeo, berryMat, 256);
  berryInst.frustumCulled = false;
  group.add(berryInst);

  const memGeo = track(new THREE.CylinderGeometry(0.04, 0.085, 0.44, 6));
  const memMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      emissive: 0xd97706,
      emissiveIntensity: 0.7,
      roughness: 0.25,
      metalness: 0.8,
    })
  );
  const memInst = new THREE.InstancedMesh(memGeo, memMat, 64);
  memInst.castShadow = true;
  memInst.frustumCulled = false;
  group.add(memInst);

  // 4. Composite 3D AI Figurines (Base pedestal + Soul Crystal Body + Visor + Crown + Selection/Monster/Sound Rings)
  const figurines: AIFigurine[] = [];
  const aiPickMeshes: THREE.Mesh[] = [];

  const pedGeo = track(new THREE.CylinderGeometry(0.11, 0.13, 0.06, 12));
  const pedMat = track(new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.4, metalness: 0.75 }));
  const bodyGeo = track(new THREE.OctahedronGeometry(0.125, 1));
  const visorGeo = track(new THREE.BoxGeometry(0.11, 0.045, 0.06));
  const visorMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.6,
      roughness: 0.2,
    })
  );
  const crownGeo = track(new THREE.ConeGeometry(0.08, 0.14, 5));
  const crownMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      emissive: 0xca8a04,
      emissiveIntensity: 0.65,
      roughness: 0.2,
      metalness: 0.9,
    })
  );
  const ringGeo = track(new THREE.RingGeometry(0.17, 0.22, 24));
  ringGeo.rotateX(-Math.PI / 2);
  const selRingMat = track(new THREE.MeshBasicMaterial({ color: 0xfacc15, side: THREE.DoubleSide }));
  const monRingMat = track(new THREE.MeshBasicMaterial({ color: 0xef4444, side: THREE.DoubleSide }));
  const soundGeo = track(new THREE.RingGeometry(0.18, 0.23, 28));
  soundGeo.rotateX(-Math.PI / 2);
  const pickGeo = track(new THREE.CylinderGeometry(0.24, 0.24, 0.6, 8));
  const pickMat = track(new THREE.MeshBasicMaterial({ visible: false }));

  for (let i = 0; i < MAX_AI; i++) {
    const fRoot = new THREE.Group();
    const ped = new THREE.Mesh(pedGeo, pedMat);
    ped.position.y = 0.03;
    fRoot.add(ped);

    const bodyMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x22d3ee,
        roughness: 0.32,
        metalness: 0.28,
      })
    );
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.22;
    body.castShadow = true;
    fRoot.add(body);

    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 0.25, -0.11);
    fRoot.add(visor);

    const crown = new THREE.Mesh(crownGeo, crownMat);
    crown.position.y = 0.42;
    crown.visible = false;
    fRoot.add(crown);

    const selRing = new THREE.Mesh(ringGeo, selRingMat);
    selRing.position.y = 0.025;
    selRing.visible = false;
    fRoot.add(selRing);

    const monsterRing = new THREE.Mesh(ringGeo, monRingMat);
    monsterRing.position.y = 0.028;
    monsterRing.scale.setScalar(1.35);
    monsterRing.visible = false;
    fRoot.add(monsterRing);

    const soundMat = track(
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
      })
    );
    const soundRing = new THREE.Mesh(soundGeo, soundMat);
    soundRing.position.y = 0.06;
    soundRing.visible = false;
    fRoot.add(soundRing);

    const pickProxy = new THREE.Mesh(pickGeo, pickMat);
    pickProxy.position.y = 0.25;
    pickProxy.userData.aiId = i;
    fRoot.add(pickProxy);
    aiPickMeshes.push(pickProxy);

    group.add(fRoot);
    figurines.push({
      root: fRoot,
      body,
      bodyMat,
      visor,
      crown,
      selRing,
      monsterRing,
      soundRing,
      soundMat,
      pickProxy,
    });
  }

  let lastTerrainTick = -1;

  function syncTerrain(state: WorldState): void {
    let tIdx = 0;
    let treeCount = 0;
    let rockCount = 0;
    let wallCount = 0;
    let berryCount = 0;
    let memCount = 0;

    for (let wy = 0; wy < WORLD_H; wy++) {
      for (let wx = 0; wx < WORLD_W; wx++) {
        const tile = state.tiles[idxOf(wx, wy)] as Tile;
        const px = wx * TILE_STEP - HALF_EXTENT + TILE_STEP * 0.5;
        const pz = wy * TILE_STEP - HALF_EXTENT + TILE_STEP * 0.5;
        const hash = ((wx * 73856093) ^ (wy * 19349663)) & 31;

        let py = 0.22;
        if (tile === Tile.WATER) py = 0.14;
        else if (tile === Tile.PIT) py = 0.1;
        else if (tile === Tile.SAND) py = 0.19;
        else if (tile === Tile.STONE) py = 0.26;

        _pos.set(px, py, pz);
        _quat.identity();
        _scale.set(1, 1, 1);
        _mat4.compose(_pos, _quat, _scale);
        tileInst.setMatrixAt(tIdx, _mat4);

        const baseHex = tile === Tile.FOOD ? TILE_COLORS[Tile.GRASS] : TILE_COLORS[tile];
        _color.set(baseHex);
        if (tile === Tile.GRASS) {
          _color.offsetHSL(0, 0, ((hash % 5) - 2) * 0.012);
        }
        tileInst.setColorAt(tIdx, _color);
        tIdx++;

        if (tile === Tile.FOREST && treeCount < maxProps) {
          const s = 0.85 + (hash % 7) * 0.05;
          _pos.set(px, py + 0.2, pz);
          _scale.set(s, s, s);
          _mat4.compose(_pos, _quat, _scale);
          trunkInst.setMatrixAt(treeCount, _mat4);

          _pos.set(px, py + 0.38 * s, pz);
          _mat4.compose(_pos, _quat, _scale);
          canopyInst.setMatrixAt(treeCount, _mat4);
          _color.set('#1f5732').offsetHSL(((hash % 3) - 1) * 0.02, 0, ((hash % 4) - 1.5) * 0.025);
          canopyInst.setColorAt(treeCount, _color);
          treeCount++;
        } else if (tile === Tile.STONE && rockCount < 512) {
          const s = 0.82 + (hash % 6) * 0.06;
          _pos.set(px, py + 0.14, pz);
          _euler.set(hash * 0.3, hash * 0.7, 0);
          _quat.setFromEuler(_euler);
          _scale.set(s * 1.1, s * 0.85, s);
          _mat4.compose(_pos, _quat, _scale);
          rockInst.setMatrixAt(rockCount, _mat4);
          _color.set('#747d88').offsetHSL(0, 0, ((hash % 4) - 2) * 0.03);
          rockInst.setColorAt(rockCount, _color);
          rockCount++;
        } else if (tile === Tile.BUILT && wallCount < 512) {
          _pos.set(px, py + 0.24, pz);
          _quat.identity();
          _scale.set(1, 1, 1);
          _mat4.compose(_pos, _quat, _scale);
          wallInst.setMatrixAt(wallCount, _mat4);
          wallCount++;
        } else if (tile === Tile.FOOD && berryCount < 256) {
          _pos.set(px, py + 0.16, pz);
          _quat.identity();
          _scale.set(1, 1, 1);
          _mat4.compose(_pos, _quat, _scale);
          berryInst.setMatrixAt(berryCount, _mat4);
          berryCount++;
        } else if (tile === Tile.MEMORIAL && memCount < 64) {
          _pos.set(px, py + 0.3, pz);
          _quat.identity();
          _scale.set(1, 1, 1);
          _mat4.compose(_pos, _quat, _scale);
          memInst.setMatrixAt(memCount, _mat4);
          memCount++;
        }
      }
    }

    tileInst.instanceMatrix.needsUpdate = true;
    if (tileInst.instanceColor) tileInst.instanceColor.needsUpdate = true;

    trunkInst.count = treeCount;
    trunkInst.instanceMatrix.needsUpdate = true;
    canopyInst.count = treeCount;
    canopyInst.instanceMatrix.needsUpdate = true;
    if (canopyInst.instanceColor) canopyInst.instanceColor.needsUpdate = true;

    rockInst.count = rockCount;
    rockInst.instanceMatrix.needsUpdate = true;
    if (rockInst.instanceColor) rockInst.instanceColor.needsUpdate = true;

    wallInst.count = wallCount;
    wallInst.instanceMatrix.needsUpdate = true;
    berryInst.count = berryCount;
    berryInst.instanceMatrix.needsUpdate = true;
    memInst.count = memCount;
    memInst.instanceMatrix.needsUpdate = true;
  }

  return {
    group,
    aiPickMeshes,
    syncFromWorld(state: WorldState, selectedAI: number, dt: number) {
      if (state.tick !== lastTerrainTick) {
        syncTerrain(state);
        lastTerrainTick = state.tick;
      }

      const now = performance.now();
      const tickMs = SPEED_MS[state.settings.speedIdx] ?? 250;
      const nf = nightFactor(state.tick);
      oceanMat.color.setRGB(
        0.055 * (1 - nf * 0.45),
        0.165 * (1 - nf * 0.45),
        0.28 * (1 - nf * 0.35)
      );

      for (let i = 0; i < MAX_AI; i++) {
        const fig = figurines[i];
        const a = state.ais[i];
        if (!a || !a.alive) {
          fig.root.visible = false;
          continue;
        }
        fig.root.visible = true;
        const frac = tickMs > 0 ? Math.max(0, Math.min(1, (now - a.moveStartMs) / tickMs)) : 1;
        const fx = a.prevX + (a.x - a.prevX) * frac;
        const fy = a.prevY + (a.y - a.prevY) * frac;
        const px = fx * TILE_STEP - HALF_EXTENT + TILE_STEP * 0.5;
        const pz = fy * TILE_STEP - HALF_EXTENT + TILE_STEP * 0.5;
        const bob = Math.sin(now * 0.005 + i) * 0.025;

        fig.root.position.set(px, 0.33, pz);
        fig.body.position.y = 0.22 + bob;
        fig.bodyMat.color.set(a.color);
        const soulScale = Math.max(0.75, Math.min(1.65, 0.72 + a.soul / 95));
        fig.body.scale.setScalar(soulScale);

        // Smoothly turn facing direction (0=N(-Z), 1=E(+X), 2=S(+Z), 3=W(-X))
        const targetYaw = a.facing === 0 ? 0 : a.facing === 1 ? -Math.PI / 2 : a.facing === 2 ? Math.PI : Math.PI / 2;
        fig.root.rotation.y += (targetYaw - fig.root.rotation.y) * (1 - Math.exp(-12 * dt));

        fig.crown.visible = a.isKing;
        if (a.isKing) fig.crown.position.y = 0.26 + 0.18 * soulScale + bob;

        fig.selRing.visible = i === selectedAI;
        fig.monsterRing.visible = isMonster(a.soul);

        const soundAge = state.tick - a.lastEmittedTick;
        if (state.settings.showSound && a.lastEmittedTick >= 0 && soundAge >= 0 && soundAge < 4) {
          fig.soundRing.visible = true;
          fig.soundRing.scale.setScalar(1.2 + soundAge * 1.4);
          fig.soundMat.color.set(CONCEPT_COLORS[a.lastEmittedConcept] ?? '#38bdf8');
          fig.soundMat.opacity = Math.max(0.12, 0.8 - soundAge * 0.2);
        } else {
          fig.soundRing.visible = false;
        }
      }
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };
}
