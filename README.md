# Fog Hex Editor

A Foundry VTT module (v13–v14) for fixing explored fog of war one grid cell at a time. If a hex on your map was revealed by mistake, click it to hide it again. No need to reset the whole scene's fog and have everyone rediscover it.

## Features

- **Hide** or **Reveal** tool: click a hex (or square) or drag across several
- Hold **Alt** to do the opposite of the selected tool
- Works on players' real saved fog (Foundry's own fog exploration), not a separate fog layer
- Choose whose fog to edit: everyone, GM included (default), or only specific users
- GM preview: while the tool is active, areas the chosen players have **not** explored are tinted, so you can see exactly what they have revealed
- Undo (button or Ctrl+Z), up to 50 steps per session
- Safe with players online: their client saves its pending fog and pauses fog saves while the edit is made, then reloads the fixed fog straight away
- v14 levels: edits apply to the level you are currently viewing
- Revealing a cell for a player who has never explored the scene creates their fog for them

## Install

In Foundry: **Add-on Modules → Install Module**, paste this manifest URL:

```
https://github.com/PsyK2812/foundry-fog-hex-editor/releases/latest/download/module.json
```

## Usage

1. As GM, open the scene and click the **Fog Hex Editor** button in the left toolbar.
2. Optional: use the **users** button to limit which users' fog is edited (everyone, GM included, by default).
3. Pick **Hide** or **Reveal**, then click or drag over cells.

Settings (Configure Settings → Fog Hex Editor): edge padding, preview darkness, preview color.

### Macro API

```js
const api = game.modules.get("fog-hex-editor").api;
await api.hide([{ i: 4, j: 7 }]);              // hide one cell for the configured users
await api.reveal([{ i: 4, j: 7 }], [game.users.getName("Alice")]);
await api.undo();
```

Cell coordinates are grid offsets as given by `canvas.grid.getOffset({x, y})`.

## Notes

- The scene needs a hex or square grid and Fog Exploration turned on.
- Painted cells are grown by 1 fog pixel by default, so no thin revealed rim is left along the edge. Set **Edge padding** to 0 for exact outlines.

## License

MIT
