import * as THREE from 'three';

export interface TDeckKeyHandle {
  key: string;
  mesh: THREE.Mesh;
  baseY: number;
  pressAmt: number;
}

export interface TDeckModelHandle {
  group: THREE.Group;
  screenMesh: THREE.Mesh;
  trackballMesh: THREE.Mesh;
  trackballGlow: THREE.PointLight;
  sdCardMesh: THREE.Mesh;
  sdLedMesh: THREE.Mesh;
  keys: Map<string, TDeckKeyHandle>;
  interactiveMeshes: THREE.Object3D[];
  triggerKeyPress: (key: string) => void;
  nudgeTrackball: (dx: number, dy: number) => void;
  pulseSDActivity: () => void;
  updateAnimation: (dt: number) => void;
  dispose: () => void;
}

function createRoundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const hw = w / 2;
  const hh = h / 2;
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r);
  s.quadraticCurveTo(hw, hh, hw - r, hh);
  s.lineTo(-hw + r, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  s.lineTo(-hw, -hh + r);
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return s;
}

function createMicroGrainRoughnessTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 185 + Math.floor(Math.random() * 48);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

function createKeyLabelTexture(label: string, accent = false, wideSpan = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  const w = Math.max(96, Math.round(96 * wideSpan));
  const h = 72;
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#151a22';
  ctx.fillRect(0, 0, w, h);

  // Subtle top bevel highlight + inner border
  ctx.fillStyle = '#222b38';
  ctx.fillRect(4, 4, w - 8, 10);
  ctx.strokeStyle = accent ? 'rgba(34,211,238,0.28)' : 'rgba(148,163,184,0.12)';
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, w - 4, h - 4);

  ctx.fillStyle = accent ? '#38bdf8' : '#e2e8f0';
  ctx.font =
    label.length > 2
      ? 'bold 21px "IBM Plex Mono", monospace'
      : 'bold 30px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, w / 2, h / 2 + 3);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createSilkscreenBadgeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 48;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 512, 48);
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '600 18px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('LILYGO  T-DECK PLUS  ·  ESP32-S3', 256, 24);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const KEY_ROWS: { label: string; key: string; wide?: number; accent?: boolean }[][] = [
  [
    { label: 'Q', key: 'q' },
    { label: 'W', key: 'w', accent: true },
    { label: 'E', key: 'e', accent: true },
    { label: 'R', key: 'r', accent: true },
    { label: 'T', key: 't' },
    { label: 'Y', key: 'y' },
    { label: 'U', key: 'u' },
    { label: 'I', key: 'i' },
    { label: 'O', key: 'o' },
    { label: 'P', key: 'p', accent: true },
  ],
  [
    { label: 'A', key: 'a', accent: true },
    { label: 'S', key: 's', accent: true },
    { label: 'D', key: 'd', accent: true },
    { label: 'F', key: 'f' },
    { label: 'G', key: 'g' },
    { label: 'H', key: 'h' },
    { label: 'J', key: 'j' },
    { label: 'K', key: 'k' },
    { label: 'L', key: 'l' },
    { label: '←', key: 'backspace' },
  ],
  [
    { label: 'Z', key: 'z', accent: true },
    { label: 'X', key: 'x' },
    { label: 'C', key: 'c' },
    { label: 'V', key: 'v' },
    { label: 'B', key: 'b' },
    { label: 'N', key: 'n' },
    { label: 'M', key: 'm', accent: true },
    { label: '-', key: '-', accent: true },
    { label: '+', key: '+', accent: true },
    { label: 'ENT', key: 'enter' },
  ],
  [
    { label: '0', key: '0' },
    { label: '1', key: '1' },
    { label: '2', key: '2' },
    { label: 'SPACE', key: ' ', wide: 4.0, accent: true },
    { label: '3', key: '3' },
    { label: '4', key: '4' },
    { label: '5', key: '5' },
  ],
];

/**
 * Builds a composite 14+ part procedural 3D LilyGO T-Deck Plus handheld.
 * Oriented standing slightly reclined so the screen & keyboard face +Z / slightly +Y,
 * with bottom edge seated flush at y = 0.
 */
export function buildTDeckModel(
  screenTexture: THREE.CanvasTexture,
  maxAnisotropy: number
): TDeckModelHandle {
  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(obj: T): T => {
    disposables.push(obj);
    return obj;
  };

  const root = new THREE.Group();
  const bodyPivot = new THREE.Group();
  // Ergonomic desktop cradle tilt: reclined 16 deg backward, pivoted cleanly above y=0
  bodyPivot.position.set(0, 3.35, 0);
  bodyPivot.rotation.x = -0.22;
  root.add(bodyPivot);

  const grainRough = track(createMicroGrainRoughnessTexture());

  // Materials (varied roughness & metalness across adjacent parts)
  const matteBodyMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x161a21,
      roughness: 0.76,
      roughnessMap: grainRough,
      metalness: 0.08,
    })
  );
  const darkMetalRailMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x2c3442,
      roughness: 0.28,
      metalness: 0.86,
    })
  );
  const glossyBezelMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x090c11,
      roughness: 0.1,
      metalness: 0.22,
    })
  );
  const brassMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xd4a44a,
      roughness: 0.24,
      metalness: 0.92,
    })
  );
  const rubberAntennaMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x1c2026,
      roughness: 0.92,
      metalness: 0.02,
    })
  );
  const pearlMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xe8eef5,
      roughness: 0.16,
      metalness: 0.12,
      emissive: 0x112233,
      emissiveIntensity: 0.35,
    })
  );
  const sdLedMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x06b6d4,
      emissive: 0x06b6d4,
      emissiveIntensity: 0.2,
      roughness: 0.3,
    })
  );

  // 1. Primary Chassis Shell (ExtrudeGeometry with smooth bevels)
  const W = 5.4;
  const H = 6.5;
  const D = 0.62;
  const shellShape = createRoundedRectShape(W, H, 0.42);
  const shellGeo = track(
    new THREE.ExtrudeGeometry(shellShape, {
      depth: D,
      bevelEnabled: true,
      bevelThickness: 0.1,
      bevelSize: 0.09,
      bevelSegments: 4,
    })
  );
  shellGeo.center();
  const shellMesh = new THREE.Mesh(shellGeo, matteBodyMat);
  shellMesh.castShadow = true;
  shellMesh.receiveShadow = true;
  bodyPivot.add(shellMesh);

  // 2. Machined Anodized Perimeter Trim Frame
  const railOuter = createRoundedRectShape(W + 0.08, H + 0.08, 0.44);
  const railHole = createRoundedRectShape(W - 0.14, H - 0.14, 0.36);
  railOuter.holes.push(railHole);
  const railGeo = track(
    new THREE.ExtrudeGeometry(railOuter, {
      depth: 0.16,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.02,
      bevelSegments: 2,
    })
  );
  railGeo.center();
  const railMesh = new THREE.Mesh(railGeo, darkMetalRailMat);
  railMesh.position.z = D * 0.25;
  bodyPivot.add(railMesh);

  // 3. Recessed Glossy Glass Screen Bezel (upper half)
  const bezelW = 4.65;
  const bezelH = 3.42;
  const bezelY = 1.32;
  const bezelGeo = track(new THREE.BoxGeometry(bezelW, bezelH, 0.08));
  const bezelMesh = new THREE.Mesh(bezelGeo, glossyBezelMat);
  bezelMesh.position.set(0, bezelY, D / 2 + 0.075);
  bodyPivot.add(bezelMesh);

  // 4. Live 320x240 ST7789 IPS Display Plane (deep-black backlit IPS contrast)
  screenTexture.colorSpace = THREE.SRGBColorSpace;
  screenTexture.anisotropy = maxAnisotropy;
  screenTexture.magFilter = THREE.NearestFilter;
  screenTexture.minFilter = THREE.LinearFilter;
  const screenMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x0b0e14,
      map: screenTexture,
      emissiveMap: screenTexture,
      emissive: 0xffffff,
      emissiveIntensity: 1.08,
      roughness: 0.22,
      metalness: 0.04,
      envMapIntensity: 0.26,
    })
  );
  const screenW = 4.24;
  const screenH = 3.18; // exact 4:3 (320x240)
  const screenGeo = track(new THREE.PlaneGeometry(screenW, screenH));
  const screenMesh = new THREE.Mesh(screenGeo, screenMat);
  screenMesh.name = 'tdeck-screen';
  screenMesh.position.set(0, bezelY + 0.01, D / 2 + 0.122);
  bodyPivot.add(screenMesh);

  // Silkscreen brand lettering tucked cleanly between bezel bottom (-0.39) and trackball collar top (-0.61)
  const badgeTex = track(createSilkscreenBadgeTexture());
  badgeTex.anisotropy = maxAnisotropy;
  const badgeMat = track(
    new THREE.MeshBasicMaterial({
      map: badgeTex,
      transparent: true,
      opacity: 0.8,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    })
  );
  const badgeGeo = track(new THREE.PlaneGeometry(2.55, 0.22));
  const badgeMesh = new THREE.Mesh(badgeGeo, badgeMat);
  badgeMesh.position.set(0, -0.5, D / 2 + 0.112);
  bodyPivot.add(badgeMesh);

  // 5. Center Pearl Trackball + Machined Collar + Subtle Backlight
  const tbY = -0.96;
  const collarGeo = track(new THREE.TorusGeometry(0.3, 0.055, 14, 32));
  const collarMesh = new THREE.Mesh(collarGeo, darkMetalRailMat);
  collarMesh.position.set(0, tbY, D / 2 + 0.11);
  bodyPivot.add(collarMesh);

  const trackballGeo = track(new THREE.SphereGeometry(0.23, 24, 24));
  const trackballMesh = new THREE.Mesh(trackballGeo, pearlMat);
  trackballMesh.name = 'tdeck-trackball';
  trackballMesh.position.set(0, tbY, D / 2 + 0.14);
  bodyPivot.add(trackballMesh);

  const trackballGlow = new THREE.PointLight(0x38bdf8, 0.42, 2.0);
  trackballGlow.position.set(0, tbY, D / 2 + 0.42);
  bodyPivot.add(trackballGlow);

  // 6. Left & Right Acoustic Speaker Grille Slots + SD Status LED
  const slotGeo = track(new THREE.BoxGeometry(0.36, 0.045, 0.04));
  for (let side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const slot = new THREE.Mesh(slotGeo, glossyBezelMat);
      slot.position.set(side * 1.65, tbY + 0.12 - i * 0.085, D / 2 + 0.1);
      bodyPivot.add(slot);
    }
  }

  const sdLedGeo = track(new THREE.CylinderGeometry(0.045, 0.045, 0.06, 12));
  sdLedGeo.rotateX(Math.PI / 2);
  const sdLedMesh = new THREE.Mesh(sdLedGeo, sdLedMat);
  sdLedMesh.position.set(2.22, tbY, D / 2 + 0.1);
  bodyPivot.add(sdLedMesh);

  // 7. 35 Sculpted QWERTY BlackBerry Keycaps (interactive!)
  const keys = new Map<string, TDeckKeyHandle>();
  const interactiveMeshes: THREE.Object3D[] = [screenMesh, trackballMesh];

  const kbTopY = -1.52;
  const rowGap = 0.42;
  const colPitch = 0.46;
  const keyBaseZ = D / 2 + 0.13;

  const keySideMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x11151c,
      roughness: 0.65,
      metalness: 0.12,
    })
  );

  KEY_ROWS.forEach((row, rIdx) => {
    const totalUnits = row.reduce((sum, item) => sum + (item.wide ?? 1), 0);
    let cursorX = -((totalUnits - 1) * colPitch) / 2;

    row.forEach((item) => {
      const span = item.wide ?? 1;
      const kw = span * colPitch - 0.065;
      const kh = 0.33;
      const centerX = cursorX + ((span - 1) * colPitch) / 2;
      const centerY = kbTopY - rIdx * rowGap;

      const capGeo = track(new THREE.BoxGeometry(kw, kh, 0.12));
      const labelTex = track(createKeyLabelTexture(item.label, item.accent, span));
      labelTex.anisotropy = maxAnisotropy;
      const topMat = track(
        new THREE.MeshStandardMaterial({
          map: labelTex,
          roughness: 0.45,
          metalness: 0.1,
        })
      );
      const mats = [keySideMat, keySideMat, keySideMat, keySideMat, topMat, keySideMat];
      const keyMesh = new THREE.Mesh(capGeo, mats);
      keyMesh.position.set(centerX, centerY, keyBaseZ);
      keyMesh.castShadow = true;
      keyMesh.userData.tdeckKey = item.key;
      keyMesh.name = `key-${item.key}`;
      bodyPivot.add(keyMesh);

      keys.set(item.key, {
        key: item.key,
        mesh: keyMesh,
        baseY: keyBaseZ,
        pressAmt: 0,
      });
      interactiveMeshes.push(keyMesh);
      cursorX += span * colPitch;
    });
  });

  // 8. LoRa SMA Antenna (top-right edge)
  const smaBaseGeo = track(new THREE.CylinderGeometry(0.14, 0.16, 0.24, 16));
  const smaBase = new THREE.Mesh(smaBaseGeo, brassMat);
  smaBase.position.set(2.05, H / 2 + 0.16, -0.02);
  bodyPivot.add(smaBase);

  const whipGeo = track(new THREE.CylinderGeometry(0.085, 0.125, 2.35, 16));
  const whipMesh = new THREE.Mesh(whipGeo, rubberAntennaMat);
  whipMesh.position.set(2.05, H / 2 + 1.42, -0.02);
  whipMesh.castShadow = true;
  bodyPivot.add(whipMesh);

  const whipCapGeo = track(new THREE.SphereGeometry(0.085, 14, 12));
  const whipCap = new THREE.Mesh(whipCapGeo, rubberAntennaMat);
  whipCap.position.set(2.05, H / 2 + 2.59, -0.02);
  bodyPivot.add(whipCap);

  // 9. Right-Edge MicroSD Slot + Gold-Contact MicroSD Card
  const sdSlotGeo = track(new THREE.BoxGeometry(0.08, 0.78, 0.14));
  const sdSlot = new THREE.Mesh(sdSlotGeo, glossyBezelMat);
  sdSlot.position.set(W / 2 + 0.07, 0.65, 0);
  bodyPivot.add(sdSlot);

  const sdCardGeo = track(new THREE.BoxGeometry(0.24, 0.66, 0.08));
  const sdCardMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.4,
      metalness: 0.35,
    })
  );
  const sdCardMesh = new THREE.Mesh(sdCardGeo, sdCardMat);
  sdCardMesh.position.set(W / 2 + 0.09, 0.65, 0);
  bodyPivot.add(sdCardMesh);

  const sdTrimGeo = track(new THREE.BoxGeometry(0.05, 0.56, 0.09));
  const sdTrim = new THREE.Mesh(sdTrimGeo, brassMat);
  sdTrim.position.set(0.11, 0, 0);
  sdCardMesh.add(sdTrim);

  // 10. Top Power Slide Switch & Bottom USB-C Port
  const pwrSwitchGeo = track(new THREE.BoxGeometry(0.45, 0.14, 0.22));
  const pwrSwitch = new THREE.Mesh(pwrSwitchGeo, darkMetalRailMat);
  pwrSwitch.position.set(-1.75, H / 2 + 0.1, 0);
  bodyPivot.add(pwrSwitch);

  const usbcGeo = track(new THREE.BoxGeometry(0.68, 0.12, 0.26));
  const usbcPort = new THREE.Mesh(usbcGeo, darkMetalRailMat);
  usbcPort.position.set(0, -H / 2 - 0.08, 0);
  bodyPivot.add(usbcPort);

  // 11. 4 Corner M2 Hex Screws on front corners
  const screwGeo = track(new THREE.CylinderGeometry(0.08, 0.08, 0.05, 6));
  screwGeo.rotateX(Math.PI / 2);
  const screwOffsets = [
    [-2.42, 2.94],
    [2.42, 2.94],
    [-2.42, -2.94],
    [2.42, -2.94],
  ];
  for (const [sx, sy] of screwOffsets) {
    const screw = new THREE.Mesh(screwGeo, darkMetalRailMat);
    screw.position.set(sx, sy, D / 2 + 0.1);
    bodyPivot.add(screw);
  }

  // 12. Weighted Rear Desktop Cradle Foot (so handheld rests naturally on y = 0!)
  const standGeo = track(new THREE.BoxGeometry(3.8, 0.26, 1.35));
  const standMesh = new THREE.Mesh(standGeo, darkMetalRailMat);
  standMesh.position.set(0, 0.13, -0.58);
  standMesh.castShadow = true;
  standMesh.receiveShadow = true;
  root.add(standMesh);

  let tbVelX = 0;
  let tbVelY = 0;
  let sdPulse = 0;

  return {
    group: root,
    screenMesh,
    trackballMesh,
    trackballGlow,
    sdCardMesh,
    sdLedMesh,
    keys,
    interactiveMeshes,
    triggerKeyPress(rawKey: string) {
      const k = rawKey.toLowerCase();
      const handle = keys.get(k);
      if (handle) {
        handle.pressAmt = 1.0;
      }
    },
    nudgeTrackball(dx: number, dy: number) {
      tbVelX += dx * 6.5;
      tbVelY += dy * 6.5;
    },
    pulseSDActivity() {
      sdPulse = 1.0;
    },
    updateAnimation(dt: number) {
      const damp = 1 - Math.exp(-16 * dt);
      keys.forEach((kh) => {
        if (kh.pressAmt > 0.001) {
          kh.pressAmt = Math.max(0, kh.pressAmt - dt * 7.5);
        }
        const targetZ = kh.baseY - kh.pressAmt * 0.065;
        kh.mesh.position.z += (targetZ - kh.mesh.position.z) * damp;
      });

      if (Math.abs(tbVelX) > 0.001 || Math.abs(tbVelY) > 0.001) {
        trackballMesh.rotation.y += tbVelX * dt;
        trackballMesh.rotation.x += tbVelY * dt;
        const tbDamp = Math.exp(-9 * dt);
        tbVelX *= tbDamp;
        tbVelY *= tbDamp;
      }

      if (sdPulse > 0.001) {
        sdPulse = Math.max(0, sdPulse - dt * 2.4);
      }
      sdLedMat.emissiveIntensity = 0.25 + sdPulse * 3.5;
      sdCardMesh.position.x = W / 2 + 0.09 + sdPulse * 0.03;
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };
}
