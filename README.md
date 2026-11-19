# Voxel Siege

Desktop-browser voxel castle defense prototype.

## Start locally

```sh
npm install
npm run dev
```

Runs use a displayed seed for reproducible enemy mixes and spawn positions. To replay a run during development, open the app with a numeric seed, for example `http://localhost:5173/?seed=12345`.

The first run begins with **100 gold** and asks the player to place the throne/core on the grid. During the build phase, place wood, stone, steel, or one of the two tower types. Start the wave to defend against enemies arriving from the surrounding void. Fallen blocks can be selected and moved for a reduced gold cost.

## Prototype controls

- Left click: place a selected piece or select/move rubble.
- Drag: orbit the camera.
- Right drag: pan the camera.
- Mouse wheel: zoom.
- Escape: cancel rubble selection.

## Tuning

Prototype costs, durability, enemy behavior, wave counts, damage, and timing are centralized in `src/config.ts`. They are deliberately provisional playtest values.

## Current scope

- Desktop browser first; input and layout are kept separate from game rules for future mobile support.
- Local single-player run; no server or account.
- Run state is saved locally in IndexedDB at safe phase boundaries and restored after reload.
- One grid, one core, three construction materials, splash and single-target towers.
- Red grunt, ladder squad, and bomber enemies.
- Structural grid state is authoritative; Rapier handles falling-block motion.
- Upgrades and player-editable game data are outside the first slice.

## Prototype limits

Grid size, enemy routing, health, prices, wave composition, and combat timings are initial implementation values. Adjust them in `src/config.ts` during playtesting; they are not intended as final balance.

