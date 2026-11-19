export type MaterialKind = 'wood' | 'stone' | 'steel';
export type TowerKind = 'single' | 'splash';
export type PlaceKind = MaterialKind | TowerKind | 'throne';
export type EnemyKind = 'grunt' | 'ladder' | 'bomber';

export interface GridPos {
  x: number;
  z: number;
}

export interface Cell extends GridPos {
  y: number;
}

export interface Structure {
  id: number;
  kind: MaterialKind | TowerKind | 'throne';
  cell: Cell;
  health: number;
  maxHealth: number;
  rubble: boolean;
  mesh?: import('three').Object3D;
}

export interface Enemy {
  id: number;
  kind: EnemyKind;
  x: number;
  z: number;
  height: number;
  previousX: number;
  previousZ: number;
  previousHeight: number;
  health: number;
  maxHealth: number;
  attackTimer: number;
  ladderTimer: number;
  path: GridPos[];
  pathIndex: number;
}

export type Phase = 'place-throne' | 'build' | 'wave' | 'defeat';

