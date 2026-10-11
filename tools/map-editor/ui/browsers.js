// Browsing the player's own client: models with rendered thumbnails, ground
// textures, NPC and monster sprites, music (played in place) and sounds.
// Everything is read from the GRFs through the asset server, by path; a map
// refers to these files, it does not copy them.

import { h, debounce } from './dom.js';
import { get, post, assetUrl } from './host.js';
import { readRsm, compileModel } from '../lib/rsm.js';
import { readSpr, readAct, renderSprite } from '../lib/sprite.js';
import { decodeName } from '../lib/cp949.js';
import { mat4 } from '../lib/mat.js';
import { MODEL_VS, MODEL_FS } from '../render/shaders.js';

// Common model folders, in English (the GRFs name them in Korean).
export const FOLDER_NAMES = {
	'프론테라': 'Prontera', '게펜': 'Geffen', '페이욘': 'Payon', '모로코': 'Morocc', '알베르타': 'Alberta', '알데바란': 'Aldebaran', '유노': 'Juno',
	'아인브로크': 'Einbroch', '리히타르젠': 'Lighthalzen', '휘겐': 'Hugel', '라헬': 'Rachel', '베인스': 'Veins', '니플헤임': 'Niflheim', '코모도': 'Comodo',
	'움발라': 'Umbala', '아마츠': 'Amatsu', '곤룡': 'Gonryun', '루이난': 'Louyang', '아유타야': 'Ayothaya', '크리스마스마을': 'Lutie (Christmas)', '글래스트헤임': 'Glast Heim',
	'외부소품': 'Outdoor props', '내부소품': 'Indoor props', '인던01': 'Instance 01', '인던02': 'Instance 02', '사막도시': 'Desert town', '이즈루드': 'Izlude', '모스코비아': 'Moscovia',
	'자와이': 'Jawaii', '토르화산': 'Thor volcano', '오크마을': 'Orc village', '필드': 'Field', '던전': 'Dungeon', '가상공간': 'Virtual space', '피라미드': 'Pyramid',
};
const english = path => path.split('\\').map(p => FOLDER_NAMES[p] || p).join(' / ');

const RECENT = 'map-editor:recent-models';
const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT)) || []; } catch { return []; } };
const remember = path => { try { localStorage.setItem(RECENT, JSON.stringify([path, ...recent().filter(p => p !== path)].slice(0, 24))); } catch { /* */ } };

/** Lazily fill elements as they scroll into view. */
const observer = new IntersectionObserver(entries => {
	for (const e of entries) if (e.isIntersecting && e.target._fill) { const f = e.target._fill; e.target._fill = null; observer.unobserve(e.target); f(); }
}, { rootMargin: '100px' });
function lazyFill(el, fill) { el._fill = fill; observer.observe(el); return el; }

// ---- Model thumbnails, rendered once each with the model's own textures

let thumbGl = null;
const thumbCache = new Map();
let thumbQueue = Promise.resolve();

function thumbContext() {
	if (thumbGl) return thumbGl;
	const canvas = new OffscreenCanvas(128, 128);
	const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false });
	const prog = gl.createProgram();
	for (const [type, src] of [[gl.VERTEX_SHADER, MODEL_VS], [gl.FRAGMENT_SHADER, MODEL_FS]]) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(prog, s); }
	gl.linkProgram(prog);
	thumbGl = { canvas, gl, prog, loc: n => gl.getUniformLocation(prog, n), attr: n => gl.getAttribLocation(prog, n) };
	return thumbGl;
}

async function imageToTexture(gl, img) {
	const t = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, t);
	if (img && img.data) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.data.buffer || img.data));
	else if (img) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
	else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([180, 180, 180, 255]));
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return t;
}

/** A model's picture, as a data URL. `path` is under data/model/, as text. */
export function modelThumb(E, path) {
	if (thumbCache.has(path)) return thumbCache.get(path);
	const p = (thumbQueue = thumbQueue.then(async () => {
		const bytes = await E.assets.file(`data/model/${path.replace(/\\/g, '/')}`);
		if (!bytes) return null;
		const model = readRsm(bytes);
		const { meshes, box } = compileModel(model);
		const T = thumbContext(), gl = T.gl;
		gl.viewport(0, 0, 128, 128);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.useProgram(T.prog);
		const size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1;
		const center = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
		const view = mat4.lookAt(mat4.create(), [center[0] - size * 1.1, center[1] - size * 0.9, center[2] - size * 1.4], center, [0, -1, 0]);
		const proj = mat4.perspective(mat4.create(), 0.7, 1, size * 0.1, size * 10);
		gl.uniformMatrix4fv(T.loc('uView'), false, view);
		gl.uniformMatrix4fv(T.loc('uProj'), false, proj);
		gl.uniformMatrix4fv(T.loc('uModel'), false, mat4.create());
		gl.uniformMatrix3fv(T.loc('uNormalMat'), false, new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]));
		gl.uniform3fv(T.loc('uLightDir'), [-0.4, -0.8, -0.45]);
		gl.uniform3fv(T.loc('uAmbient'), [0.45, 0.45, 0.45]);
		gl.uniform3fv(T.loc('uDiffuse'), [0.75, 0.75, 0.75]);
		gl.uniform3fv(T.loc('uEnv'), [1, 1, 1]);
		gl.uniform1i(T.loc('uUseLightmap'), 1);
		gl.uniform4fv(T.loc('uTint'), [0, 0, 0, 0]);
		const made = [];
		for (const m of meshes) {
			const name = model.textures[m.texture];
			const img = name ? await E.assets.image(`data/texture/${decodeName(name).replace(/\\/g, '/')}`) : null;
			const tex = await imageToTexture(gl, img);
			const buf = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, buf);
			gl.bufferData(gl.ARRAY_BUFFER, m.data, gl.STATIC_DRAW);
			const attrs = [['aPosition', 3, 0], ['aNormal', 3, 3], ['aUV', 2, 6], ['aAlpha', 1, 8]];
			for (const [n, sz, off] of attrs) { const l = T.attr(n); if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, sz, gl.FLOAT, false, 36, off * 4); } }
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.drawArrays(gl.TRIANGLES, 0, m.data.length / 9);
			made.push([buf, tex]);
		}
		const blob = await T.canvas.convertToBlob();
		for (const [b, t] of made) { gl.deleteBuffer(b); gl.deleteTexture(t); }
		return URL.createObjectURL(blob);
	}).catch(() => null));
	thumbCache.set(path, p);
	return p;
}

function modelItem(E, path, current, onpick) {
	const img = h('img', { alt: '' });
	const item = h('div.item', { class: `item${current === path ? ' on' : ''}`, title: `${path}\n${english(path)}`, onclick: () => { remember(path); onpick(path); } }, img, h('div', path.split('\\').pop().replace(/\.rsm2?$/i, '')));
	lazyFill(item, () => modelThumb(E, path).then(url => { if (url) img.src = url; else img.style.opacity = 0.2; }));
	return item;
}

export function modelBrowser(E, onpick) {
	const o = E.opts.objects;
	const grid = h('div.grid-list');
	const note = h('p.hint');
	const folder = h('select', { onchange: () => search() }, h('option', { value: '' }, 'All folders'));
	const input = h('input', { placeholder: 'Search models (name or folder)', value: o.query || '', style: { width: '100%' } });
	let all = E._models || null;
	const show = list => {
		grid.replaceChildren(...list.slice(0, 150).map(p => modelItem(E, p, o.model, onpick)));
		note.textContent = list.length > 150 ? `${list.length} models; showing 150 — narrow the search.` : `${list.length} models.`;
	};
	const search = debounce(async () => {
		o.query = input.value;
		if (!all) {
			note.textContent = 'Reading the model list…';
			try { all = E._models = (await post('api/search', { filter: '^data\\\\model\\\\.*\\.rsm2?$' })).map(n => n.replace(/^data\\model\\/i, '')); } catch (e) { note.textContent = e.message; return; }
			const folders = [...new Set(all.map(p => p.split('\\')[0]))].sort();
			folder.append(...folders.map(f => h('option', { value: f }, FOLDER_NAMES[f] ? `${FOLDER_NAMES[f]} (${f})` : f)));
		}
		const q = input.value.trim().toLowerCase();
		const f = folder.value;
		let list = all;
		if (f) list = list.filter(p => p.startsWith(f + '\\'));
		if (q) list = list.filter(p => p.toLowerCase().includes(q) || english(p).toLowerCase().includes(q));
		if (!q && !f) {
			const r = recent();
			if (r.length) { grid.replaceChildren(h('div', { style: { gridColumn: '1/-1' } }, h('b', 'Recently used')), ...r.map(p => modelItem(E, p, o.model, onpick))); note.textContent = `${all.length} models in your client. Search, or pick a folder.`; return; }
		}
		show(list);
	}, 150);
	input.oninput = search;
	search();
	return h('div', input, h('div.row', { style: { margin: '6px 0' } }, folder), note, grid);
}

// ---- Ground textures

export function textureThumb(E, path) {
	const c = h('canvas', { width: 64, height: 64 });
	lazyFill(c, () => E.assets.image(`data/texture/${path.replace(/\\/g, '/')}`).then(img => {
		if (!img) return;
		const g = c.getContext('2d');
		if (img.data) { const t = new OffscreenCanvas(img.width, img.height); t.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0); g.drawImage(t, 0, 0, 64, 64); }
		else g.drawImage(img, 0, 0, 64, 64);
	}));
	return c;
}

export function textureBrowser(E, onpick) {
	const grid = h('div.grid-list');
	const note = h('p.hint');
	const input = h('input', { placeholder: 'Search ground textures', style: { width: '100%' } });
	let all = E._textures || null;
	const search = debounce(async () => {
		if (!all) {
			note.textContent = 'Reading the texture list…';
			try { all = E._textures = (await post('api/search', { filter: '^data\\\\texture\\\\.*\\.(bmp|tga|jpg)$' })).map(n => n.replace(/^data\\texture\\/i, '')).filter(p => !/^(유저인터페이스|effect|이팩트|워터)\\/i.test(p)); } catch (e) { note.textContent = e.message; return; }
		}
		const q = input.value.trim().toLowerCase();
		const list = q ? all.filter(p => p.toLowerCase().includes(q) || english(p).toLowerCase().includes(q)) : all.filter(p => /바닥|ground|floor|grass|tile|field|road|sand|snow|stone|dirt/i.test(p));
		grid.replaceChildren(...list.slice(0, 120).map(p => h('div.item', { title: `${p}\n${english(p)}`, onclick: () => onpick(p) }, textureThumb(E, p), h('div', p.split('\\').pop()))));
		note.textContent = `${list.length} textures${list.length > 120 ? '; showing 120' : ''}${q ? '' : ' that look like ground — search for anything else'}.`;
	}, 150);
	input.oninput = search;
	search();
	return h('div', input, note, grid);
}

// ---- NPC sprites

const spriteCache = new Map();
export function spriteImage(E, folder, name, dir = 4) {
	const key = `${folder}/${name}/${dir}`;
	if (!spriteCache.has(key)) {
		const base = `data/sprite/${folder}/${String(name).toLowerCase()}`;
		spriteCache.set(key, Promise.all([E.assets.file(`${base}.spr`), E.assets.file(`${base}.act`)]).then(([s, a]) => {
			if (!s || !a) return null;
			const img = renderSprite(readSpr(s), readAct(a), 0, dir);
			if (!img) return null;
			const c = new OffscreenCanvas(img.width, img.height);
			c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
			return c;
		}).catch(() => null));
	}
	return spriteCache.get(key);
}

function spriteCanvas(E, folder, name, dir) {
	const c = h('canvas', { width: 72, height: 72 });
	lazyFill(c, () => spriteImage(E, folder, name, dir).then(img => {
		if (!img) return;
		const g = c.getContext('2d');
		const s = Math.min(1.6, 66 / Math.max(img.width, img.height));
		g.imageSmoothingEnabled = false;
		g.drawImage(img, (72 - img.width * s) / 2, 70 - img.height * s, img.width * s, img.height * s);
	}));
	return c;
}

export function spriteGrid(E, current, onpick) {
	const grid = h('div.grid-list');
	const input = h('input', { placeholder: 'Search NPC sprites (KAFRA, 4_M_, MERCHANT…)', style: { width: '100%' } });
	const note = h('p.hint');
	const search = debounce(() => {
		const all = E.tables.npcs || [];
		const q = input.value.trim().toLowerCase();
		const list = q ? all.filter(s => s.name.toLowerCase().includes(q) || String(s.id) === q) : all.filter(s => /^4_|KAFRA|MERCHANT|^1_/i.test(s.name));
		grid.replaceChildren(...list.slice(0, 90).map(s => h('div.item', { class: `item${String(current) === s.name ? ' on' : ''}`, title: `${s.name}${s.id ? ` (${s.id})` : ''}`, onclick: () => onpick(s.name) }, spriteCanvas(E, 'npc', s.name, 4), h('div', s.name))));
		note.textContent = all.length ? `${list.length} of ${all.length} sprites.` : (E.tables.npcsError || 'Loading the client\'s NPC sprites…');
	}, 150);
	input.oninput = search;
	search();
	if (!(E.tables.npcs || []).length) setTimeout(search, 1500);
	return h('div', input, note, grid);
}

// ---- Monsters

export function mobPicker(E, current, onpick) {
	const mobs = E.tables.mobs || [];
	const find = v => mobs.find(m => m.id === Number(v) || m.aegis.toUpperCase() === String(v).toUpperCase());
	const cur = find(current);
	const pic = h('canvas', { width: 72, height: 72, style: { width: '56px', height: '56px', flex: 'none', background: 'var(--code)', borderRadius: '6px' } });
	if (cur) spriteImage(E, '몬스터', cur.sprite || cur.aegis, 4).then(img => { if (!img) return; const g = pic.getContext('2d'); const s = Math.min(2, 68 / Math.max(img.width, img.height)); g.imageSmoothingEnabled = false; g.drawImage(img, (72 - img.width * s) / 2, 70 - img.height * s, img.width * s, img.height * s); });
	const input = h('input', { placeholder: 'Search monsters by name, AegisName or id', style: { width: '100%' } });
	const results = h('div.list', { style: { maxHeight: '180px' } });
	input.oninput = debounce(() => {
		const q = input.value.trim().toLowerCase();
		results.replaceChildren(...(q ? mobs.filter(m => String(m.id) === q || m.name.toLowerCase().includes(q) || m.aegis.toLowerCase().includes(q)).slice(0, 40) : []).map(m => h('div.li', { onclick: () => onpick(m.id) }, `${m.name}${m.mvp ? ' ★' : ''}`, h('small', `${m.aegis} · ${m.id} · lv ${m.level}`))));
	}, 120);
	return h('div', h('div.row', pic, h('div', h('b', cur ? cur.name : String(current)), h('br'), h('span.muted', cur ? `${cur.aegis} · id ${cur.id} · level ${cur.level}` : (mobs.length ? 'not a monster this server has' : 'loading the monster list…')))), input, results);
}

// ---- Music

let audio = null;
function play(file, button) {
	if (audio && audio.dataset.file === file && !audio.paused) { audio.pause(); button.textContent = '▶'; return; }
	if (audio) audio.pause();
	for (const b of document.querySelectorAll('.bgm-row .play')) b.textContent = '▶';
	audio = new Audio(assetUrl(`BGM/${file}`));
	audio.dataset.file = file;
	audio.volume = 0.6;
	audio.play().then(() => { button.textContent = '■'; }).catch(() => { button.textContent = '✕'; button.title = 'This track is not in your client\'s BGM folder or the mod.'; });
	audio.onended = () => { button.textContent = '▶'; };
}

export function bgmBrowser(E, current, onpick, { tall = false } = {}) {
	const list = h('div.list', { style: { maxHeight: tall ? 'none' : '220px' } }, h('div.li.muted', 'Loading the music…'));
	const input = h('input', { placeholder: 'Search tracks or the maps that play them', style: { width: '100%' } });
	const names = new Map((E.tables.maps || []).map(m => [m.map, m.name]));
	let tracks = E._bgm || null;
	const paint = () => {
		const q = input.value.trim().toLowerCase();
		const rows = (tracks || []).filter(t => !q || t.file.toLowerCase().includes(q) || t.maps.some(m => m.includes(q) || (names.get(m) || '').toLowerCase().includes(q)));
		list.replaceChildren(...rows.slice(0, 200).map(t => {
			const btn = h('button.btn.small.play', { title: 'Listen', onclick: e => { e.stopPropagation(); play(t.file, btn); } }, '▶');
			return h('div.li.bgm-row', { class: `li bgm-row${current === t.file ? ' on' : ''}`, onclick: () => onpick(t.file) }, btn, h('span', t.file), h('small', { title: t.maps.join(', ') }, t.mod ? `mod ${t.mod}` : shownNames(t.maps, names)));
		}));
	};
	input.oninput = debounce(paint, 120);
	(tracks ? Promise.resolve(tracks) : get('api/bgm')).then(t => { tracks = E._bgm = t; paint(); }).catch(e => list.replaceChildren(h('div.li.muted', e.message)));
	return h('div', h('p', current ? ['Playing ', h('b', current), ' ', h('button.btn.small', { onclick: () => onpick(null) }, 'none')] : h('span.muted', 'The client\'s default track (01.mp3).')), input, list, h('p.hint', 'A track used by official maps is listed with them (mp3nametable.txt). Ship your own in the mod\'s BGM/ folder and it shows up here.'));
}

/** A track's maps by their display names, each name once. */
function shownNames(maps, names) {
	const all = [...new Set(maps.map(m => names.get(m) || m))];
	return all.slice(0, 4).join(', ') + (all.length > 4 ? ` +${all.length - 4}` : '');
}

// ---- Sounds

export function soundBrowser(E, onpick) {
	const list = h('div.list', { style: { maxHeight: '240px' } });
	const input = h('input', { placeholder: 'Search sounds (water, wind, bird…)', style: { width: '100%' } });
	let all = E._wav || null;
	const paint = debounce(async () => {
		if (!all) { try { all = E._wav = (await post('api/search', { filter: '^data\\\\wav\\\\.*\\.wav$' })).map(n => n.replace(/^data\\wav\\/i, '')); } catch (e) { list.replaceChildren(h('div.li', e.message)); return; } }
		const q = input.value.trim().toLowerCase();
		const rows = all.filter(f => !q || f.toLowerCase().includes(q)).slice(0, 150);
		list.replaceChildren(...rows.map(f => {
			const b = h('button.btn.small.play', { onclick: e => { e.stopPropagation(); new Audio(assetUrl(`data/wav/${f.replace(/\\/g, '/')}`)).play().catch(() => {}); } }, '▶');
			return h('div.li', { class: `li${E.opts.objects.sound === f ? ' on' : ''}`, onclick: () => onpick(f) }, b, f);
		}));
	}, 150);
	input.oninput = paint;
	paint();
	return h('div', input, list);
}
