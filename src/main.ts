import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import RAPIER from '@dimforge/rapier3d-compat';
import './style.css';
import { GRID_HALF, TUNING } from './config';
import { loadSavedRun, saveRun, type SavedRun } from './save/storage';
import type { Cell, Enemy, EnemyKind, GridPos, MaterialKind, Phase, PlaceKind, Structure, TowerKind } from './types';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root was not found');

const structureKey = (x: number, y: number, z: number) => `${x},${y},${z}`;
const floorKey = (x: number, z: number) => `${x},${z}`;
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
const SIMULATION_STEP = 1 / 60;
const MAX_FRAME_DELTA = 0.1;

function createRunSeed() {
  const seedQuery = new URLSearchParams(window.location.search).get('seed');
  if (seedQuery !== null && /^\d+$/.test(seedQuery)) return Number(seedQuery) >>> 0;
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) return crypto.getRandomValues(new Uint32Array(1))[0];
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next() {
    // Mulberry32: a small, deterministic generator suitable for wave composition and spawn positions.
    let value = this.state += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 0x1_0000_0000;
  }
}

class VoxelSiege {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(37, 1, 0.1, 180);
  private renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  private controls!: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerStart: { x: number; y: number } | null = null;
  private ground = new THREE.Mesh(new THREE.PlaneGeometry(TUNING.gridWidth, TUNING.gridWidth), new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 1 }));
  private grid = new THREE.GridHelper(TUNING.gridWidth, TUNING.gridWidth, 0x73777e, 0x42464d);
  private structures = new Map<string, Structure>();
  private enemies: Enemy[] = [];
  private enemyMeshes = new Map<number, THREE.Group>();
  private debris = new Map<number, { structure: Structure; body: RAPIER.RigidBody; settleTime: number }>();
  private projectiles: Array<{ mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; life: number; maxLife: number; damage: number; targetId: number; splash: boolean }> = [];
  private structureMeshes = new Map<number, THREE.Object3D>();
  private materialBatches = new Map<MaterialKind, THREE.InstancedMesh>();
  private batchStructures = new Map<THREE.InstancedMesh, Structure[]>();
  private structureInstances = new Map<number, { mesh: THREE.InstancedMesh; index: number }>();
  private nextId = 1;
  private layoutVersion = 0;
  private routeCache = new Map<string, GridPos[]>();
  private phase: Phase = 'place-throne';
  private selected: PlaceKind = 'wood';
  private selectedRubble: Structure | null = null;
  private core: Structure | null = null;
  private gold: number = TUNING.startingGold;
  private wave = 1;
  private coreHealth: number = TUNING.coreHealth;
  private runSeed = createRunSeed();
  private random = new SeededRandom(this.runSeed);
  private spawnRemaining = 0;
  private spawnTimer = 0;
  private towerTimers = new Map<number, number>();
  private physics!: RAPIER.World;
  private preview?: THREE.Mesh;
  private lastFrame = performance.now();
  private simulationAccumulator = 0;
  private elapsed = 0;
  private toastTimer?: number;
  private persistenceWarningShown = false;
  private ui = {
    gold: undefined as HTMLElement | undefined,
    wave: undefined as HTMLElement | undefined,
    phase: undefined as HTMLElement | undefined,
    health: undefined as HTMLElement | undefined,
    start: undefined as HTMLButtonElement | undefined,
    hint: undefined as HTMLElement | undefined,
    toast: undefined as HTMLElement | undefined,
    rubble: undefined as HTMLElement | undefined,
    overlay: undefined as HTMLElement | undefined,
    panel: undefined as HTMLElement | undefined,
  };

  async start() {
    await RAPIER.init();
    this.physics = new RAPIER.World({ x: 0, y: -12, z: 0 });
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(TUNING.gridWidth / 2, 0.08, TUNING.gridWidth / 2).setTranslation(0, -0.08, 0));
    this.mountUi();
    this.mountScene();
    this.installEvents();
    this.syncUi();
    try {
      const savedRun = await loadSavedRun();
      if (savedRun) {
        this.restoreSavedRun(savedRun);
        this.showToast('Saved run restored.');
      }
    } catch (error) {
      console.warn('Local run storage is unavailable.', error);
      this.showToast('Local saving is unavailable in this browser session.');
    }
    this.syncUi();
    this.animate();
  }

  private mountUi() {
    app!.innerHTML = `
      <main class="game">
        <div class="scene" id="scene"></div>
        <div class="hud">
          <header class="topbar">
            <div class="brand"><div class="brand-mark">V</div><div><div class="brand-title">Voxel Siege</div><div class="brand-sub" id="run-seed">Prototype</div></div></div>
            <div class="run-status"><span class="status-dot" id="phase-dot"></span><span id="phase-text">Place the core</span></div>
            <div class="top-right">
              <div class="stat"><div class="stat-label">Wave</div><div class="stat-value" id="wave-value">01</div></div>
              <div class="stat"><div class="stat-label">Core integrity</div><div class="stat-value" id="health-value">100%</div></div>
              <div class="stat"><div class="stat-label">Gold</div><div class="stat-value gold" id="gold-value">100</div></div>
            </div>
          </header>
          <aside class="left-panel panel" id="build-panel"></aside>
          <div class="help panel"><strong>Left click</strong> place / select rubble<br><strong>Drag</strong> orbit camera � <strong>Right drag</strong> pan<br><strong>Scroll</strong> zoom<br><strong>Esc</strong> cancel rubble move</div>
          <section class="action-panel panel">
            <div class="panel-heading"><span>Defense phase</span><span id="wave-label" class="wave-count">Wave 01</span></div>
            <p class="panel-caption" id="action-caption">Place your throne anywhere on the grid to begin.</p>
            <button class="primary" id="start-wave">Place throne</button>
            <div class="selected-rubble" id="rubble-status"></div>
          </section>
          <div class="toast panel" id="toast"></div>
          <div class="overlay" id="overlay" style="display:none"><div class="modal panel"><h1>Run over</h1><p>The throne has fallen. Your next run will begin with a fresh map and 100 gold.</p><div class="wave-count" id="final-wave">Wave 01 reached</div><div style="height:18px"></div><button class="primary" id="restart">Start new run</button></div></div>
        </div>
      </main>`;
    this.ui.gold = document.querySelector<HTMLElement>('#gold-value')!;
    this.ui.wave = document.querySelector<HTMLElement>('#wave-value')!;
    this.ui.phase = document.querySelector<HTMLElement>('#phase-text')!;
    this.ui.health = document.querySelector<HTMLElement>('#health-value')!;
    this.ui.start = document.querySelector<HTMLButtonElement>('#start-wave')!;
    this.ui.hint = document.querySelector<HTMLElement>('#action-caption')!;
    this.ui.toast = document.querySelector<HTMLElement>('#toast')!;
    this.ui.rubble = document.querySelector<HTMLElement>('#rubble-status')!;
    this.ui.overlay = document.querySelector<HTMLElement>('#overlay')!;
    this.ui.panel = document.querySelector<HTMLElement>('#build-panel')!;
    document.querySelector<HTMLElement>('#run-seed')!.textContent = `Run seed ${this.runSeed}`;
    this.ui.start.addEventListener('click', () => this.beginWave());
    document.querySelector('#restart')?.addEventListener('click', () => this.restart());
    this.renderBuildPanel();
  }

  private mountScene() {
    const container = document.querySelector<HTMLDivElement>('#scene')!;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x111216);
    this.camera.position.set(24, 27, 24);
    this.camera.lookAt(0, 0, 0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 55;

    this.scene.add(new THREE.HemisphereLight(0xc8cbd1, 0x31343a, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 2.5);
    key.position.set(-9, 24, 15);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7598cf, 1.0);
    rim.position.set(16, 9, -18);
    this.scene.add(rim);

    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.055;
    this.scene.add(this.ground);
    this.grid.position.y = 0.006;
    const gridMaterials = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material];
    for (const material of gridMaterials) { material.transparent = true; material.opacity = 0.34; }
    this.scene.add(this.grid);
    this.addFogRing();
    this.addBoundary();

    this.preview = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.92, 0.92), new THREE.MeshBasicMaterial({ color: 0x91a7c7, transparent: true, opacity: 0.35, depthWrite: false }));
    this.preview.visible = false;
    this.scene.add(this.preview);
    window.addEventListener('resize', this.onResize);
  }

  private addFogRing() {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { time: { value: 0 } },
      vertexShader: `varying vec3 vPos; void main(){ vPos=(modelMatrix*vec4(position,1.0)).xyz; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        varying vec3 vPos; uniform float time;
        float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
        float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y); }
        void main(){ float r=length(vPos.xz); float squareEdge=max(abs(vPos.x),abs(vPos.z)); float edge=smoothstep(14.1,17.0,squareEdge)*(1.0-smoothstep(28.0,37.0,r)); float n=noise(vPos.xz*0.42+time*0.05); float wisps=noise(vPos.xz*0.18-time*0.025); float a=edge*(0.09+n*0.12+wisps*0.08); gl_FragColor=vec4(vec3(0.57,0.59,0.62),a); }
      `,
    });
    const fog = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), material);
    fog.rotation.x = -Math.PI / 2;
    fog.position.y = 0.025;
    this.scene.add(fog);
    (this as unknown as { fogMaterial: THREE.ShaderMaterial }).fogMaterial = material;
  }

  private addBoundary() {
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(TUNING.gridWidth, 0.01, TUNING.gridWidth)), new THREE.LineBasicMaterial({ color: 0x9aa0a8, transparent: true, opacity: 0.18 }));
    edge.position.y = 0.015;
    this.scene.add(edge);
  }

  private installEvents() {
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('pointerdown', (event) => {
      this.pointerStart = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    });
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    this.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('pagehide', () => this.saveCheckpoint());
  }

  private onResize = () => {
    const container = document.querySelector<HTMLDivElement>('#scene');
    if (!container) return;
    this.camera.aspect = container.clientWidth / Math.max(container.clientHeight, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === 'r') this.showToast('Block orientation is fixed in this first slice.');
    if (event.key === 'Escape') { this.selectedRubble = null; this.syncUi(); }
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.preview || this.phase === 'wave' || this.phase === 'defeat') { if (this.preview) this.preview.visible = false; return; }
    const hit = this.getGridHit(event);
    if (!hit || !this.isInsideGrid(hit.x, hit.z)) { this.preview.visible = false; return; }
    this.preview.visible = true;
    this.preview.position.set(hit.x, hit.y + 0.5, hit.z);
    const isCore = this.phase === 'place-throne';
    this.preview.scale.set(1, 1, 1);
    const color = isCore ? 0xd3d3d3 : this.selected === 'wood' ? 0x9b8269 : this.selected === 'stone' ? 0xaab0b8 : this.selected === 'steel' ? 0xd5d8de : 0x5b9cff;
    (this.preview.material as THREE.MeshBasicMaterial).color.setHex(color);
    const occupied = this.structures.has(structureKey(hit.x, hit.y, hit.z));
    (this.preview.material as THREE.MeshBasicMaterial).opacity = occupied ? 0.1 : 0.36;
  };

  private onPointerUp = (event: PointerEvent) => {
    const start = this.pointerStart;
    this.pointerStart = null;
    if (event.button !== 0 || !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || this.phase === 'wave' || this.phase === 'defeat') return;
    const hit = this.getGridHit(event);
    if (!hit || !this.isInsideGrid(hit.x, hit.z)) return;
    if (this.phase === 'place-throne') { this.placeThrone(hit); return; }
    const found = this.pickStructure(event);
    if (found?.rubble) {
      if (this.selectedRubble && this.selectedRubble.id !== found.id) { this.moveRubble(hit); return; }
      this.selectedRubble = found;
      this.syncUi();
      return;
    }
    if (this.selectedRubble) { this.moveRubble(hit); return; }
    this.placeSelected(hit);
  };

  private getGridHit(event: PointerEvent): Cell | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets = [...new Set(this.structureMeshes.values()), this.ground];
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    let x = Math.round(hit.point.x);
    let z = Math.round(hit.point.z);
    let y = 0;
    const structure = this.structureForObject(hit.object, hit.instanceId);
    if (structure && hit.face) {
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (normal.y > 0.55) y = structure.cell.y + 1;
      else if (normal.y < -0.55) y = Math.max(0, structure.cell.y - 1);
      else { x = structure.cell.x + Math.round(normal.x); z = structure.cell.z + Math.round(normal.z); y = structure.cell.y; }
    }
    return { x, y, z };
  }

  private pickStructure(event: PointerEvent): Structure | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects([...new Set(this.structureMeshes.values())], false)[0];
    return hit ? this.structureForObject(hit.object, hit.instanceId) : null;
  }

  private structureForObject(object: THREE.Object3D, instanceId?: number) {
    if (object instanceof THREE.InstancedMesh && instanceId !== undefined) return this.batchStructures.get(object)?.[instanceId] ?? null;
    let current: THREE.Object3D | null = object;
    while (current && current !== this.scene) {
      const found = [...this.structures.values()].find((item) => item.mesh === current);
      if (found) return found;
      current = current.parent;
    }
    return null;
  }

  private isInsideGrid(x: number, z: number) { return Math.abs(x) < GRID_HALF && Math.abs(z) < GRID_HALF; }

  private placeThrone(cell: Cell) {
    const pos = { ...cell, y: 0 };
    if (this.structures.has(structureKey(pos.x, pos.y, pos.z))) return this.showToast('That grid cell is occupied.');
    const core: Structure = { id: this.nextId++, kind: 'throne', cell: pos, health: this.coreHealth, maxHealth: this.coreHealth, rubble: false };
    this.core = core;
    this.addStructure(core);
    this.phase = 'build';
    this.showToast('Throne placed. Build your first defense.');
    this.syncUi();
    this.saveCheckpoint();
  }

  private placeSelected(cell: Cell) {
    const kind = this.selected;
    if (kind === 'throne') return;
    const key = structureKey(cell.x, cell.y, cell.z);
    if (this.structures.has(key)) return this.showToast('That cell is occupied.');
    if (cell.y > 0 && !this.structures.has(structureKey(cell.x, cell.y - 1, cell.z))) return this.showToast('Blocks need support beneath them.');
    const price = this.priceFor(kind);
    if (this.gold < price) return this.showToast('Not enough gold.');
    this.gold -= price;
    const isTower = kind === 'single' || kind === 'splash';
    const hp = isTower ? TUNING.towerHealth : TUNING.blockHealth[kind as MaterialKind];
    const item: Structure = { id: this.nextId++, kind, cell: { ...cell }, health: hp, maxHealth: hp, rubble: false };
    this.addStructure(item);
    this.syncUi();
    this.saveCheckpoint();
  }

  private moveRubble(target: Cell) {
    if (!this.selectedRubble) return;
    const piece = this.selectedRubble;
    const dest = { ...target, y: Math.max(0, target.y) };
    if (this.structures.has(structureKey(dest.x, dest.y, dest.z))) return this.showToast('That cell is occupied.');
    if (dest.y > 0 && !this.structures.has(structureKey(dest.x, dest.y - 1, dest.z))) return this.showToast('Rubble needs support beneath it.');
    if (this.gold < TUNING.rubbleMoveCost) return this.showToast('Not enough gold to move rubble.');
    this.gold -= TUNING.rubbleMoveCost;
    this.structures.delete(structureKey(piece.cell.x, piece.cell.y, piece.cell.z));
    piece.cell = dest;
    this.structures.set(structureKey(dest.x, dest.y, dest.z), piece);
    this.layoutVersion++;
    this.routeCache.clear();
    if (piece.mesh) piece.mesh.position.set(dest.x, dest.y + 0.5, dest.z);
    const fallen = this.dropUnsupportedStructures();
    this.selectedRubble = null;
    this.showToast(fallen ? `Rubble moved. ${fallen} unsupported ${fallen === 1 ? 'block fell' : 'blocks fell'}.` : 'Rubble moved and reused.');
    this.syncUi();
    this.saveCheckpoint();
  }

  private priceFor(kind: PlaceKind) {
    if (kind === 'single' || kind === 'splash') return TUNING.towerCosts[kind];
    if (kind === 'wood' || kind === 'stone' || kind === 'steel') return TUNING.blockCosts[kind];
    return 0;
  }

  private addStructure(item: Structure, rebuildBatch = true) {
    this.structures.set(structureKey(item.cell.x, item.cell.y, item.cell.z), item);
    if (this.isMaterial(item.kind)) {
      item.mesh = undefined;
      if (rebuildBatch) this.rebuildMaterialBatches();
    } else {
      const mesh = this.createStructureMesh(item);
      item.mesh = mesh;
      this.structureMeshes.set(item.id, mesh);
      this.scene.add(mesh);
    }
    this.layoutVersion++;
    this.routeCache.clear();
  }

  private createStructureMesh(item: Structure) {
    const group = new THREE.Group();
    group.position.set(item.cell.x, item.cell.y + 0.5, item.cell.z);
    const baseColor = item.kind === 'wood' ? 0x77736e : item.kind === 'stone' ? 0x92969b : item.kind === 'steel' ? 0xc0c4ca : item.kind === 'throne' ? 0xb7b8bb : 0x367ce5;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.92, 0.92), new THREE.MeshStandardMaterial({ color: baseColor, roughness: item.kind === 'steel' ? 0.36 : 0.86, metalness: item.kind === 'steel' ? 0.65 : 0.05 }));
    group.add(body);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.925, 0.925, 0.925)), new THREE.LineBasicMaterial({ color: item.rubble ? 0xb8b9bc : 0xe2e4e7, transparent: true, opacity: item.rubble ? 0.12 : 0.19 }));
    group.add(edge);
    if (item.kind === 'single' || item.kind === 'splash') {
      const accent = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.35, 0.24), new THREE.MeshStandardMaterial({ color: item.kind === 'single' ? 0x73a8ff : 0x4e83dc, emissive: 0x172d52 }));
      accent.position.y = 0.55;
      group.add(accent);
      const barrel = new THREE.Mesh(new THREE.BoxGeometry(item.kind === 'single' ? 0.16 : 0.27, 0.16, 0.48), new THREE.MeshStandardMaterial({ color: 0x9bbcff, metalness: 0.55, roughness: 0.35 }));
      barrel.position.set(0, 0.53, -0.15);
      group.add(barrel);
    }
    if (item.kind === 'throne') {
      const marker = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), new THREE.MeshBasicMaterial({ color: 0xd9dce0 }));
      marker.position.y = 0.61;
      group.add(marker);
    }
    return group;
  }

  private rebuildMaterialBatches() {
    for (const [mesh, items] of this.batchStructures) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      for (const item of items) {
        this.structureMeshes.delete(item.id);
        this.structureInstances.delete(item.id);
      }
    }
    this.materialBatches.clear();
    this.batchStructures.clear();

    for (const kind of ['wood', 'stone', 'steel'] satisfies MaterialKind[]) {
      const items = [...this.structures.values()].filter((item) => item.kind === kind);
      if (!items.length) continue;
      const colors: Record<MaterialKind, number> = { wood: 0x77736e, stone: 0x92969b, steel: 0xc0c4ca };
      const baseMaterial = new THREE.MeshStandardMaterial({ color: colors[kind], roughness: kind === 'steel' ? 0.36 : 0.86, metalness: kind === 'steel' ? 0.65 : 0.05 });
      const batch = new THREE.InstancedMesh(new THREE.BoxGeometry(0.92, 0.92, 0.92), baseMaterial, items.length);
      batch.name = `${kind}-blocks`;
      batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const transform = new THREE.Object3D();
        transform.position.set(item.cell.x, item.cell.y + 0.5, item.cell.z);
        transform.updateMatrix();
        batch.setMatrixAt(index, transform.matrix);
        batch.setColorAt(index, this.damageTint(item));
        this.structureMeshes.set(item.id, batch);
        this.structureInstances.set(item.id, { mesh: batch, index });
      }
      batch.instanceMatrix.needsUpdate = true;
      if (batch.instanceColor) batch.instanceColor.needsUpdate = true;
      batch.computeBoundingSphere();
      this.scene.add(batch);
      this.materialBatches.set(kind, batch);
      this.batchStructures.set(batch, items);
    }
  }

  private damageTint(item: Structure) {
    const damage = 1 - clamp(item.health / item.maxHealth, 0, 1);
    return new THREE.Color(0xffffff).lerp(new THREE.Color(0xc83232), damage * 0.72);
  }

  private refreshStructureDamage(item: Structure) {
    const instance = this.structureInstances.get(item.id);
    if (instance) {
      instance.mesh.setColorAt(instance.index, this.damageTint(item));
      if (instance.mesh.instanceColor) instance.mesh.instanceColor.needsUpdate = true;
      return;
    }
    const body = item.mesh?.children[0];
    if (!(body instanceof THREE.Mesh)) return;
    const material = body.material;
    if (material instanceof THREE.MeshStandardMaterial) {
      const base = item.kind === 'throne' ? 0xb7b8bb : 0x367ce5;
      material.color.setHex(base).lerp(new THREE.Color(0xc83232), (1 - clamp(item.health / item.maxHealth, 0, 1)) * 0.72);
    }
  }

  private renderBuildPanel() {
    const panel = this.ui.panel;
    if (!panel) return;
    const blockItems: Array<[MaterialKind, string]> = [['wood', 'Wood'], ['stone', 'Stone'], ['steel', 'Steel']];
    const towerItems: Array<[TowerKind, string]> = [['single', 'Single target'], ['splash', 'Splash damage']];
    panel.innerHTML = `<div class="panel-heading"><span>Build menu</span><span class="wave-count">Grid</span></div>
      <p class="panel-caption">Select a piece, then place it on the grid. Stack blocks by clicking a top face.</p>
      <div class="item-list">${blockItems.map(([kind, name]) => `<button class="item ${this.selected === kind ? 'selected' : ''}" data-kind="${kind}"><span class="item-name"><i class="swatch ${kind}"></i>${name}</span><span class="item-price">${TUNING.blockCosts[kind]} G</span></button>`).join('')}</div>
      <div class="separator"></div><div class="panel-heading"><span>Towers</span></div>
      <div class="item-list">${towerItems.map(([kind, name]) => `<button class="item ${this.selected === kind ? 'selected' : ''}" data-kind="${kind}"><span class="item-name"><i class="swatch tower"></i>${name}</span><span class="item-price">${TUNING.towerCosts[kind]} G</span></button>`).join('')}</div>`;
    panel.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((button) => {
      button.addEventListener('click', () => {
        this.selected = button.dataset.kind as PlaceKind;
        this.selectedRubble = null;
        this.renderBuildPanel();
        this.syncUi();
      });
    });
  }

  private beginWave() {
    if (this.phase !== 'build' || !this.core) return;
    this.phase = 'wave';
    this.selectedRubble = null;
    this.spawnRemaining = TUNING.waveEnemyCountBase + (this.wave - 1) * TUNING.waveEnemyGrowth;
    this.spawnTimer = 0.3;
    this.showToast(`Wave ${String(this.wave).padStart(2, '0')} incoming from the fog.`);
    this.syncUi();
  }

  private restart() {
    for (const structure of this.structures.values()) if (structure.mesh) this.scene.remove(structure.mesh);
    for (const batch of this.materialBatches.values()) {
      this.scene.remove(batch);
      batch.geometry.dispose();
      (batch.material as THREE.Material).dispose();
    }
    this.materialBatches.clear();
    this.batchStructures.clear();
    this.structureInstances.clear();
    for (const mesh of this.enemyMeshes.values()) this.scene.remove(mesh);
    for (const piece of this.debris.values()) this.physics.removeRigidBody(piece.body);
    for (const projectile of this.projectiles) this.scene.remove(projectile.mesh);
    this.structures.clear(); this.structureMeshes.clear(); this.enemies = []; this.enemyMeshes.clear(); this.debris.clear(); this.projectiles = [];
    this.towerTimers.clear();
    this.routeCache.clear(); this.layoutVersion++;
    this.core = null; this.gold = TUNING.startingGold; this.wave = 1; this.coreHealth = TUNING.coreHealth; this.nextId = 1; this.phase = 'place-throne'; this.selectedRubble = null; this.selected = 'wood'; this.spawnRemaining = 0; this.spawnTimer = 0;
    this.runSeed = createRunSeed();
    this.random = new SeededRandom(this.runSeed);
    document.querySelector<HTMLElement>('#run-seed')!.textContent = `Run seed ${this.runSeed}`;
    this.ui.overlay!.style.display = 'none';
    this.renderBuildPanel();
    this.showToast('New run. Place your throne anywhere on the grid.');
    this.syncUi();
    this.saveCheckpoint();
  }

  private restoreSavedRun(saved: SavedRun) {
    this.runSeed = saved.seed;
    this.random = new SeededRandom(saved.seed);
    this.phase = saved.phase;
    this.gold = saved.gold;
    this.wave = saved.wave;
    this.coreHealth = saved.coreHealth;
    this.core = null;
    this.nextId = 1;
    this.structures.clear();
    this.structureMeshes.clear();
    this.routeCache.clear();
    this.layoutVersion++;
    for (const savedStructure of saved.structures) {
      const item: Structure = { ...savedStructure, cell: { ...savedStructure.cell } };
      if (item.kind === 'throne') {
        this.core = item;
        item.health = this.coreHealth;
      }
      this.nextId = Math.max(this.nextId, item.id + 1);
      this.addStructure(item, false);
    }
    this.rebuildMaterialBatches();
    document.querySelector<HTMLElement>('#run-seed')!.textContent = `Run seed ${this.runSeed}`;
    this.ui.overlay!.style.display = this.phase === 'defeat' ? 'grid' : 'none';
    if (this.phase === 'defeat') {
      document.querySelector<HTMLElement>('#final-wave')!.textContent = `Wave ${String(this.wave).padStart(2, '0')} reached`;
    }
  }

  private saveCheckpoint() {
    if (this.phase === 'wave') return;
    const saved: SavedRun = {
      schemaVersion: 1,
      seed: this.runSeed,
      phase: this.phase,
      gold: this.gold,
      wave: this.wave,
      coreHealth: this.coreHealth,
      structures: [...this.structures.values()].map((item) => ({
        id: item.id,
        kind: item.kind,
        cell: { ...item.cell },
        health: item.health,
        maxHealth: item.maxHealth,
        rubble: item.rubble,
      })),
      settings: {},
    };
    void saveRun(saved).catch((error) => {
      if (!this.persistenceWarningShown) {
        this.persistenceWarningShown = true;
        this.showToast('Could not save locally. Your run may not survive a reload.');
      }
      console.warn('Failed to save the local run.', error);
    });
  }

  private updateWave(dt: number) {
    this.spawnTimer -= dt;
    if (this.spawnRemaining > 0 && this.spawnTimer <= 0) {
      this.spawnEnemy(this.nextEnemyKind());
      this.spawnRemaining--;
      this.spawnTimer = TUNING.spawnIntervalSeconds;
    }
    for (const enemy of [...this.enemies]) this.updateEnemy(enemy, dt);
    if (this.spawnRemaining === 0 && this.enemies.length === 0 && this.phase === 'wave') {
      this.phase = 'build';
      this.gold += TUNING.waveGoldBonus;
      this.wave++;
      this.showToast(`Wave cleared. +${TUNING.waveGoldBonus} gold. Move rubble and rebuild.`);
      this.syncUi();
      this.saveCheckpoint();
    }
  }

  private nextEnemyKind(): EnemyKind {
    // TUNING - wave unlocks and mix are provisional playtest values.
    if (this.wave >= TUNING.bomberUnlockWave && this.random.next() < TUNING.bomberWaveChance) return 'bomber';
    if (this.wave >= TUNING.ladderUnlockWave && this.random.next() < TUNING.ladderWaveChance) return 'ladder';
    return 'grunt';
  }

  private spawnEnemy(kind: EnemyKind) {
    if (!this.core) return;
    const angle = this.random.next() * Math.PI * 2;
    const radius = GRID_HALF + 7 + this.random.next() * 4;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const group = new THREE.Group();
    const count = kind === 'ladder' ? 4 : kind === 'bomber' ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const cube = new THREE.Mesh(new THREE.BoxGeometry(kind === 'bomber' ? 0.42 : 0.46, kind === 'bomber' ? 0.58 : 0.48, kind === 'bomber' ? 0.42 : 0.46), new THREE.MeshStandardMaterial({ color: 0xb94747, roughness: 0.8, emissive: 0x240808 }));
      const offsets = kind === 'ladder' ? [[-0.27, 0, 0], [0.27, 0, 0], [-0.27, 0, 0.5], [0.27, 0, 0.5]] : [[0, 0, 0], [0.38, 0, 0.12]];
      cube.position.set(offsets[i][0], 0.25 + (kind === 'bomber' ? 0.04 : 0), offsets[i][2]);
      group.add(cube);
    }
    if (kind === 'ladder') {
      const ladder = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.3, 0.09), new THREE.MeshStandardMaterial({ color: 0xbba98e }));
      ladder.position.set(0, 0.55, -0.15); ladder.rotation.z = -0.25; group.add(ladder);
    }
    group.position.set(x, 0, z);
    this.scene.add(group);
    const health = kind === 'bomber' ? 30 : kind === 'ladder' ? 48 : TUNING.enemyHealth;
    const id = this.nextId++;
    this.enemies.push({ id, kind, x, z, height: 0, previousX: x, previousZ: z, previousHeight: 0, health, maxHealth: health, attackTimer: 0, ladderTimer: 0, path: [], pathIndex: 0 });
    this.enemyMeshes.set(id, group);
  }

  private updateEnemy(enemy: Enemy, dt: number) {
    if (this.phase !== 'wave' || !this.core) return;
    enemy.previousX = enemy.x;
    enemy.previousZ = enemy.z;
    enemy.previousHeight = enemy.height;
    enemy.attackTimer -= dt;
    const current = { x: Math.round(enemy.x), z: Math.round(enemy.z) };
    const path = this.findPath(current, enemy.kind);
    if (path.length > 0) {
      const next = path[0];
      const dx = next.x - enemy.x, dz = next.z - enemy.z;
      const distance = Math.hypot(dx, dz);
      const obstacle = this.structures.get(structureKey(next.x, 0, next.z));
      if (enemy.kind === 'ladder' && obstacle && obstacle.kind !== 'throne' && distance < 0.24) {
        enemy.ladderTimer += dt;
        if (enemy.ladderTimer >= 1.15) { enemy.x = next.x; enemy.z = next.z; enemy.ladderTimer = 0; enemy.height = 0; }
        else enemy.height = 1.35 * Math.sin((enemy.ladderTimer / 1.15) * Math.PI);
      }
      else if (distance < 0.24) { enemy.x = next.x; enemy.z = next.z; enemy.height = 0; }
      else { enemy.x += dx / distance * TUNING.enemySpeed * dt; enemy.z += dz / distance * TUNING.enemySpeed * dt; }
      enemy.path = path;
    } else {
      this.approachBlockingStructure(enemy, dt);
    }
    const goalDist = Math.hypot(enemy.x - this.core.cell.x, enemy.z - this.core.cell.z);
    if (goalDist <= 1.2 && enemy.attackTimer <= 0) {
      this.coreHealth -= enemy.kind === 'bomber' ? 12 : 7;
      enemy.attackTimer = 0.75;
      if (this.coreHealth <= 0) { this.coreHealth = 0; this.phase = 'defeat'; this.showDefeat(); }
      this.syncUi();
    }
    const mesh = this.enemyMeshes.get(enemy.id);
    if (mesh) { mesh.position.set(enemy.x, enemy.height, enemy.z); mesh.rotation.y = Math.atan2(this.core.cell.x - enemy.x, this.core.cell.z - enemy.z); }
  }

  private findPath(start: GridPos, kind: EnemyKind): GridPos[] {
    if (!this.core) return [];
    const startPos = { x: clamp(Math.round(start.x), -GRID_HALF + 1, GRID_HALF - 1), z: clamp(Math.round(start.z), -GRID_HALF + 1, GRID_HALF - 1) };
    const startKey = floorKey(startPos.x, startPos.z);
    const cacheKey = `${kind}:${startKey}:${this.core.cell.x},${this.core.cell.z}:${this.layoutVersion}`;
    const cached = this.routeCache.get(cacheKey);
    if (cached) return cached;
    const goals: GridPos[] = [
      { x: this.core.cell.x + 1, z: this.core.cell.z }, { x: this.core.cell.x - 1, z: this.core.cell.z },
      { x: this.core.cell.x, z: this.core.cell.z + 1 }, { x: this.core.cell.x, z: this.core.cell.z - 1 },
    ].filter((p) => this.isInsideGrid(p.x, p.z));
    const queue: GridPos[] = [startPos];
    const previous = new Map<string, string | null>();
    previous.set(startKey, null);
    let goalKey: string | null = null;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (queue.length) {
      const p = queue.shift()!;
      const key = floorKey(p.x, p.z);
      if (goals.some((g) => g.x === p.x && g.z === p.z)) { goalKey = key; break; }
      for (const [dx, dz] of dirs) {
        const nx = p.x + dx, nz = p.z + dz, nk = floorKey(nx, nz);
        if (!this.isInsideGrid(nx, nz) || previous.has(nk)) continue;
        const obstacle = this.getWallAt(nx, nz);
        if (obstacle && kind !== 'ladder') continue;
        previous.set(nk, key); queue.push({ x: nx, z: nz });
      }
    }
    if (!goalKey) { this.routeCache.set(cacheKey, []); return []; }
    const result: GridPos[] = [];
    let cursor: string | null = goalKey;
    while (cursor && cursor !== startKey) {
      const [x, z] = cursor.split(',').map(Number);
      result.unshift({ x, z });
      cursor = previous.get(cursor) ?? null;
    }
    this.routeCache.set(cacheKey, result);
    return result;
  }

  private attackBlockingStructure(enemy: Enemy, dt: number) {
    if (enemy.attackTimer > 0) return;
    const candidates = [...this.structures.values()].filter((item) => this.isMaterial(item.kind) && item.cell.y === 0 && Math.hypot(item.cell.x - enemy.x, item.cell.z - enemy.z) < 1.6);
    if (!candidates.length) return;
    const target = candidates.sort((a, b) => Math.hypot(a.cell.x - enemy.x, a.cell.z - enemy.z) - Math.hypot(b.cell.x - enemy.x, b.cell.z - enemy.z))[0];
    if (enemy.kind === 'grunt' && target.kind !== 'wood') { enemy.attackTimer = 0.5; return; }
    if (enemy.kind === 'bomber' && target.kind === 'steel') { enemy.attackTimer = 0.75; return; }
    if (enemy.kind === 'ladder') {
      enemy.ladderTimer += dt;
      if (enemy.ladderTimer > 1.8) { enemy.ladderTimer = 0; enemy.x = target.cell.x + Math.sign(this.core!.cell.x - target.cell.x); enemy.z = target.cell.z + Math.sign(this.core!.cell.z - target.cell.z); }
      return;
    }
    const damage = enemy.kind === 'bomber' ? TUNING.bombDamage : TUNING.gruntDamage;
    target.health -= damage;
    this.refreshStructureDamage(target);
    enemy.attackTimer = enemy.kind === 'bomber' ? TUNING.bombAttackSeconds : TUNING.gruntAttackSeconds;
    if (enemy.kind === 'bomber') this.applyBlast(target.cell, damage * 0.35);
    if (target.health <= 0) this.destroyStructure(target);
  }

  private approachBlockingStructure(enemy: Enemy, dt: number) {
    const blockers = [...this.structures.values()].filter((item) => this.isMaterial(item.kind) && item.cell.y === 0 && Math.hypot(item.cell.x - enemy.x, item.cell.z - enemy.z) < Math.hypot(this.core!.cell.x - enemy.x, this.core!.cell.z - enemy.z));
    if (!blockers.length) return;
    const target = blockers.sort((a, b) => Math.hypot(a.cell.x - enemy.x, a.cell.z - enemy.z) - Math.hypot(b.cell.x - enemy.x, b.cell.z - enemy.z))[0];
    const dx = target.cell.x - enemy.x, dz = target.cell.z - enemy.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 1.12) {
      enemy.x += dx / distance * TUNING.enemySpeed * dt;
      enemy.z += dz / distance * TUNING.enemySpeed * dt;
    } else {
      this.attackBlockingStructure(enemy, dt);
    }
  }

  private getWallAt(x: number, z: number) {
    const groundBlock = this.structures.get(structureKey(x, 0, z));
    return groundBlock && this.isMaterial(groundBlock.kind) ? groundBlock : undefined;
  }

  private isMaterial(kind: string): kind is MaterialKind {
    return kind === 'wood' || kind === 'stone' || kind === 'steel';
  }

  private applyBlast(cell: Cell, damage: number) {
    const affected = [...this.structures.values()].filter((item) => Math.hypot(item.cell.x - cell.x, item.cell.z - cell.z) <= 1.5 && item.kind !== 'throne' && item.kind !== 'steel');
    for (const item of affected) {
      if (this.structures.get(structureKey(item.cell.x, item.cell.y, item.cell.z)) !== item) continue;
      item.health -= damage;
      this.refreshStructureDamage(item);
      if (item.health <= 0) this.destroyStructure(item);
    }
  }

  private destroyStructure(item: Structure) {
    this.structures.delete(structureKey(item.cell.x, item.cell.y, item.cell.z));
    this.layoutVersion++;
    this.routeCache.clear();
    this.structureMeshes.delete(item.id);
    if (item.mesh) this.scene.remove(item.mesh);
    const fallen = this.dropUnsupportedStructures();
    this.showToast(fallen ? `${this.label(item.kind)} destroyed; ${fallen} unsupported ${fallen === 1 ? 'block fell' : 'blocks fell'}.` : `${this.label(item.kind)} destroyed.`);
  }

  private dropUnsupportedStructures() {
    const supported = new Set<string>();
    const queue: Cell[] = [];
    for (const item of this.structures.values()) {
      if (item.cell.y === 0) {
        const key = structureKey(item.cell.x, item.cell.y, item.cell.z);
        supported.add(key);
        queue.push(item.cell);
      }
    }

    const neighbors = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    while (queue.length) {
      const cell = queue.shift()!;
      for (const [dx, dy, dz] of neighbors) {
        const key = structureKey(cell.x + dx, cell.y + dy, cell.z + dz);
        if (supported.has(key)) continue;
        const neighbor = this.structures.get(key);
        if (!neighbor) continue;
        supported.add(key);
        queue.push(neighbor.cell);
      }
    }

    const unsupported = [...this.structures.values()].filter((item) => !supported.has(structureKey(item.cell.x, item.cell.y, item.cell.z)));
    for (const item of unsupported) {
      this.structures.delete(structureKey(item.cell.x, item.cell.y, item.cell.z));
      this.structureMeshes.delete(item.id);
      if (item.mesh) this.scene.remove(item.mesh);
      this.dropBlock(item);
    }
    this.rebuildMaterialBatches();
    if (unsupported.length) {
      this.layoutVersion++;
      this.routeCache.clear();
    }
    return unsupported.length;
  }

  private dropBlock(item: Structure) {
    if (item.mesh) this.scene.remove(item.mesh);
    this.structures.delete(structureKey(item.cell.x, item.cell.y, item.cell.z));
    this.structureMeshes.delete(item.id);
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(item.cell.x, item.cell.y + 0.5, item.cell.z).setLinvel(0, -1.5, 0));
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(0.45, 0.45, 0.45).setFriction(0.85), body);
    item.mesh = this.createStructureMesh(item);
    this.scene.add(item.mesh);
    this.debris.set(item.id, { structure: item, body, settleTime: 0 });
  }

  private updateTowers(dt: number) {
    for (const tower of this.structures.values()) {
      if (tower.kind !== 'single' && tower.kind !== 'splash') continue;
      const timer = Math.max(0, (this.towerTimers.get(tower.id) ?? 0) - dt);
      this.towerTimers.set(tower.id, timer);
      if (timer > 0) continue;
      const target = this.enemies
        .filter((enemy) => Math.hypot(enemy.x - tower.cell.x, enemy.z - tower.cell.z) <= TUNING.towerRange && this.hasLineOfSight(tower, enemy))
        .sort((a, b) => Math.hypot(a.x - tower.cell.x, a.z - tower.cell.z) - Math.hypot(b.x - tower.cell.x, b.z - tower.cell.z))[0];
      if (!target) continue;
      const splash = tower.kind === 'splash';
      const start = new THREE.Vector3(tower.cell.x, tower.cell.y + 0.8, tower.cell.z);
      const end = new THREE.Vector3(target.x, 0.3, target.z);
      const bolt = new THREE.Mesh(new THREE.SphereGeometry(splash ? 0.15 : 0.09, 8, 8), new THREE.MeshBasicMaterial({ color: splash ? 0x9bbdff : 0x6ca3ff }));
      bolt.position.copy(start); this.scene.add(bolt);
      this.projectiles.push({ mesh: bolt, from: start, to: end, life: 0.22, maxLife: 0.22, damage: splash ? TUNING.splashDamage : TUNING.singleDamage, targetId: target.id, splash });
      this.towerTimers.set(tower.id, splash ? TUNING.splashFireSeconds : TUNING.singleFireSeconds);
    }
  }

  private hasLineOfSight(tower: Structure, enemy: Enemy) {
    const startX = tower.cell.x;
    const startZ = tower.cell.z;
    const dx = enemy.x - startX;
    const dz = enemy.z - startZ;
    const distance = Math.hypot(dx, dz);
    const samples = Math.ceil(distance * 4);
    const startY = tower.cell.y + 0.8;
    const endY = enemy.height + 0.3;

    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      const x = Math.round(startX + dx * t);
      const z = Math.round(startZ + dz * t);
      if (x === tower.cell.x && z === tower.cell.z) continue;
      const rayY = startY + (endY - startY) * t;
      for (const y of [Math.floor(rayY), Math.floor(rayY) - 1]) {
        if (y < 0 || y >= 32) continue;
        const blocker = this.structures.get(structureKey(x, y, z));
        if (blocker && rayY > y + 0.02 && rayY < y + 0.98) return false;
      }
    }
    return true;
  }

  private updateProjectiles(dt: number) {
    for (const shot of [...this.projectiles]) {
      shot.life -= dt;
      const t = 1 - Math.max(0, shot.life) / shot.maxLife;
      shot.mesh.position.lerpVectors(shot.from, shot.to, t);
      if (shot.life <= 0) {
        const target = this.enemies.find((enemy) => enemy.id === shot.targetId);
        if (shot.splash) {
          for (const enemy of [...this.enemies]) if (Math.hypot(enemy.x - shot.to.x, enemy.z - shot.to.z) <= TUNING.splashRadius) this.damageEnemy(enemy, shot.damage);
        } else if (target) this.damageEnemy(target, shot.damage);
        this.scene.remove(shot.mesh);
        this.projectiles.splice(this.projectiles.indexOf(shot), 1);
      }
    }
  }

  private damageEnemy(enemy: Enemy, damage: number) {
    enemy.health -= damage;
    if (enemy.health > 0) return;
    const mesh = this.enemyMeshes.get(enemy.id);
    if (mesh) this.scene.remove(mesh);
    this.enemyMeshes.delete(enemy.id);
    this.enemies.splice(this.enemies.indexOf(enemy), 1);
    this.gold += enemy.kind === 'bomber' ? TUNING.goldPerBomber : enemy.kind === 'ladder' ? TUNING.goldPerLadderSquad : TUNING.goldPerGrunt;
    this.syncUi();
  }

  private updateDebris(dt: number) {
    if (!this.debris.size) return;
    this.physics.timestep = dt;
    this.physics.step();
    for (const [id, item] of [...this.debris]) {
      const pos = item.body.translation();
      const rot = item.body.rotation();
      if (item.structure.mesh) {
        item.structure.mesh.position.set(pos.x, pos.y, pos.z);
        item.structure.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      }
      const isSettled = pos.y <= 0.51 && Math.abs(item.body.linvel().y) < 0.32;
      item.settleTime = isSettled ? item.settleTime + dt : 0;
      if (item.settleTime < TUNING.rubbleSettledSeconds) continue;
      const x = clamp(Math.round(pos.x), -GRID_HALF + 1, GRID_HALF - 1);
      const z = clamp(Math.round(pos.z), -GRID_HALF + 1, GRID_HALF - 1);
      let y = 0;
      while (this.structures.has(structureKey(x, y, z))) y++;
      const occupied = this.structures.get(structureKey(x, y, z));
      if (occupied) continue;
      item.structure.cell = { x, y, z };
      item.structure.rubble = true;
      item.structure.mesh = item.structure.mesh ?? this.createStructureMesh(item.structure);
      item.structure.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      item.structure.mesh.position.set(x, y + 0.5, z);
      this.structures.set(structureKey(x, y, z), item.structure);
      if (this.isMaterial(item.structure.kind)) {
        this.scene.remove(item.structure.mesh);
        item.structure.mesh = undefined;
        this.rebuildMaterialBatches();
      } else {
        this.scene.add(item.structure.mesh);
        this.structureMeshes.set(id, item.structure.mesh);
      }
      this.layoutVersion++;
      this.routeCache.clear();
      this.physics.removeRigidBody(item.body);
      this.debris.delete(id);
      this.syncUi();
    }
  }

  private showDefeat() {
    this.phase = 'defeat';
    document.querySelector('#final-wave')!.textContent = `Wave ${String(this.wave).padStart(2, '0')} reached`;
    this.ui.overlay!.style.display = 'grid';
    this.syncUi();
    this.saveCheckpoint();
  }

  private syncUi() {
    if (this.ui.gold) this.ui.gold.textContent = String(this.gold);
    if (this.ui.wave) this.ui.wave.textContent = String(this.wave).padStart(2, '0');
    if (this.ui.health) this.ui.health.textContent = `${Math.max(0, this.coreHealth)}%`;
    if (this.ui.phase) this.ui.phase.textContent = this.phase === 'place-throne' ? 'Place the throne' : this.phase === 'build' ? 'Build defenses' : this.phase === 'wave' ? 'Wave in progress' : 'Run over';
    const dot = document.querySelector('.status-dot');
    dot?.classList.toggle('wave', this.phase === 'wave');
    const caption = this.ui.hint;
    if (caption) caption.textContent = this.phase === 'place-throne' ? 'Place your throne anywhere on the grid to begin.' : this.phase === 'build' ? 'Build, place towers, or move fallen blocks before the next wave.' : this.phase === 'wave' ? `Enemies are approaching from the void. ${this.enemies.length + this.spawnRemaining} remain.` : 'The throne was reached.';
    if (this.ui.start) {
      this.ui.start.textContent = this.phase === 'place-throne' ? 'Place throne' : this.phase === 'build' ? `Start wave ${String(this.wave).padStart(2, '0')}` : 'Wave active';
      this.ui.start.disabled = this.phase !== 'build';
    }
    const waveLabel = document.querySelector('#wave-label');
    if (waveLabel) waveLabel.textContent = `Wave ${String(this.wave).padStart(2, '0')}`;
    if (this.ui.rubble) this.ui.rubble.textContent = this.selectedRubble ? `Selected ${this.label(this.selectedRubble.kind)} rubble � click a free cell to move (${TUNING.rubbleMoveCost} G)` : 'Click a fallen block to move it for a reduced cost.';
    if (this.ui.panel) {
      this.ui.panel.style.opacity = this.phase === 'build' ? '1' : this.phase === 'place-throne' ? '0.55' : '0.35';
      this.ui.panel.style.pointerEvents = this.phase === 'build' ? 'auto' : 'none';
    }
    if (this.preview) this.preview.visible = this.phase === 'build' || this.phase === 'place-throne';
  }

  private label(kind: string) { return kind.charAt(0).toUpperCase() + kind.slice(1); }

  private showToast(message: string) {
    if (!this.ui.toast) return;
    this.ui.toast.textContent = message;
    this.ui.toast.classList.add('show');
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.ui.toast?.classList.remove('show'), 1900);
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    const now = performance.now();
    const frameDelta = Math.min((now - this.lastFrame) / 1000, MAX_FRAME_DELTA);
    this.lastFrame = now;
    this.elapsed += frameDelta;
    const fogMaterial = (this as unknown as { fogMaterial?: THREE.ShaderMaterial }).fogMaterial;
    if (fogMaterial) fogMaterial.uniforms.time.value = this.elapsed;
    this.controls.update();
    this.simulationAccumulator += frameDelta;
    while (this.simulationAccumulator >= SIMULATION_STEP) {
      if (this.phase === 'wave') {
        this.updateWave(SIMULATION_STEP);
        this.updateTowers(SIMULATION_STEP);
        this.updateProjectiles(SIMULATION_STEP);
      }
      this.updateDebris(SIMULATION_STEP);
      this.simulationAccumulator -= SIMULATION_STEP;
    }
    const interpolation = this.simulationAccumulator / SIMULATION_STEP;
    for (const enemy of this.enemies) {
      const mesh = this.enemyMeshes.get(enemy.id);
      if (!mesh) continue;
      mesh.position.set(
        enemy.previousX + (enemy.x - enemy.previousX) * interpolation,
        enemy.previousHeight + (enemy.height - enemy.previousHeight) * interpolation,
        enemy.previousZ + (enemy.z - enemy.previousZ) * interpolation,
      );
    }
    this.renderer.render(this.scene, this.camera);
  };
}

const game = new VoxelSiege();
game.start().catch((error) => {
  console.error(error);
  app!.innerHTML = `<div style="padding:32px;color:#eee;font:14px system-ui">Unable to initialize the 3D simulation. Check the browser console for details.</div>`;
});

