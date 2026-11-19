# Voxel Siege - Game and Technical Plan

## 1. Project summary

Build a single-player, desktop-browser roguelike defense game. The player places a one-block throne/core on a 3D grid, then builds a voxel castle and places weapons around it. Enemy groups emerge from the fog beyond the build area and try to reach the core. Between waves, the player spends earned gold on construction, towers, and moving fallen blocks into useful positions. The run ends when the core is destroyed; the player can then begin a fresh run.

The player customizes the castle's shape and weapon placement. They do not edit game data, enemy stats, or balance values. The game should remain easy to tune during development through centralized configuration, without exposing those values as a player-facing editor.

## 2. Agreed design

### Camera, arena, and art direction

- Desktop browser is the initial target. Mobile play is not in the first release, but coordinate systems, input handling, and interface layout should avoid assumptions that would force a major rewrite later.
- Use a rotating isometric 3D camera with orbit, pan, and zoom.
- The battlefield is flat ground in a void-like setting. A clear square grid marks the build area; fog stays outside that area and acts as the enemy entry space.
- Enemies may emerge from any side of the arena, from the surrounding fog.
- Keep the world and castle voxel-based and atmospheric: desaturated grayscale construction, blue tower accents, red cube-based enemies, and hazy fog beyond the grid.
- The throne/core is one block and may be placed anywhere on the grid.

### Construction

- Build the castle from individual grid blocks. Players can shape the layout and stack blocks vertically.
- The initial structural materials are wood, stone, and steel.
- Material strength is intentionally asymmetric:
  - Grunts can damage wood, but cannot break stone or steel.
  - Bombs can damage wood and stone; steel is impenetrable to bombs.
  - Ladder squads can scale walls.
- Towers are placed as grid pieces. The first set contains a single-target tower and a splash-damage tower.
- Towers target enemies automatically. Combat is mostly observed rather than directly controlled.
- Fallen wall pieces remain individual blocks. In the build phase, the player can select and move rubble blocks for less gold than buying a new block.

### Enemies

- **Grunts:** Run toward the throne/core. When a wood wall blocks their route, they punch it repeatedly; breaking a wall takes a long time. They cannot break stone or steel.
- **Ladder squad:** Four grunts carry a ladder, approach a wall, place the ladder, and climb across. They are a route-over defense answer rather than a wall-breaking unit.
- **Bomb squad:** Attack a wall with high structural damage. A breach can collapse supported blocks and open a path for following troops. Steel cannot be breached by their bombs.

The first wave should be simple and readable. Additional enemy behavior, wave mixes, and escalation remain configurable tuning work rather than player-editable game data.

### Run loop and economy

1. Place the throne/core on the grid.
2. Use the build phase to purchase and place material blocks and towers.
3. Start a wave. Enemies enter from the fog and pursue the core while towers fire automatically.
4. Resolve damage, breaches, collapses, and enemy defeats. Award gold for defeated enemies.
5. Return to the build phase. Reposition rubble blocks at a reduced cost, buy new pieces, and prepare for the next wave.
6. When the throne/core is destroyed, end the run and offer a fresh run.

- Initial starting budget: **100 gold**.
- Gold is earned through enemy defeats; any additional between-wave award is a provisional balance setting.
- Material and tower prices, durability, enemy health, attack rates, wave counts, and reward values must be centralized and clearly labeled as provisional.
- Upgrades are a later feature and are excluded from the first playable slice.
- A new run starts with a fresh arena and the starting gold amount.

## 3. Technical architecture

### Runtime and libraries

- **Vite** builds the browser application as static assets.
- **TypeScript** holds game rules, state models, input actions, and tuning definitions.
- **Three.js** renders the 3D scene using WebGL 2.
- **Rapier 3D** provides physics for falling and settling debris. The grid model, not the physics world, remains authoritative for intact castle pieces.
- The current prototype uses native DOM/CSS for the HUD and menus. Keep the interface separate from the Three.js canvas; a UI framework can be added only if the interface complexity justifies it.
- No server, user account, multiplayer service, or backend is required for the single-player game.

### State and simulation

- Represent grid cells in logical integer coordinates independent of pixels and viewport size.
- Keep a keyed structure map for blocks, towers, throne, and rubble. Each structure tracks identity, kind, cell, durability, and whether it is salvageable rubble.
- Keep enemy state separate from rendering objects: kind, position, health, attack/cooldown state, and path.
- Use explicit game phases: throne placement, build, active wave, and defeat.
- Run game logic on a fixed simulation step. Render frames independently and interpolate where needed.
- Use a seeded random source for each run so wave generation can be reproduced when debugging or saving.
- Keep input translated into actions such as select, place, move rubble, orbit, pan, zoom, and start wave. Keyboard/mouse is the first input adapter; touch input can be added later.

### Navigation, damage, and physics

- Use grid-based pathfinding toward the core. Recalculate routes when the build changes or a wall is destroyed, and cache routes for unchanged layouts.
- Grunts treat blocked routes as obstacles and attack breakable wood. Ladder squads traverse climbable walls. Bomb squads damage wood and stone, but not steel.
- Treat tower targeting, line of sight, and damage as data-driven systems so the initial two tower types can be tuned without changing the wave loop.
- Render intact blocks in batches rather than creating heavyweight independent render objects for every voxel.
- Check structural support when a block is removed. Unsupported groups detach into dynamic physics objects. Once settled, convert debris back into individual grid rubble blocks that can be selected and moved.
- Keep active physics limited to falling or recently moved pieces. Do not run rigid-body physics on every intact voxel.

### Persistence and deployment

- Add versioned local save data in IndexedDB for the current run, settings, castle, rubble, gold, and wave.
- Save at safe phase boundaries and support schema migration when the save structure changes.
- Ship as static browser assets. Hosting provider selection is deferred; it should not affect game rules or save data.
- Run state is stored in versioned IndexedDB records at safe phase boundaries and restored after reload.

## 4. Project organization

Keep game systems separated so balance and interaction work do not become tangled with rendering:

```text
src/
  config.ts          # provisional balance values and arena constants
  types.ts           # domain types for cells, structures, enemies, and phases
  game/              # state, phase flow, economy, wave rules
  build/             # grid placement, validation, material definitions
  enemies/           # grunt, ladder, bomber behavior and pathfinding
  combat/            # tower targeting, shots, damage, rewards
  structures/        # support checks, collapse, rubble conversion
  physics/           # Rapier world and dynamic debris lifecycle
  render/            # Three.js scene, voxel meshes, camera, effects
  ui/                 # DOM interface and input action bindings
  save/               # versioned IndexedDB run checkpoints
```

The current branch is an early prototype and keeps most runtime behavior in `src/main.ts`. Split modules as each system becomes stable; avoid premature abstraction that slows the first playable loop.

## 5. Development milestones

### Milestone 1 - Browser foundation

- Vite/TypeScript entry point, full-window 3D canvas, resize handling, camera, lighting, ground, and clear grid.
- Grayscale void scene with a hazy fog band outside the build area.
- Desktop keyboard/mouse action layer, kept independent from simulation rules.

### Milestone 2 - Core and construction

- Place the throne/core anywhere on the grid.
- Select, preview, and place wood, stone, steel, and the two tower types.
- Enforce grid occupancy, stacking support, and purchase costs.
- Show gold, phase, wave, and core integrity.

### Milestone 3 - Enemies and waves

- Spawn from all sides in the fog.
- Implement grunt, ladder-squad, and bomb-squad behavior.
- Add automatic single-target and splash tower attacks.
- Award provisional gold and transition cleanly between build and combat phases.

### Milestone 4 - Destruction and rubble

- Apply material-specific damage rules.
- Detect unsupported structures and create falling physics blocks.
- Persist settled blocks as individually movable rubble at a lower cost.
- Confirm breaches and rubble affect future enemy routes.

### Milestone 5 - Run persistence

- Add IndexedDB save/load with versioning.
- Preserve the current run across reloads and reset correctly for a new run.

### Milestone 6 - Balance and polish

- Tune economy, block durability, enemy mix, attack rates, and wave escalation in the configuration layer.
- Improve feedback for placement, damage, route changes, tower targeting, and collapse.
- Profile larger castles and concurrent enemies. Establish a desktop hardware/browser baseline before setting a formal performance target.
- Add upgrades only after the base loop is stable and the upgrade design is approved.

## 6. First playable slice

The first playable slice should allow a player to:

- place the core and build a simple defense with 100 starting gold;
- use the three materials and both initial tower types;
- start a wave with enemies approaching from the surrounding fog;
- see automatic towers attack and enemies interact with walls according to their type;
- see damaged walls breach or collapse and fallen blocks settle as rubble;
- move rubble during the next build phase for a reduced cost;
- continue into another wave or reach defeat and start a fresh run.

## 7. Provisional values and explicit limits

- The prototype currently uses a **28 x 28** grid. This is a provisional arena size, not a locked design.
- All numeric values in `src/config.ts` are initial playtest settings, not final balance.
- Collapse checks face-adjacent support paths from the ground and drops unsupported connected groups; material-specific support rules remain a refinement.
- Upgrade progression, save/load, broad environment customization, additional towers, and player-editable rule data are outside the first playable slice.
- The first release targets desktop browsers. It is not tuned for mobile play, but future mobile work should be limited mainly to input mappings, layout, and performance profiles rather than changes to core simulation data.

