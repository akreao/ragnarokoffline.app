// Checks before a map goes into a mod: the mistakes that otherwise show up
// as a map that silently does not load, a warp that drops you in a wall, or
// a white ground.
//
// Each problem is { level: 'error' | 'warning' | 'note', code, message, at? }.
// Errors stop Test in game; warnings and notes are shown.

import { decodeName } from './cp949.js';
import { cellKind } from './gat.js';
import { lightmapProblems } from './lightmap.js';
import { MAX_NAME } from './map.js';

const walkable = (doc, x, y) => x >= 0 && y >= 0 && x < doc.gat.width && y < doc.gat.height && cellKind(doc.gat.types[y * doc.gat.width + x]).walk;

/** Walkable cells reachable from `starts`, flood-filled the way a player walks (8 directions). */
export function reachable(doc, starts) {
	const { width, height } = doc.gat;
	const seen = new Uint8Array(width * height);
	const stack = [];
	// A start on a blocked cell (an NPC's, a landing a little off) begins at the nearest walkable one.
	const nearest = (x, y) => {
		for (let r = 0; r <= 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (walkable(doc, x + dx, y + dy)) return [x + dx, y + dy];
		return null;
	};
	for (const [sx, sy] of starts) {
		const p = nearest(sx, sy);
		if (!p) continue;
		const [x, y] = p;
		if (!seen[y * width + x]) { seen[y * width + x] = 1; stack.push(x, y); }
	}
	while (stack.length) {
		const y = stack.pop(), x = stack.pop();
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const nx = x + dx, ny = y + dy;
			if (!walkable(doc, nx, ny) || seen[ny * width + nx]) continue;
			// No cutting a corner between two blocked cells, as rAthena's path search does not.
			if (dx && dy && (!walkable(doc, x + dx, y) || !walkable(doc, x, y + dy))) continue;
			seen[ny * width + nx] = 1;
			stack.push(nx, ny);
		}
	}
	return seen;
}

/**
 * @param doc       the map
 * @param context   { exists(path) -> Promise<bool>, incoming: [{from, x, y}] warps
 *                    from other maps that land here, hasMinimap, maps: Set of
 *                    known map names, mobs: Set of known ids/AegisNames,
 *                    testPoint: {x,y} }
 */
export async function validate(doc, context = {}) {
	const out = [];
	const add = (level, code, message, at) => out.push({ level, code, message, ...(at ? { at } : {}) });

	if (!/^[a-z0-9_@-]{1,11}$/.test(doc.name)) add('error', 'name', `"${doc.name}" is not a map name rAthena keeps: at most ${MAX_NAME} characters, lowercase letters, digits, _ and -. A longer one is cut short silently in three places.`);
	if (doc.gat.width !== doc.gnd.width * 2 || doc.gat.height !== doc.gnd.height * 2) add('error', 'size', `the .gat is ${doc.gat.width}x${doc.gat.height} cells but the ground is ${doc.gnd.width}x${doc.gnd.height} cubes; it must be exactly twice as many cells.`);
	for (const t of doc.gnd.tiles) if (t.texture >= doc.gnd.textures.length) { add('error', 'texture-index', `a tile names ground texture ${t.texture}, but the map has ${doc.gnd.textures.length}.`); break; }
	for (const msg of lightmapProblems(doc)) add('warning', 'lightmap', msg);

	// Files the client will ask for.
	if (context.exists) {
		const wanted = new Map();
		for (const t of doc.gnd.textures) wanted.set(`data/texture/${decodeName(t).replace(/\\/g, '/')}`, 'ground texture');
		for (const o of doc.rsw.objects) {
			if (o.type === 1) wanted.set(`data/model/${decodeName(o.file).replace(/\\/g, '/')}`, 'model');
			if (o.type === 3) wanted.set(`data/wav/${decodeName(o.file).replace(/\\/g, '/')}`, 'sound');
		}
		const missing = [];
		await Promise.all([...wanted].map(async ([path, kind]) => { if (!(await context.exists(path).catch(() => false))) missing.push({ path, kind }); }));
		for (const m of missing.slice(0, 30)) add('error', 'missing-file', `the ${m.kind} ${m.path} is not in your client or this mod: the client would ask for it and get nothing.`);
		if (missing.length > 30) add('error', 'missing-file', `…and ${missing.length - 30} more missing files.`);
	}

	// Gameplay.
	const g = doc.gameplay;
	const names = new Map();
	for (const n of [...g.npcs, ...g.warps]) {
		if (names.has(n.name)) add('error', 'duplicate-name', `two NPCs or warps are called "${n.name}"; rAthena loads only the first.`, { x: n.x, y: n.y, id: n.id });
		names.set(n.name, n);
		if (n.name.length > 24) add('error', 'long-name', `"${n.name}" is longer than rAthena's 24 characters.`, { x: n.x, y: n.y, id: n.id });
	}
	for (const n of g.npcs) {
		if (n.x < 0 || n.y < 0 || n.x >= doc.gat.width || n.y >= doc.gat.height) add('error', 'off-map', `${n.name} is off the map at ${n.x},${n.y}.`, { id: n.id });
		else if (!walkable(doc, n.x, n.y)) add('note', 'npc-blocked', `${n.name} stands on a cell you cannot walk on (${n.x},${n.y}); players can still click it from beside it.`, { x: n.x, y: n.y, id: n.id });
		if (n.kind === 'shop' && !(n.items || []).length) add('warning', 'empty-shop', `${n.name} is a shop with nothing to sell.`, { x: n.x, y: n.y, id: n.id });
		if (n.kind === 'warper' && !(n.destinations || []).length) add('warning', 'warper-empty', `${n.name} is a warper with nowhere to go.`, { x: n.x, y: n.y, id: n.id });
	}
	const landings = [];
	for (const w of g.warps) {
		if (w.x - w.xs < 0 || w.y - w.ys < 0 || w.x + w.xs >= doc.gat.width || w.y + w.ys >= doc.gat.height) add('warning', 'warp-edge', `the warp ${w.name} reaches past the edge of the map.`, { x: w.x, y: w.y, id: w.id });
		const d = w.dest || {};
		if (d.map === doc.name) {
			landings.push([d.x, d.y]);
			if (!walkable(doc, d.x, d.y)) add('error', 'warp-lands-blocked', `the warp ${w.name} lands on ${d.x},${d.y}, which you cannot walk on.`, { x: d.x, y: d.y, id: w.id });
			for (const other of g.warps) {
				if (Math.abs(d.x - other.x) <= other.xs && Math.abs(d.y - other.y) <= other.ys) add('error', 'warp-loop', `the warp ${w.name} lands inside the warp ${other.name}, which sends the player straight on: it looks exactly like the map not working.`, { x: d.x, y: d.y, id: w.id });
			}
		} else if (context.maps && d.map && !context.maps.has(d.map)) {
			add('warning', 'warp-unknown-map', `the warp ${w.name} goes to "${d.map}", which is not a map your client or your mods have.`, { x: w.x, y: w.y, id: w.id });
		}
	}
	for (const s of g.spawns) {
		const anywhere = s.x === 0 && s.y === 0 && s.xs === 0 && s.ys === 0;
		if (!anywhere && (s.x - s.xs < 0 || s.y - s.ys < 0 || s.x + s.xs >= doc.gat.width || s.y + s.ys >= doc.gat.height)) add('warning', 'spawn-edge', `the ${s.name} spawn area reaches past the edge of the map.`, { x: s.x, y: s.y, id: s.id });
		if (context.mobs && !context.mobs.has(String(s.mob)) && !context.mobs.has(String(s.mob).toUpperCase())) add('error', 'unknown-mob', `${s.mob} is not a monster this server has${context.era ? ` (${context.era})` : ''}.`, { x: s.x, y: s.y, id: s.id });
		if (!anywhere) {
			let free = 0;
			for (let y = Math.max(0, s.y - s.ys); y <= Math.min(doc.gat.height - 1, s.y + s.ys); y++) for (let x = Math.max(0, s.x - s.xs); x <= Math.min(doc.gat.width - 1, s.x + s.xs); x++) if (walkable(doc, x, y)) free++;
			if (!free) add('error', 'spawn-blocked', `the ${s.name} spawn area has no walkable cell: rAthena will put them anywhere on the map instead.`, { x: s.x, y: s.y, id: s.id });
			else if (s.amount > free) add('warning', 'spawn-crowded', `${s.amount} ${s.name} in ${free} walkable cells.`, { x: s.x, y: s.y, id: s.id });
		}
	}

	// Getting here, and getting around.
	const incoming = (context.incoming || []).slice();
	// The way back of a two-way warp, written in this map's own block.
	for (const w of doc.gameplay.external || []) if (w.dest && w.dest.map === doc.name && !incoming.some(i => i.from === w.map && i.x === w.dest.x && i.y === w.dest.y)) incoming.push({ from: w.map, x: w.dest.x, y: w.dest.y });
	for (const w of incoming) landings.push([w.x, w.y]);
	if (context.testPoint) landings.push([context.testPoint.x, context.testPoint.y]);
	for (const w of incoming) if (!walkable(doc, w.x, w.y)) add('error', 'incoming-blocked', `a warp from ${w.from} lands on ${w.x},${w.y}, which you cannot walk on.`, { x: w.x, y: w.y });
	if (!incoming.length) add('note', 'no-way-in', `nothing leads to ${doc.name} yet: no warp or NPC from another map. Only @warp or Test in game will get anyone here. Add a warp on a town map (Gameplay → Warp, destination this map).`);
	if (landings.length) {
		const seen = reachable(doc, landings);
		let lost = 0, total = 0, first = null;
		for (let y = 0; y < doc.gat.height; y++) for (let x = 0; x < doc.gat.width; x++) {
			if (!walkable(doc, x, y)) continue;
			total++;
			if (!seen[y * doc.gat.width + x]) { lost++; if (!first) first = { x, y }; }
		}
		if (lost && lost > total * 0.01) add('warning', 'unreachable', `${lost} of ${total} walkable cells cannot be reached from where players arrive (the first at ${first.x},${first.y}).`, first);
		for (const n of g.npcs) {
			const near = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1], [0, 0]].some(([dx, dy]) => { const x = n.x + dx, y = n.y + dy; return walkable(doc, x, y) && seen[y * doc.gat.width + x]; });
			if (!near) add('warning', 'npc-unreachable', `nobody can walk up to ${n.name} from where players arrive.`, { x: n.x, y: n.y, id: n.id });
		}
	}
	let walk = 0;
	for (const t of doc.gat.types) if (cellKind(t).walk) walk++;
	if (!walk) add('error', 'no-walkable', 'there is not one walkable cell on the map.');
	if (context.hasMinimap === false) add('warning', 'minimap', 'there is no minimap; the client shows an empty frame. Saving generates one.');
	if (doc.warnings) for (const w of doc.warnings) add('warning', 'file', w);
	return out;
}
