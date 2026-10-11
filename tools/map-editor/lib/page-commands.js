// The commands the open editor page answers besides the editing commands in
// commands.js: opening and saving, the camera and screenshots, searching the
// client, baking. Plain data, so the CLI can list them (and offer them as MCP
// tools) without a page; ui/remote.js runs them.
//
// args: { name: [type, description, optional] }, as in commands.js.

export const PAGE_COMMANDS = {
	help: { describe: 'Every command, with its arguments.', args: {} },
	status: { describe: 'What is open: map, mod, size, unsaved changes, the tool, the selection, the camera, recent undo steps.', args: {} },
	'map.open': { describe: 'Open a map: one in a mod (mod + map), or any map in the client (map), optionally as a new map under another name (as) saved into mod. Without as, saving an official map into a mod overrides it. Refuses while there are unsaved changes unless discard.', args: { map: ['string', 'Map name, e.g. prontera'], mod: ['string', 'The mod it lives in or will be saved into', true], as: ['string', 'Save it as a new map with this name', true], discard: ['boolean', 'Throw away unsaved changes to the open map', true] } },
	'map.new': { describe: 'Make a new flat map in a mod: name (11 characters at most), width and height in cells, and a ground texture path. Refuses while there are unsaved changes unless discard.', args: { name: ['string', 'Map name'], mod: ['string', 'Mod folder to save into (made if new)'], width: ['number', 'Cells (default 80)', true], height: ['number', 'Cells (default 80)', true], texture: ['string', 'Ground texture under data/texture/, e.g. 필드바닥\\prt_초원01.bmp (textures.search finds more)', true], discard: ['boolean', 'Throw away unsaved changes to the open map', true] } },
	'map.save': { describe: 'Save the map into its mod: geometry, minimap, npc/ script, dialogue templates, signboards, population, mod.json. Returns the files written. mod puts it in (or moves it to) that mod; an official map saved under its own name needs override.', args: { mod: ['string', 'Mod folder (needed the first time for a map opened from the client)', true], override: ['boolean', 'Save an official map under its own name, replacing it for anyone with the mod on', true] } },
	'map.check': { describe: 'Check the map for problems: missing files, warps into walls, unreachable cells, bad names. quick skips the file checks.', args: { quick: ['boolean', 'Skip checking files exist', true] } },
	'map.test': { describe: 'Save, switch the mod on, restart the server and move a character onto the map at x,y (the test start point by default). Only in the app.', args: { x: ['number', 'Cell x', true], y: ['number', 'Cell y', true], char: ['string', 'Character id (default: the one used last)', true] } },
	'map.set_start': { describe: 'Where Test in game puts the character.', args: { x: ['number', 'x'], y: ['number', 'y'] } },
	undo: { describe: 'Undo the last change (a person\'s or an agent\'s).', args: {} },
	redo: { describe: 'Redo.', args: {} },
	'view.camera': { describe: 'Move the camera: look at x,y from distance (cells), turned yaw degrees (0 = looking north), tilted pitch degrees (90 = straight down); top for a plan view, fit for the whole map.', args: { x: ['number', 'Look at x', true], y: ['number', 'Look at y', true], distance: ['number', 'Distance in cells', true], yaw: ['number', 'Degrees', true], pitch: ['number', '10..90', true], top: ['boolean', 'Straight down', true], fit: ['boolean', 'The whole map', true] } },
	'view.show': { describe: 'Show or hide layers: models, water, gat (walkability), grid, markers, lightmap.', args: { models: ['boolean', '', true], water: ['boolean', '', true], gat: ['boolean', 'Walkability overlay', true], grid: ['boolean', 'Cell grid', true], markers: ['boolean', 'NPCs, warps, spawns, icons', true], lightmap: ['boolean', 'Baked lighting', true] } },
	'view.tool': { describe: 'Switch the tool a person sees: select, sculpt, paint, walk, objects, gameplay, map, check.', args: { tool: ['string', 'Tool'] } },
	'view.select': { describe: 'Select objects (indexes) and markers (npc:<id>, warp:<id>, spawn:<id>) so a person sees them highlighted; focus frames them.', args: { keys: ['string', 'Comma separated'], focus: ['boolean', 'Frame them', true] } },
	'view.screenshot': { describe: 'A PNG of the view (with marker labels unless labels is false), at width x height pixels if given. Set the camera first with view.camera.', args: { width: ['number', 'Pixels', true], height: ['number', 'Pixels', true], labels: ['boolean', 'Draw names over markers (default true)', true], wait: ['number', 'Milliseconds to let textures arrive (default 150)', true] } },
	'view.minimap': { describe: 'The minimap that saving would write, as a PNG.', args: {} },
	'lightmap.bake': { describe: 'Bake the lightmaps: shadows from models and hills, colour from point lights. samples 4 for soft shadows.', args: { shadows: ['boolean', 'Default true', true], lights: ['boolean', 'Default true', true], samples: ['number', '1..8 (default 1)', true] } },
	'projects.list': { describe: 'The mods in the mods folder and the maps in each.', args: {} },
	'maps.search': { describe: 'Maps in the client and the mods, by file name or display name.', args: { query: ['string', 'Search', true], limit: ['number', 'Default 50', true] } },
	'models.search': { describe: 'Models in the client (paths under data/model/ for model.add).', args: { query: ['string', 'Part of the path, e.g. 프론테라 or tree', true], limit: ['number', 'Default 50', true] } },
	'textures.search': { describe: 'Textures in the client (paths under data/texture/ for texture.paint).', args: { query: ['string', 'Search', true], limit: ['number', 'Default 50', true] } },
	'sounds.search': { describe: 'Sounds in the client (paths under data/wav/ for sound.add).', args: { query: ['string', 'Search', true], limit: ['number', 'Default 50', true] } },
	'mobs.search': { describe: 'Monsters on this server: id, AegisName, name, level.', args: { query: ['string', 'Search', true], limit: ['number', 'Default 30', true] } },
	'items.search': { describe: 'Items on this server, for shops.', args: { query: ['string', 'Search', true], limit: ['number', 'Default 30', true] } },
	'npcs.search': { describe: 'NPC sprite names the client has, for npc.add sprite.', args: { query: ['string', 'Search', true], limit: ['number', 'Default 50', true] } },
	'bgm.list': { describe: 'Music tracks and the official maps that play each.', args: { query: ['string', 'Search', true], limit: ['number', 'Default 100', true] } },
	'prefab.list': { describe: 'Saved prefabs (groups of objects).', args: {} },
	'prefab.save': { describe: 'Save objects as a named prefab, for any map.', args: { name: ['string', 'Name'], indexes: ['string', 'Object indexes'] } },
	'prefab.place': { describe: 'Place a prefab centred on x,y.', args: { name: ['string', 'Name'], x: ['number', 'x'], y: ['number', 'y'], rotation: ['number', 'Degrees', true] } },
	'dialogue.open': { describe: 'Open the map\'s dialogue file (npc/<map>_dialogue.txt) in the person\'s text editor. In the app only.', args: { fn: ['string', 'Function to look for', true] } },
	'textures.used': { describe: 'The ground textures the map uses, by index.', args: {} },
};
