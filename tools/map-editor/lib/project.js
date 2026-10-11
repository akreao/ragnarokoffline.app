// A map and the mod it lives in: reading the gameplay and properties back
// out of a mod, and writing everything a map mod is made of.
//
//   data/<map>.gat .gnd .rsw          the geometry
//   data/texture/ui/map/<map>.bmp     the minimap (ASCII folder name: the app
//                                     lays it down as 유저인터페이스)
//   npc/<map>.txt                     the editor's generated block; the rest
//                                     of the file is the author's
//   npc/<map>_dialogue.txt            the author's dialogue functions; the
//                                     editor only ever appends a new one
//   data/luafiles514/lua files/SignBoardList.lub   signs over NPCs (merged)
//   db/population_spawn.yml           where the AI characters live (merged)
//   mod.json                          "maps": sky, clouds, weather, music
//
// What is only the editor's business (the test spawn point, hand-locked
// walkability, the camera) goes to state/map-editor/projects/<mod>.json,
// outside the mod, so it is never shipped.

import { mapFiles } from './map.js';
import { readGameplay, replaceBlock, rewriteHeader, removeEntry, scanScript, definedFunctions, dialogueTemplate, dialogueHeader, parseSignboards, writeSignboards, SIGNBOARD_PATH, functionName } from './script.js';
import { toBase64, fromBase64 } from './binary.js';

export const minimapPath = name => `data/texture/ui/map/${name}.bmp`;
export const scriptPath = name => `npc/${name}.txt`;
export const dialoguePath = name => `npc/${name}_dialogue.txt`;
export const APP_FOR_MAPS = '>=1.5.1';

/** Lay a mod's gameplay, properties and notes for this map over a freshly opened doc. */
export function attachProject(doc, project) {
	const map = doc.name;
	const gp = readGameplay(map, project.scripts || {});
	doc.gameplay.npcs = gp.npcs;
	doc.gameplay.warps = gp.warps;
	doc.gameplay.spawns = gp.spawns;
	doc.gameplay.external = gp.external;
	doc.gameplay.nextId = gp.nextId;
	doc.gameplay.signboards = parseSignboards(project.signboards || '').filter(r => r.map === map);
	doc.gameplay.population = readPopulation(project.population || '', map);
	const look = (project.manifest && project.manifest.maps && (project.manifest.maps[map] || project.manifest.maps[`${map}.rsw`])) || {};
	doc.props = { ...doc.props, sky: look.sky ? look.sky.slice(0, 3) : null, clouds: look.clouds || null, weather: look.weather || null, bgm: look.bgm || null };
	const notes = (project.notes && project.notes.maps && project.notes.maps[map]) || {};
	if (notes.displayName) doc.props.displayName = notes.displayName;
	if (notes.gatLocked) {
		const bits = fromBase64(notes.gatLocked);
		if (bits.length === doc.gat.width * doc.gat.height) doc.gatLocked = bits;
	}
	doc.testPoint = notes.testPoint || null;
	doc.mod = project.mod;
	return doc;
}

// ---- Population (db/population_spawn.yml)

const POP_TAG = map => `# map-editor: ${map}`;

export function readPopulation(text, map) {
	const at = text.indexOf(POP_TAG(map));
	if (at < 0) return null;
	const lineStart = text.lastIndexOf('\n', at) + 1;
	const next = text.slice(at).search(/\n {2}- /);
	const item = text.slice(lineStart, next < 0 ? text.length : at + next);
	const profile = /Profile:\s*([A-Za-z0-9_]+)/.exec(item);
	const cat = /(Towns|Fields|Dungeons)Add:/.exec(item);
	const count = /(?:Towns|Fields|Dungeons)PopulationAdd:\s*(\d+)/.exec(item);
	const max = /(?:Towns|Fields|Dungeons)MaxPerMap:\s*(\d+)/.exec(item);
	if (!profile || !cat) return null;
	return { profile: profile[1], category: cat[1], count: count ? Number(count[1]) : 0, maxPerMap: max ? Number(max[1]) : 0 };
}

export function writePopulation(text, map, pop) {
	let out = text && text.trim() ? text : 'Header:\n  Type: POPULATION_SPAWN_DB\n  Version: 1\n\nBody:\n';
	// Take out this map's item (from its tagged line to the next item).
	const at = out.indexOf(POP_TAG(map));
	if (at >= 0) {
		const lineStart = out.lastIndexOf('\n', at) + 1;
		const next = out.slice(at).search(/\n {2}- /);
		out = out.slice(0, lineStart) + (next < 0 ? '' : out.slice(at + next + 1));
	}
	if (pop && pop.count > 0) {
		if (!/\nBody:\s*\n/.test('\n' + out)) out = out.replace(/\s*$/, '\n\nBody:\n');
		if (!out.endsWith('\n')) out += '\n';
		out += `  - Profile: ${pop.profile}   ${POP_TAG(map)}\n    ${pop.category}Add:\n      - ${map}\n    ${pop.category}PopulationAdd: ${pop.count}\n    ${pop.category}MaxPerMap: ${pop.maxPerMap || pop.count}\n`;
	}
	return out;
}

// ---- mod.json

export function mergeManifest(manifest, mod, doc, { author } = {}) {
	const m = manifest ? structuredClone(manifest) : {
		name: mod, version: '1.0.0', author: author || 'Map editor', description: `A map made in the Ragnarok Offline map editor: ${doc.name}.`,
		requires: { app: '>=1.0.6', era: 'any' },
	};
	const look = {};
	const p = doc.props;
	if (p.sky) look.sky = p.sky.map(v => +Number(v).toFixed(3));
	if (p.sky && p.clouds) look.clouds = p.clouds.map(v => +Number(v).toFixed(3));
	if (p.weather) look.weather = p.weather;
	if (p.bgm) look.bgm = p.bgm;
	m.maps = m.maps || {};
	delete m.maps[`${doc.name}.rsw`];
	// The supervisor refuses an entry that sets nothing, so an empty one goes.
	if (Object.keys(look).length) m.maps[doc.name] = look; else delete m.maps[doc.name];
	if (!Object.keys(m.maps).length) delete m.maps;
	if (m.maps) {
		m.requires = m.requires || {};
		const app = m.requires.app || '';
		if (!app || /^>=1\.[0-4]\b|^>=1\.5\.0$|^>=1\.0/.test(app)) m.requires.app = APP_FOR_MAPS;
	}
	return m;
}

/**
 * Everything to write for this map, as { files: { path: Uint8Array | { text } },
 * remove: [paths], notes, summary }. `project` is what the bridge's
 * api/project returned (null for a new mod); `minimap` the BMP bytes.
 */
export function buildModFiles(doc, project, { minimap = null, author } = {}) {
	const map = doc.name, mod = project?.mod || doc.mod;
	const scripts = { ...(project?.scripts || {}) };
	const files = {};
	const summary = [];
	for (const [name, bytes] of Object.entries(mapFiles(doc))) files[`data/${name}`] = bytes;
	if (minimap) files[minimapPath(map)] = minimap;

	// Hand-written entries edited or removed: in place, last first so earlier
	// positions in the same file stay right.
	const handEdits = [...doc.gameplay.npcs, ...doc.gameplay.warps, ...doc.gameplay.spawns].filter(o => o.handwritten && o.dirty && o.file && o.span);
	const handRemoved = (doc.gameplay.removed || []).filter(o => o.file && o.span);
	const byFile = new Map();
	for (const o of handEdits) (byFile.get(o.file) || byFile.set(o.file, []).get(o.file)).push({ op: 'edit', o });
	for (const o of handRemoved) (byFile.get(o.file) || byFile.set(o.file, []).get(o.file)).push({ op: 'remove', o });
	for (const [file, ops] of byFile) {
		let text = scripts[file];
		if (text === undefined) continue;
		ops.sort((a, b) => b.o.span[0] - a.o.span[0]);
		for (const { op, o } of ops) text = op === 'edit' ? rewriteHeader(text, o).text : removeEntry(text, o, scanScript(text));
		scripts[file] = text;
		files[file] = { text };
		summary.push(`${ops.length} hand-written line(s) in ${file}`);
	}

	// The generated block.
	const sp = scriptPath(map);
	const before = scripts[sp] || '';
	const after = replaceBlock(before, map, doc.gameplay);
	if (after !== before) { files[sp] = { text: after }; scripts[sp] = after; }

	// Dialogue functions for scripted NPCs that have none yet, anywhere in the mod.
	const dp = dialoguePath(map);
	const defined = new Set();
	for (const text of Object.values(scripts)) for (const f of definedFunctions(text)) defined.add(f);
	let dialogue = scripts[dp] || '';
	const fresh = [];
	for (const n of doc.gameplay.npcs) {
		if (n.kind !== 'script' || n.handwritten) continue;
		const fn = n.fn || functionName(map, n.name);
		n.fn = fn;
		if (defined.has(fn)) continue;
		dialogue = (dialogue || dialogueHeader(map)) + dialogueTemplate(map, fn, n.name, !!n.touch);
		defined.add(fn);
		fresh.push(fn);
	}
	if (fresh.length) { files[dp] = { text: dialogue }; summary.push(`new dialogue: ${fresh.join(', ')}`); }

	// Signboards: this map's rows replaced, every other map's kept.
	const otherSigns = parseSignboards(project?.signboards || '').filter(r => r.map !== map);
	const signs = [...otherSigns, ...doc.gameplay.signboards.map(r => ({ ...r, map }))];
	if (signs.length || project?.signboards) files[SIGNBOARD_PATH] = { text: writeSignboards(signs) };

	// Population.
	if (doc.gameplay.population || (project?.population || '').includes(POP_TAG(map))) {
		files['db/population_spawn.yml'] = { text: writePopulation(project?.population || '', map, doc.gameplay.population) };
	}

	// mod.json.
	const manifest = mergeManifest(project?.manifest, mod, doc, { author });
	files['mod.json'] = { text: manifestText(manifest) };

	const notes = structuredClone(project?.notes || {});
	notes.maps = notes.maps || {};
	notes.maps[map] = {
		...(notes.maps[map] || {}),
		displayName: doc.props.displayName || '',
		testPoint: doc.testPoint || null,
		gatLocked: doc.gatLocked && doc.gatLocked.some(Boolean) ? toBase64(doc.gatLocked) : null,
		savedAt: new Date().toISOString(),
		source: doc.source || null,
	};
	return { files, notes, summary };
}

/** mod.json as people write it: two-space indent, colours on one line. */
export function manifestText(manifest) {
	return JSON.stringify(manifest, null, 2).replace(/\[\s+(-?[\d.]+(?:,\s+-?[\d.]+)*)\s+\]/g, (_, inner) => `[${inner.split(/,\s+/).join(', ')}]`) + '\n';
}

/** The payload the bridge's api/save takes. */
export function savePayload(mod, built) {
	const files = {};
	for (const [path, v] of Object.entries(built.files)) files[path] = v instanceof Uint8Array ? toBase64(v) : { text: v.text };
	return { mod, files, notes: built.notes };
}

/** Warps in the mod's other scripts that lead to this map, for validation. */
export function incomingWarps(map, scripts) {
	const out = [];
	for (const [file, text] of Object.entries(scripts || {})) {
		for (const e of scanScript(text)) {
			if (e.type === 'warp' && e.dest.map === map && e.map !== map) out.push({ from: e.map, x: e.dest.x, y: e.dest.y, file });
			if (e.type === 'script' && e.map !== map) for (const m of (e.body || '').matchAll(/warp\s+"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)/g)) if (m[1] === map) out.push({ from: e.map, x: Number(m[2]), y: Number(m[3]), file });
		}
	}
	return out;
}
