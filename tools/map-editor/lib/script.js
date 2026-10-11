// The gameplay on a map, as rAthena script: NPCs, shops, warps, monsters.
//
// The editor owns *placement* and writes it as one generated block in
// npc/<map>.txt, between two marker lines; everything outside the block is
// the author's and is never rewritten. The *logic* of a scripted NPC lives in
// a function in npc/<map>_dialogue.txt, which the author edits in their own
// text editor; the generated NPC only calls it. So regenerating can never eat
// a hand edit.
//
// Reading goes the other way for any script, generated or hand-written: every
// `script`, `shop`, `warp`, `monster` and `duplicate` line on the map becomes
// a marker. A hand-written one is edited in place -- only its header line
// (where it is, what it looks like) is rewritten, its body is left alone.

export const BEGIN = name => `//== BEGIN map-editor: ${name} -- generated, edits here are replaced ==`;
export const END = '//== END map-editor ==';
const META = '//@ ';

export const NPC_KINDS = ['script', 'sign', 'healer', 'warper', 'shop', 'duplicate'];
export const SPAWN_KINDS = ['monster', 'boss_monster', 'miniboss_monster'];
const SHOP_TYPES = ['shop', 'cashshop', 'itemshop', 'pointshop', 'marketshop'];

/** rAthena's facing numbers, for the UI. */
export const DIRECTIONS = ['north', 'north-west', 'west', 'south-west', 'south', 'south-east', 'east', 'north-east'];

/**
 * Split a script file into top-level entries, keeping each one's place in the
 * text: { start, end, headerEnd, line } plus what it is. Comments and
 * anything not understood are skipped over, not lost: they are simply not
 * entries, and stay in the text.
 */
export function scanScript(text) {
	const entries = [];
	let i = 0;
	const n = text.length;
	while (i < n) {
		// Skip blank space and comments between entries.
		if (text.startsWith('//', i)) { const e = text.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
		if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
		const c = text[i];
		if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
		const lineEnd = (() => { const e = text.indexOf('\n', i); return e < 0 ? n : e; })();
		const line = text.slice(i, lineEnd).replace(/\r$/, '');
		const entry = parseHeader(line);
		if (!entry) { i = lineEnd + 1; continue; }
		entry.start = i;
		// A body in braces runs to its matching brace, over lines.
		const brace = entry.bodyAt >= 0 ? i + entry.bodyAt : -1;
		if (brace >= 0) {
			const close = matchBrace(text, brace);
			entry.end = close < 0 ? n : close + 1;
			entry.body = text.slice(brace + 1, close < 0 ? n : close);
			entry.headerEnd = brace;
			const after = text.indexOf('\n', entry.end);
			entry.end = after < 0 ? n : after + 1;
		} else {
			entry.headerEnd = lineEnd;
			entry.end = lineEnd < n ? lineEnd + 1 : n;
		}
		entries.push(entry);
		i = entry.end;
	}
	return entries;
}

/** The index of the brace matching the one at `open`, skipping strings and comments. */
function matchBrace(text, open) {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (c === '"') { i++; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; } continue; }
		if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); if (e < 0) return -1; i = e; continue; }
		if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 1; continue; }
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) return i; }
	}
	return -1;
}

/**
 * One header line: `map,x,y,dir<TAB>type<TAB>name<TAB>rest`. rAthena wants
 * tabs; a hand-written file with runs of spaces is read too.
 */
export function parseHeader(line) {
	let parts = line.split('\t');
	if (parts.length < 3) parts = line.split(/ {2,}|\t/);
	if (parts.length < 3) return null;
	const [where, type, name, ...restParts] = parts;
	const rest = restParts.join('\t');
	const t = type.trim();
	if (where.trim() === '-' || where.trim() === 'function') return null;
	const coords = where.split(',').map(s => s.trim());
	const map = coords[0];
	if (!/^[A-Za-z0-9_@-]{1,15}$/.test(map)) return null;
	const num = k => (coords[k] === undefined || coords[k] === '' ? 0 : Number(coords[k]));
	const bodyIndex = () => line.indexOf('{', where.length + type.length + name.length + 2);
	if (t === 'script' || /^duplicate\(/.test(t)) {
		// sprite[,xs,ys],{ body }
		const m = /^\s*([^,{]*?)\s*(?:,\s*(-?\d+)\s*,\s*(-?\d+))?\s*,?\s*(\{|$)/.exec(rest);
		const dup = /^duplicate\((.*)\)$/.exec(t);
		const entry = {
			type: dup ? 'duplicate' : 'script', map, x: num(1), y: num(2), dir: num(3), name: name.trim(),
			sprite: m ? m[1] : rest.trim(), xs: m && m[2] ? Number(m[2]) : 0, ys: m && m[3] ? Number(m[3]) : 0,
			source: dup ? dup[1] : null, bodyAt: -1,
		};
		if (!dup) entry.bodyAt = bodyIndex();
		if (!dup && entry.bodyAt < 0) return null;
		return entry;
	}
	if (SHOP_TYPES.includes(t)) {
		const [sprite, ...items] = rest.split(',').map(s => s.trim());
		const entry = { type: 'shop', shopType: t, map, x: num(1), y: num(2), dir: num(3), name: name.trim(), sprite, items: [], currency: null, bodyAt: -1 };
		let list = items;
		if (t === 'itemshop' || t === 'pointshop') { entry.currency = list[0]; list = list.slice(1); }
		for (const it of list) {
			const [id, price, stock] = it.split(':').map(s => s.trim());
			if (!id) continue;
			entry.items.push({ id: /^\d+$/.test(id) ? Number(id) : id, price: price === undefined ? -1 : Number(price), ...(stock !== undefined ? { stock: Number(stock) } : {}) });
		}
		return entry;
	}
	if (t === 'warp' || t === 'warp2') {
		const [xs, ys, dest, dx, dy] = rest.split(',').map(s => s.trim());
		return { type: 'warp', warpType: t, map, x: num(1), y: num(2), name: name.trim(), xs: Number(xs) || 0, ys: Number(ys) || 0, dest: { map: dest, x: Number(dx) || 0, y: Number(dy) || 0 }, bodyAt: -1 };
	}
	if (SPAWN_KINDS.includes(t)) {
		const [mob, amount, d1, d2, event, size, ai] = rest.split(',').map(s => s.trim());
		const nameParts = name.trim();
		return {
			type: 'monster', spawnType: t, map, x: num(1), y: num(2), xs: num(3), ys: num(4), name: nameParts,
			mob: /^\d+$/.test(mob) ? Number(mob) : mob, amount: Number(amount) || 1, delay1: Number(d1) || 0, delay2: Number(d2) || 0,
			event: event || '', size: size || '', ai: ai || '', bodyAt: -1,
		};
	}
	return null;
}

/** The marker line before a generated entry: everything the form knows. */
function metaLine(obj) {
	const { id, kind, text, destinations, heal, buffs, items, fn, touch } = obj;
	const meta = { id, kind };
	if (text !== undefined) meta.text = text;
	if (destinations) meta.destinations = destinations;
	if (heal !== undefined) meta.heal = heal;
	if (buffs) meta.buffs = buffs;
	if (fn) meta.fn = fn;
	if (touch) meta.touch = touch;
	void items;
	return META + JSON.stringify(meta);
}

const q = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The visible part of an NPC name (before #). */
export const displayName = name => String(name || '').split('#')[0] || 'NPC';

/** A function name for an NPC's dialogue: <map>_<name>, script-safe. */
export function functionName(map, name) {
	const base = `${map}_${displayName(name)}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
	return base.slice(0, 40) || `${map}_npc`;
}

/** The rAthena script for one editor object. */
export function generateEntry(obj, map) {
	const pos = `${map},${obj.x},${obj.y}`;
	if (obj.kind === 'warp') {
		const d = obj.dest || {};
		return `${pos},0\twarp\t${obj.name}\t${obj.xs | 0},${obj.ys | 0},${d.map},${d.x | 0},${d.y | 0}`;
	}
	if (SPAWN_KINDS.includes(obj.kind) || obj.kind === 'spawn') {
		const type = obj.kind === 'spawn' ? 'monster' : obj.kind;
		const tail = [obj.mob, obj.amount | 0 || 1, obj.delay1 | 0, obj.delay2 | 0, obj.event || '', obj.size || '', obj.ai || ''];
		// Optional fields only as far as the last one given.
		while (tail.length > 4 && tail[tail.length - 1] === '') tail.pop();
		return `${pos},${obj.xs | 0},${obj.ys | 0}\t${type}\t${obj.name}\t${tail.join(',')}`;
	}
	const head = `${pos},${obj.dir | 0}`;
	const sprite = obj.sprite || '4_M_MANAGER';
	const area = obj.touch ? `,${obj.touch.xs | 0},${obj.touch.ys | 0}` : '';
	const who = q(`[${displayName(obj.name)}]`);
	switch (obj.kind) {
		case 'shop': {
			const items = (obj.items || []).map(it => `${it.id}:${it.price ?? -1}`).join(',');
			return `${head}\tshop\t${obj.name}\t${sprite},${items || '501:-1'}`;
		}
		case 'duplicate':
			return `${head}\tduplicate(${obj.source})\t${obj.name}\t${sprite}${area}`;
		case 'sign': {
			const lines = String(obj.text || '...').split('\n').map(l => `\tmes ${q(l)};`).join('\n');
			return `${head}\tscript\t${obj.name}\t${sprite}${area},{\n\tmes ${who};\n${lines}\n\tclose;\n}`;
		}
		case 'healer': {
			const buffs = (obj.buffs || []).map(b => `\tsc_start ${b.sc},${b.ms | 0 || 240000},${b.level | 0 || 10};\n`).join('');
			return `${head}\tscript\t${obj.name}\t${sprite}${area},{\n\tmes ${who};\n\tmes ${q(obj.text || 'There you go, good as new.')};\n\tpercentheal 100,100;\n\tspecialeffect2 EF_HEAL2;\n${buffs}\tclose;\n}`;
		}
		case 'warper': {
			const dests = obj.destinations || [];
			const menu = dests.map(d => d.label || d.map).concat('Cancel').join(':');
			const cases = dests.map((d, i) => `\tcase ${i + 1}:\n\t\twarp ${q(d.map)},${d.x | 0},${d.y | 0};\n\t\tend;\n`).join('');
			return `${head}\tscript\t${obj.name}\t${sprite}${area},{\n\tmes ${who};\n\tmes ${q(obj.text || 'Where would you like to go?')};\n\tswitch (select(${q(menu)})) {\n${cases}\t}\n\tclose;\n}`;
		}
		case 'script':
		default: {
			const fn = obj.fn || functionName(map, obj.name);
			const touch = obj.touch ? `\nOnTouch:\n\tcallfunc ${q(fn + '_touch')};\n\tend;` : '';
			return `${head}\tscript\t${obj.name}\t${sprite}${area},{\n\tcallfunc ${q(fn)};\n\tend;${touch}\n}`;
		}
	}
}

/** The whole generated block for a map. */
export function generateBlock(map, gameplay) {
	const out = [BEGIN(map)];
	const section = (title, list) => {
		const mine = list.filter(o => !o.handwritten);
		if (!mine.length) return;
		out.push(title);
		for (const obj of mine) out.push(metaLine(obj), generateEntry(obj, map));
	};
	section('// NPCs', gameplay.npcs);
	section('// Warps', gameplay.warps);
	section('// Monsters', gameplay.spawns);
	const external = (gameplay.external || []).filter(w => w.map !== map);
	if (external.length) out.push('// The way back, on other maps');
	for (const w of external) out.push(generateEntry({ ...w, kind: 'warp' }, w.map));
	out.push(END);
	return out.join('\n') + '\n';
}

/** Where the generated block is in a file's text, or null. */
export function findBlock(text, map) {
	const begin = text.indexOf(BEGIN(map));
	if (begin < 0) return null;
	const endAt = text.indexOf(END, begin);
	if (endAt < 0) return null;
	let end = endAt + END.length;
	if (text[end] === '\r') end++;
	if (text[end] === '\n') end++;
	return { start: begin, end };
}

/** A file's text with its generated block replaced (or added at the end). */
export function replaceBlock(text, map, gameplay) {
	const block = generateBlock(map, gameplay);
	const at = findBlock(text || '', map);
	if (at) return text.slice(0, at.start) + block + text.slice(at.end);
	const head = text ? (text.endsWith('\n') ? text : text + '\n') + '\n' : `// Everything on ${map}: NPCs, warps and monsters.\n// The block below is the map editor's; write your own script above or below it.\n\n`;
	return head + block;
}

function entryToObject(e, file, handwritten) {
	const base = { map: e.map, x: e.x, y: e.y, name: e.name, file, handwritten };
	if (e.type === 'warp') return { ...base, kind: 'warp', xs: e.xs, ys: e.ys, dest: e.dest };
	if (e.type === 'monster') return { ...base, kind: e.spawnType, xs: e.xs, ys: e.ys, mob: e.mob, amount: e.amount, delay1: e.delay1, delay2: e.delay2, event: e.event, size: e.size, ai: e.ai };
	if (e.type === 'shop') return { ...base, kind: 'shop', dir: e.dir, sprite: e.sprite, items: e.items, shopType: e.shopType, currency: e.currency };
	if (e.type === 'duplicate') return { ...base, kind: 'duplicate', dir: e.dir, sprite: e.sprite, source: e.source, touch: e.xs || e.ys ? { xs: e.xs, ys: e.ys } : null };
	const fnCall = /callfunc\s+"([^"]+)"/.exec(e.body || '');
	return { ...base, kind: 'script', dir: e.dir, sprite: e.sprite, fn: fnCall ? fnCall[1] : null, touch: e.xs || e.ys ? { xs: e.xs, ys: e.ys } : null, body: e.body };
}

/**
 * The gameplay on `map` from a set of script files ({ path: text }). Entries in
 * the map's generated block come back as editor objects (their form data from
 * the meta line); everything else on the map is `handwritten`, with its file
 * and its place so it can be edited in place.
 */
export function readGameplay(map, files) {
	const out = { npcs: [], warps: [], spawns: [], external: [], nextId: 1 };
	const add = obj => {
		if (!obj.id) obj.id = `${obj.kind === 'warp' ? 'warp' : SPAWN_KINDS.includes(obj.kind) ? 'spawn' : 'npc'}-${out.nextId++}`;
		else { const n = Number(String(obj.id).split('-').pop()); if (n >= out.nextId) out.nextId = n + 1; }
		if (obj.kind === 'warp') out.warps.push(obj);
		else if (SPAWN_KINDS.includes(obj.kind)) out.spawns.push(obj);
		else out.npcs.push(obj);
	};
	for (const [file, text] of Object.entries(files)) {
		const block = findBlock(text, map);
		const entries = scanScript(text);
		for (const e of entries) {
			const inBlock = block && e.start >= block.start && e.start < block.end;
			if (e.map !== map) {
				// A warp in this map's block that stands on another map: the way
				// back of a two-way warp.
				if (inBlock && e.type === 'warp') out.external.push({ ...entryToObject(e, file, false), id: `warp-${out.nextId++}` });
				continue;
			}
			const obj = entryToObject(e, file, !inBlock);
			if (inBlock) {
				// The meta line just before it, if any.
				const before = text.lastIndexOf('\n', e.start - 2);
				const metaText = text.slice(before + 1, e.start).trim();
				if (metaText.startsWith(META)) {
					try {
						const meta = JSON.parse(metaText.slice(META.length));
						Object.assign(obj, meta);
						if (meta.kind !== 'script') delete obj.body;
					} catch { /* a hand-mangled meta line: keep what the line says */ }
				}
				delete obj.file;
				delete obj.handwritten;
			} else {
				obj.span = [e.start, e.headerEnd];
			}
			add(obj);
		}
	}
	return out;
}

/**
 * A hand-written entry's header, rewritten from its object. Only what the
 * header holds changes; a script's body is kept as it was.
 */
export function rewriteHeader(text, obj) {
	const [start, headerEnd] = obj.span;
	const old = text.slice(start, headerEnd);
	let fresh;
	if (obj.kind === 'warp' || SPAWN_KINDS.includes(obj.kind) || obj.kind === 'shop') {
		const line = generateEntry({ ...obj, kind: obj.kind === 'shop' ? 'shop' : obj.kind }, obj.map);
		fresh = obj.kind === 'shop' && obj.shopType && obj.shopType !== 'shop' ? line.replace('\tshop\t', `\t${obj.shopType}\t`) : line;
	} else if (obj.kind === 'duplicate') {
		fresh = generateEntry(obj, obj.map);
	} else {
		// script: keep everything from the brace on.
		const area = obj.touch ? `,${obj.touch.xs | 0},${obj.touch.ys | 0}` : '';
		fresh = `${obj.map},${obj.x},${obj.y},${obj.dir | 0}\tscript\t${obj.name}\t${obj.sprite}${area},`;
	}
	return { text: text.slice(0, start) + fresh + text.slice(headerEnd), delta: fresh.length - old.length };
}

/** Remove a hand-written entry entirely. */
export function removeEntry(text, obj, entries = scanScript(text)) {
	const e = entries.find(x => x.start === obj.span[0]);
	if (!e) return text;
	return text.slice(0, e.start) + text.slice(e.end);
}

/** A new dialogue function, appended to the dialogue file. */
export function dialogueTemplate(map, fn, name, touch = false) {
	const who = `[${displayName(name)}]`;
	let out = `\n// ${displayName(name)} on ${map}. Yours to write: the map editor only ever adds new functions to this file.\nfunction\tscript\t${fn}\t{\n\tmes ${q(who)};\n\tmes "Hello there!";\n\tnext;\n\tmes ${q(who)};\n\tmes "Edit this in npc/${map}_dialogue.txt.";\n\tclose;\n}\n`;
	if (touch) out += `\nfunction\tscript\t${fn}_touch\t{\n\t// Runs when someone walks into the NPC's area.\n\tend;\n}\n`;
	return out;
}

export function dialogueHeader(map) {
	return `// Dialogue for the NPCs on ${map}.\n//\n// Each scripted NPC the map editor places calls one function here. The editor\n// adds a function when you add an NPC and never changes one you have written.\n// rAthena's script reference: https://github.com/rathena/rathena/blob/master/doc/script_commands.txt\n`;
}

/** Which dialogue functions a file already defines. */
export function definedFunctions(text) {
	const out = new Set();
	for (const m = /^\s*function\s+script\s+([A-Za-z0-9_]+)\s*\{/gm; ;) {
		const hit = m.exec(text || '');
		if (!hit) break;
		out.add(hit[1]);
	}
	for (const hit of (text || '').matchAll(/^\s*function\t+script\t+([A-Za-z0-9_]+)\t*\{/gm)) out.add(hit[1]);
	return out;
}

// ---- Signboards (data/luafiles514/lua files/SignBoardList.lub)

export const SIGNBOARD_PATH = 'data/luafiles514/lua files/SignBoardList.lub';

export function parseSignboards(text) {
	const rows = [];
	for (const m of (text || '').matchAll(/\{\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"((?:[^"\\]|\\.)*)")?\s*(?:,\s*"([^"]*)")?\s*\}/g)) {
		rows.push({ map: m[1], x: Number(m[2]), y: Number(m[3]), height: Number(m[4]), type: Number(m[5]), icon: m[6].replace(/\\\\/g, '\\'), caption: m[7] || '', color: m[8] || '' });
	}
	return rows;
}

export function writeSignboards(rows) {
	const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	const body = rows.map(r => {
		const parts = [`"${r.map}"`, r.x | 0, r.y | 0, r.height | 0, r.type | 0, `"${esc(r.icon)}"`];
		if (r.type !== 1) parts.push(`"${esc(r.caption || '')}"`, `"${r.color || '#0x00FFFFFF'}"`);
		return `\t{ ${parts.join(', ')} },`;
	}).join('\n');
	return `-- Signs and icons over NPCs, added to the client's own (the map editor writes this file).\nSignBoardList = {\n${body}\n}\n`;
}
