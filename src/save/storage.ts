import { GRID_HALF } from '../config';
import type { Cell, Phase, Structure } from '../types';

export type SavedStructure = Pick<Structure, 'id' | 'kind' | 'cell' | 'health' | 'maxHealth' | 'rubble'>;
export type SafePhase = Exclude<Phase, 'wave'>;

export interface SavedRun {
  schemaVersion: 1;
  seed: number;
  phase: SafePhase;
  gold: number;
  wave: number;
  coreHealth: number;
  structures: SavedStructure[];
  settings: Record<string, never>;
}

const DATABASE_NAME = 'voxel-siege';
const DATABASE_VERSION = 1;
const STORE_NAME = 'runs';
const CURRENT_RUN_KEY = 'current';

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is unavailable'));
  if (databasePromise) return databasePromise;

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open the local save database'));
    request.onblocked = () => reject(new Error('The local save database is blocked by another tab'));
  }).catch((error) => {
    databasePromise = undefined;
    throw error;
  });

  return databasePromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafePhase(value: unknown): value is SafePhase {
  return value === 'place-throne' || value === 'build' || value === 'defeat';
}

function isStructureKind(value: unknown): value is SavedStructure['kind'] {
  return value === 'wood' || value === 'stone' || value === 'steel'
    || value === 'single' || value === 'splash' || value === 'throne';
}

function readCell(value: unknown): Cell | null {
  if (!isRecord(value) || !Number.isInteger(value.x) || !Number.isInteger(value.y) || !Number.isInteger(value.z)) return null;
  const x = value.x as number;
  const y = value.y as number;
  const z = value.z as number;
  if (x <= -GRID_HALF || x >= GRID_HALF || z <= -GRID_HALF || z >= GRID_HALF || y < 0 || y >= 32) return null;
  return { x, y, z };
}

function readStructures(value: unknown): SavedStructure[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<number>();
  const cells = new Set<string>();
  const structures: SavedStructure[] = [];

  for (const entry of value) {
    if (!isRecord(entry) || !Number.isInteger(entry.id) || (entry.id as number) < 1 || !isStructureKind(entry.kind)) return null;
    const cell = readCell(entry.cell);
    if (!cell || !isFiniteNumber(entry.health) || !isFiniteNumber(entry.maxHealth) || entry.maxHealth <= 0) return null;
    if (entry.health < 0 || entry.health > entry.maxHealth || typeof (entry.rubble ?? false) !== 'boolean') return null;
    const key = `${cell.x},${cell.y},${cell.z}`;
    if (ids.has(entry.id as number) || cells.has(key)) return null;
    ids.add(entry.id as number);
    cells.add(key);
    structures.push({
      id: entry.id as number,
      kind: entry.kind,
      cell,
      health: entry.health,
      maxHealth: entry.maxHealth,
      rubble: (entry.rubble ?? false) as boolean,
    });
  }

  return structures;
}

function validateCurrentVersion(value: Record<string, unknown>): SavedRun | null {
  if (value.schemaVersion !== 1 || !Number.isInteger(value.seed) || !isSafePhase(value.phase)) return null;
  if (!isFiniteNumber(value.gold) || value.gold < 0 || !Number.isInteger(value.wave) || (value.wave as number) < 1) return null;
  if (!isFiniteNumber(value.coreHealth) || value.coreHealth < 0 || value.coreHealth > 100) return null;
  const structures = readStructures(value.structures);
  if (!structures) return null;
  const cores = structures.filter((item) => item.kind === 'throne');
  if ((value.phase === 'build' || value.phase === 'defeat') && cores.length !== 1) return null;
  if ((value.phase === 'place-throne' && cores.length !== 0) || cores.length > 1) return null;
  if ((value.phase === 'defeat' && value.coreHealth !== 0) || (value.phase !== 'defeat' && value.coreHealth === 0)) return null;

  return {
    schemaVersion: 1,
    seed: (value.seed as number) >>> 0,
    phase: value.phase,
    gold: value.gold,
    wave: value.wave as number,
    coreHealth: value.coreHealth,
    structures,
    settings: {},
  };
}

function migrateSavedRun(value: unknown): SavedRun | null {
  if (!isRecord(value)) return null;
  const version = value.schemaVersion ?? 0;
  if (version === 0) {
    const oldStructures = Array.isArray(value.structures)
      ? value.structures.map((item) => isRecord(item) ? { ...item, rubble: item.rubble ?? false } : item)
      : value.structures;
    return validateCurrentVersion({ ...value, schemaVersion: 1, structures: oldStructures });
  }
  if (version === 1) return validateCurrentVersion(value);
  return null;
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Local save transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local save transaction was aborted'));
  });
}

export async function loadSavedRun(): Promise<SavedRun | null> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const request = transaction.objectStore(STORE_NAME).get(CURRENT_RUN_KEY);
  const [record] = await Promise.all([
    new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not read the local save'));
    }),
    transactionDone(transaction),
  ]);
  const migrated = migrateSavedRun(record);
  if (migrated && (!isRecord(record) || record.schemaVersion !== migrated.schemaVersion)) await saveRun(migrated);
  return migrated;
}

export async function saveRun(run: SavedRun): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put(run, CURRENT_RUN_KEY);
  await transactionDone(transaction);
}

