import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SPEED_MS, WORLD_H, WORLD_W, WorldState, ZOOM_LEVELS } from '../sim/types';
import {
  renderTDeckScreen,
  TDECK_H,
  TDECK_SCALE,
  TDECK_W,
  TDeckUIState,
} from '../sim/tdeckScreenRenderer';
import { buildTDeckModel, TDeckModelHandle } from './tdeckModel';
import { buildWorldDiorama, WorldDioramaHandle } from './worldDiorama';

export type CameraMode = 'title' | 'handheld' | 'orbit' | 'world3d';

export interface TDeckStageBridge {
  triggerKey: (key: string) => void;
  nudgeTrackball: (dx: number, dy: number) => void;
  pulseSD: () => void;
}

interface TDeckSceneStageProps {
  worldRef: React.MutableRefObject<WorldState>;
  uiRef: React.MutableRefObject<TDeckUIState>;
  cameraMode: CameraMode;
  stageBridgeRef: React.MutableRefObject<TDeckStageBridge | null>;
  onHardwareKey: (key: string) => void;
  onTrackballClick: () => void;
  onSelectAI: (aiId: number) => void;
}

const _camTargetPos = new THREE.Vector3();
const _camTargetLook = new THREE.Vector3();
const _pointerNdc = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();

function detectSoftwareWebGL(): boolean {
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2');
  if (!gl) return true;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
  const gpu = String(gl.getParameter(param));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 128, 18, 128, 128, 124);
  g.addColorStop(0, 'rgba(0,0,0,0.62)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

function createWorkbenchGridTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#0c1118';
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = 'rgba(56, 74, 98, 0.24)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 512; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i + 0.5, 0);
    ctx.lineTo(i + 0.5, 512);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i + 0.5);
    ctx.lineTo(512, i + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.12)';
  for (let i = 0; i <= 512; i += 128) {
    ctx.beginPath();
    ctx.moveTo(i + 0.5, 0);
    ctx.lineTo(i + 0.5, 512);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i + 0.5);
    ctx.lineTo(512, i + 0.5);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 16);
  return tex;
}

export function TDeckSceneStage({
  worldRef,
  uiRef,
  cameraMode,
  stageBridgeRef,
  onHardwareKey,
  onTrackballClick,
  onSelectAI,
}: TDeckSceneStageProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<CameraMode>(cameraMode);
  const transitionActiveRef = useRef<boolean>(true);
  const callbacksRef = useRef({ onHardwareKey, onTrackballClick, onSelectAI });

  callbacksRef.current = { onHardwareKey, onTrackballClick, onSelectAI };

  useEffect(() => {
    modeRef.current = cameraMode;
    transitionActiveRef.current = true;
  }, [cameraMode]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareWebGL();

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const bgHex = 0x0a0e16;
    scene.background = new THREE.Color(bgHex);
    scene.fog = new THREE.FogExp2(bgHex, 0.024);

    // Studio PMREM Environment
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(
      38,
      (container.clientWidth || window.innerWidth) / (container.clientHeight || window.innerHeight),
      0.1,
      140
    );
    camera.position.set(2.4, 5.2, 10.6);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.07;
    controls.maxPolarAngle = Math.PI * 0.485;
    controls.minDistance = 4.2;
    controls.maxDistance = 32;
    controls.target.set(-1.3, 3.2, 0);

    const handleControlStart = () => {
      if (modeRef.current === 'orbit' || modeRef.current === 'world3d') {
        transitionActiveRef.current = false;
      }
    };
    controls.addEventListener('start', handleControlStart);

    // Warm Key Light + Cool Hemisphere Fill + Crisp Rim Light
    const hemiLight = new THREE.HemisphereLight(0x8ec5ff, 0x161b24, 0.85);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff1dc, 1.9);
    keyLight.position.set(8, 15, 11);
    keyLight.castShadow = !isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 2;
    keyLight.shadow.camera.far = 42;
    keyLight.shadow.camera.left = -12;
    keyLight.shadow.camera.right = 12;
    keyLight.shadow.camera.top = 12;
    keyLight.shadow.camera.bottom = -12;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.75);
    rimLight.position.set(-10, 7, -9);
    scene.add(rimLight);

    // Matte ESD Electronics Workbench Ground Plane
    const deskTex = createWorkbenchGridTexture();
    deskTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const deskGeo = new THREE.CircleGeometry(64, 64);
    deskGeo.rotateX(-Math.PI / 2);
    const deskMat = new THREE.MeshStandardMaterial({
      map: deskTex,
      roughness: 0.86,
      metalness: 0.14,
    });
    const deskMesh = new THREE.Mesh(deskGeo, deskMat);
    deskMesh.receiveShadow = true;
    scene.add(deskMesh);

    // Soft radial contact shadow beneath the T-Deck handheld
    const shadowTex = createContactShadowTexture();
    const shadowGeo = new THREE.PlaneGeometry(8.6, 5.2);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.6,
    });
    const shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
    shadowPlane.position.set(0, 0.02, -0.35);
    scene.add(shadowPlane);

    // Live 320x240 ST7789 offscreen screen canvas -> CanvasTexture
    const screenCanvas = document.createElement('canvas');
    screenCanvas.width = TDECK_W * TDECK_SCALE;
    screenCanvas.height = TDECK_H * TDECK_SCALE;
    const screenCtx = screenCanvas.getContext('2d')!;
    const screenTexture = new THREE.CanvasTexture(screenCanvas);

    // Build Hero 3D LilyGO T-Deck Plus Handheld
    const tdeck: TDeckModelHandle = buildTDeckModel(
      screenTexture,
      renderer.capabilities.getMaxAnisotropy()
    );
    scene.add(tdeck.group);

    // Build 3D Living Continent Diorama (shown when cameraMode === 'world3d')
    const diorama: WorldDioramaHandle = buildWorldDiorama();
    diorama.group.visible = false;
    scene.add(diorama.group);

    // Expose imperative animation hooks to App without re-rendering React
    stageBridgeRef.current = {
      triggerKey: (k: string) => tdeck.triggerKeyPress(k),
      nudgeTrackball: (dx: number, dy: number) => tdeck.nudgeTrackball(dx, dy),
      pulseSD: () => tdeck.pulseSDActivity(),
    };

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // Raycast click interaction on 3D keys, trackball, screen, and 3D diorama figurines
    let downX = 0;
    let downY = 0;
    const onPointerDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
      const rect = renderer.domElement.getBoundingClientRect();
      _pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      _pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      _raycaster.setFromCamera(_pointerNdc, camera);

      if (modeRef.current === 'world3d') {
        const hits = _raycaster.intersectObjects(diorama.aiPickMeshes, false);
        if (hits.length > 0 && typeof hits[0].object.userData.aiId === 'number') {
          callbacksRef.current.onSelectAI(hits[0].object.userData.aiId);
        }
        return;
      }

      if (modeRef.current === 'title') return;

      const hits = _raycaster.intersectObjects(tdeck.interactiveMeshes, false);
      if (hits.length === 0) return;
      const hit = hits[0];
      if (hit.object === tdeck.trackballMesh) {
        tdeck.nudgeTrackball(0, 1);
        callbacksRef.current.onTrackballClick();
      } else if (hit.object.userData.tdeckKey) {
        const k = String(hit.object.userData.tdeckKey);
        tdeck.triggerKeyPress(k);
        callbacksRef.current.onHardwareKey(k);
      } else if (hit.object === tdeck.screenMesh && hit.uv) {
        // Click directly on the 320x240 T-Deck screen!
        const sx = hit.uv.x * TDECK_W;
        const sy = (1 - hit.uv.y) * TDECK_H;
        const ui = uiRef.current;
        const state = worldRef.current;
        if (ui.mode === 'expanded' && sy >= 25 && sy <= 42) {
          ui.rSectionIdx = Math.max(0, Math.min(6, Math.floor((sx / TDECK_W) * 7)));
          callbacksRef.current.onHardwareKey('__tab__');
        } else if (ui.mode === 'map' && sy > 22) {
          const panW = ui.panelOpen ? 124 : 0;
          const mapW = ui.panelOpen ? TDECK_W - panW - 1 : TDECK_W;
          if (sx < mapW) {
            const vtx = Math.min(WORLD_W, ZOOM_LEVELS[state.settings.zoomIdx] ?? 40);
            const ppx = mapW / vtx;
            const vty = Math.min(WORLD_H, Math.max(1, Math.round((TDECK_H - 22) / ppx)));
            const ppy = (TDECK_H - 22) / vty;
            const wx = ui.camX + sx / ppx;
            const wy = ui.camY + (sy - 22) / ppy;
            let bestId = -1;
            let bestD2 = 9;
            for (const ai of state.ais) {
              if (!ai.alive) continue;
              const d2 = (ai.x - wx) ** 2 + (ai.y - wy) ** 2;
              if (d2 < bestD2) {
                bestD2 = d2;
                bestId = ai.id;
              }
            }
            if (bestId >= 0) callbacksRef.current.onSelectAI(bestId);
          }
        }
      }
    };

    let lastHoverCheck = 0;
    const onPointerMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastHoverCheck < 50) return;
      lastHoverCheck = now;
      if (modeRef.current === 'title') {
        renderer.domElement.style.cursor = 'default';
        return;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      _pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      _pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      _raycaster.setFromCamera(_pointerNdc, camera);
      const targets =
        modeRef.current === 'world3d' ? diorama.aiPickMeshes : tdeck.interactiveMeshes;
      const hits = _raycaster.intersectObjects(targets, false);
      renderer.domElement.style.cursor = hits.length > 0 ? 'pointer' : 'grab';
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointermove', onPointerMove);

    const onResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    const onContextLost = (e: Event) => {
      e.preventDefault();
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);

    // Software-WebGL fence pacing helper (per threejs skill)
    let frameId = 0;
    let disposed = false;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      gl.flush();
      const poll = () => {
        if (disposed) return;
        const st = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
        if (st === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    let lastTime = performance.now();
    let screenRedrawAccum = 0;

    function tick() {
      if (disposed) return;
      const now = performance.now();
      const rawDt = (now - lastTime) / 1000;
      const dt = Math.min(rawDt, 0.05);
      lastTime = now;

      const mode = modeRef.current;
      const isDiorama = mode === 'world3d';

      tdeck.group.visible = !isDiorama;
      shadowPlane.visible = !isDiorama;
      deskMesh.visible = !isDiorama;
      diorama.group.visible = isDiorama;

      // Update live 320x240 T-Deck screen texture
      screenRedrawAccum += dt;
      const screenInterval = isSoftwareGl ? 0.14 : 0.032;
      if (!isDiorama && screenRedrawAccum >= screenInterval) {
        screenRedrawAccum = 0;
        renderTDeckScreen(screenCtx, worldRef.current, uiRef.current);
        screenTexture.needsUpdate = true;
      }

      if (!isDiorama) {
        tdeck.updateAnimation(dt);
      } else {
        diorama.syncFromWorld(worldRef.current, uiRef.current.selectedAI, dt);
      }

      // Smoothly damped camera choreography
      const damp = 1 - Math.exp(-5.5 * dt);
      if (mode === 'title') {
        const ang = Math.sin(now * 0.00035) * 0.3 + 0.26;
        _camTargetPos.set(Math.sin(ang) * 13.0 + 0.5, 5.5, Math.cos(ang) * 13.0);
        // Offset look target slightly left so the T-Deck rests cleanly on the right
        _camTargetLook.set(-2.5, 3.65, 0);
        camera.position.lerp(_camTargetPos, damp);
        controls.target.lerp(_camTargetLook, damp);
        controls.enabled = false;
      } else if (mode === 'handheld') {
        // Ergonomic face-on framing showing full T-Deck Plus (antenna tip to chin) clear above bottom dock
        _camTargetPos.set(0, 5.45, 11.4);
        _camTargetLook.set(0, 3.45, 0.15);
        camera.position.lerp(_camTargetPos, damp);
        controls.target.lerp(_camTargetLook, damp);
        controls.enabled = false;
      } else if (mode === 'orbit') {
        controls.enabled = true;
        if (transitionActiveRef.current) {
          _camTargetPos.set(5.2, 6.2, 12.2);
          _camTargetLook.set(0, 3.65, 0);
          camera.position.lerp(_camTargetPos, damp);
          controls.target.lerp(_camTargetLook, damp);
          if (camera.position.distanceTo(_camTargetPos) < 0.14) {
            transitionActiveRef.current = false;
          }
        }
      } else if (mode === 'world3d') {
        controls.enabled = true;
        if (transitionActiveRef.current) {
          _camTargetPos.set(0, 12.8, 13.8);
          _camTargetLook.set(0, 0.2, 0);
          camera.position.lerp(_camTargetPos, damp);
          controls.target.lerp(_camTargetLook, damp);
          if (camera.position.distanceTo(_camTargetPos) < 0.18) {
            transitionActiveRef.current = false;
          }
        }
      }

      controls.update();
      renderer.render(scene, camera);

      if (isSoftwareGl) afterDraw(tick);
      else frameId = requestAnimationFrame(tick);
    }

    // Initial synchronous draw of the screen canvas before first WebGL frame
    renderTDeckScreen(screenCtx, worldRef.current, uiRef.current);
    screenTexture.needsUpdate = true;
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.removeEventListener('resize', onResize);
      controls.removeEventListener('start', handleControlStart);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      controls.dispose();
      tdeck.dispose();
      diorama.dispose();
      deskGeo.dispose();
      deskMat.dispose();
      deskTex.dispose();
      shadowGeo.dispose();
      shadowMat.dispose();
      shadowTex.dispose();
      screenTexture.dispose();
      envRT.dispose();
      renderer.dispose();
      stageBridgeRef.current = null;
    };
  }, [worldRef, uiRef, stageBridgeRef]);

  return (
    <div
      ref={mountRef}
      className="fixed inset-0 w-screen h-screen overflow-hidden bg-[#0a0e16]"
    />
  );
}
