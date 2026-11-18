/**
 * TUNING VALUES - intentionally centralized for playtest adjustments.
 * These are prototype placeholders, not final balance decisions.
 */
export const TUNING = {
  gridWidth: 28,
  startingGold: 100,
  goldPerGrunt: 3,
  goldPerLadderSquad: 8,
  goldPerBomber: 10,
  spawnIntervalSeconds: 1.25,
  waveEnemyCountBase: 8,
  waveEnemyGrowth: 3,
  enemySpeed: 1.9,
  enemyHealth: 18,
  gruntDamage: 3,
  gruntAttackSeconds: 1.15,
  bombDamage: 42,
  bombAttackSeconds: 2.6,
  towerRange: 8,
  singleDamage: 10,
  singleFireSeconds: 0.75,
  splashDamage: 6,
  splashRadius: 2.5,
  splashFireSeconds: 1.8,
  rubbleMoveCost: 1,
  rubbleSettledSeconds: 0.65,
  blockCosts: { wood: 2, stone: 4, steel: 7 },
  blockHealth: { wood: 20, stone: 70, steel: 130 },
  towerCosts: { single: 18, splash: 24 },
  waveGoldBonus: 14,
} as const;

export const GRID_HALF = Math.floor(TUNING.gridWidth / 2);

