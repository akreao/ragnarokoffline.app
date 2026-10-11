// The gameplay layer drawn on the map: NPCs as their sprites, warps and
// spawn areas on the ground, monsters as their sprites, signs, lights,
// sounds, effects and the test start point as icons.

import { readSpr, readAct, renderSprite } from '../lib/sprite.js';
import { displayName } from '../lib/script.js';
import { decodeName } from '../lib/cp949.js';
import { lightColor } from '../lib/rsw.js';

const ICONS = {
	warp: { glyph: '⟳', bg: '#2f7bff' },
	light: { glyph: '✦', bg: '#f5b400' },
	sound: { glyph: '♪', bg: '#8a5cf6' },
	effect: { glyph: '✸', bg: '#ef4444' },
	sign: { glyph: '!', bg: '#10b981' },
	start: { glyph: '▶', bg: '#16a34a' },
	npc: { glyph: '☺', bg: '#64748b' },
	mob: { glyph: '✕', bg: '#b91c1c' },
	hidden: { glyph: '◌', bg: '#475569' },
};

function drawIcon(kind) {
	const c = new OffscreenCanvas(28, 34);
	const g = c.getContext('2d');
	const icon = ICONS[kind] || ICONS.npc;
	g.fillStyle = 'rgba(0,0,0,0.35)';
	g.beginPath(); g.ellipse(14, 31, 6, 2.5, 0, 0, Math.PI * 2); g.fill();
	g.fillStyle = icon.bg;
	g.beginPath(); g.arc(14, 13, 11, 0, Math.PI * 2); g.fill();
	g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
	g.beginPath(); g.moveTo(10, 22); g.lineTo(14, 30); g.lineTo(18, 22); g.fill();
	g.fillStyle = '#fff'; g.font = 'bold 14px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
	g.fillText(icon.glyph, 14, 14);
	const img = g.getImageData(0, 0, 28, 34);
	return { width: 28, height: 34, data: img.data, originX: 14, originY: 32 };
}

export class Markers {
	constructor(renderer, assets, tables) {
		this.r = renderer;
		this.assets = assets;
		this.tables = tables; // { sprites: {id: name}, mobs: [...] }
		this.loading = new Map();
		for (const kind of Object.keys(ICONS)) renderer.setSprite(`icon:${kind}`, drawIcon(kind));
	}

	spriteName(sprite) {
		const s = String(sprite ?? '').trim();
		if (/^-?\d+$/.test(s)) {
			const n = Number(s);
			if (n < 0 || n === 111 || n === 139) return null; // hidden NPCs
			return (this.tables.sprites && this.tables.sprites[n]) || null;
		}
		if (!s || s === '-' || /^HIDDEN/i.test(s) || /^FAKE_NPC$/i.test(s)) return null;
		return s;
	}

	/** Load a sprite into the renderer under `key`; folder is npc or 몬스터. */
	loadSprite(key, folder, name, dir) {
		if (this.r.sprites.has(key) || this.loading.has(key)) return;
		const base = `data/sprite/${folder}/${name.toLowerCase()}`;
		const p = Promise.all([this.assets.file(base + '.spr'), this.assets.file(base + '.act')]).then(([spr, act]) => {
			if (!spr || !act) return;
			try {
				const img = renderSprite(readSpr(spr), readAct(act), 0, dir);
				if (img) this.r.setSprite(key, img);
			} catch { /* a sprite we cannot read keeps its icon */ }
		});
		this.loading.set(key, p);
	}

	mobSprite(mob) {
		const mobs = this.tables.mobs || [];
		const m = typeof mob === 'number' ? mobs.find(x => x.id === mob) : mobs.find(x => x.aegis.toUpperCase() === String(mob).toUpperCase());
		return m ? { name: m.sprite || m.aegis, label: m.name, id: m.id } : { name: String(mob), label: String(mob), id: mob };
	}

	/** Rebuild the renderer's marker list from the map. */
	build(doc, show = { objects: true }) {
		const out = [];
		const ground = (x, y) => this.r.groundAt(x + 0.5, y + 0.5);
		for (const n of doc.gameplay.npcs) {
			const name = this.spriteName(n.sprite);
			let sprite = name ? `npc:${name}:${n.dir | 0}` : 'icon:hidden';
			if (name) this.loadSprite(sprite, 'npc', name, n.dir | 0);
			if (name && !this.r.sprites.has(sprite)) sprite = 'icon:npc';
			out.push({ key: `npc:${n.id}`, kind: 'npc', id: n.id, x: n.x, y: n.y, z: ground(n.x, n.y), sprite, label: displayName(n.name) + (n.handwritten ? ' ✎' : ''), color: [0.6, 0.7, 1, 1], area: n.touch ? { x0: n.x - n.touch.xs, y0: n.y - n.touch.ys, x1: n.x + n.touch.xs + 1, y1: n.y + n.touch.ys + 1 } : null });
		}
		for (const w of doc.gameplay.warps) {
			out.push({ key: `warp:${w.id}`, kind: 'warp', id: w.id, x: w.x, y: w.y, z: ground(w.x, w.y), sprite: 'icon:warp', label: `→ ${w.dest.map} ${w.dest.x},${w.dest.y}`, color: [0.2, 0.55, 1, 1], area: { x0: w.x - w.xs, y0: w.y - w.ys, x1: w.x + w.xs + 1, y1: w.y + w.ys + 1 } });
		}
		for (const s of doc.gameplay.spawns) {
			const anywhere = s.x === 0 && s.y === 0 && s.xs === 0 && s.ys === 0;
			const mob = this.mobSprite(s.mob);
			let sprite = `mob:${mob.name}`;
			this.loadSprite(sprite, '몬스터', mob.name, 4);
			if (!this.r.sprites.has(sprite)) sprite = 'icon:mob';
			const cx = anywhere ? doc.gat.width / 2 : s.x, cy = anywhere ? doc.gat.height / 2 : s.y;
			out.push({ key: `spawn:${s.id}`, kind: 'spawn', id: s.id, x: cx, y: cy, z: ground(cx, cy), sprite, label: `${mob.label} ×${s.amount}${anywhere ? ' (anywhere)' : ''}`, color: [1, 0.3, 0.3, 1], area: anywhere ? null : { x0: s.x - s.xs, y0: s.y - s.ys, x1: s.x + s.xs + 1, y1: s.y + s.ys + 1 } });
		}
		for (const [i, s] of doc.gameplay.signboards.entries()) {
			out.push({ key: `sign:${i}`, kind: 'sign', id: i, x: s.x, y: s.y, z: ground(s.x, s.y) - 3.2, sprite: 'icon:sign', label: s.caption || s.icon.split('\\').pop(), color: [0.1, 0.8, 0.5, 1] });
		}
		if (doc.testPoint) out.push({ key: 'start', kind: 'start', id: 'start', x: doc.testPoint.x, y: doc.testPoint.y, z: ground(doc.testPoint.x, doc.testPoint.y), sprite: 'icon:start', label: 'Test start', color: [0.1, 0.8, 0.3, 1] });
		if (show.objects) {
			const g = doc.gnd;
			doc.rsw.objects.forEach((o, index) => {
				if (o.type === 1) return;
				const kind = o.type === 2 ? 'light' : o.type === 3 ? 'sound' : 'effect';
				const x = o.position[0] / 5 + g.width - 0.5, y = o.position[2] / 5 + g.height - 0.5;
				out.push({ key: index, kind, index, x, y, z: o.position[1] / 5, sprite: `icon:${kind}`, label: kind === 'effect' ? `effect ${o.id}` : kind === 'sound' ? decodeName(o.file) : decodeName(o.name || 'light'), color: kind === 'light' ? [...lightColor(o), 1] : [1, 1, 1, 1], scale: 0.8 });
			});
		}
		this.r.markers = out;
		return out;
	}

	/** Once sprites arrive, rebuild so markers pick them up. */
	whenLoaded(fn) {
		const pending = [...this.loading.values()];
		this.loading.clear();
		if (pending.length) Promise.allSettled(pending).then(fn);
	}
}

/** Names over markers, drawn on the 2D canvas above the view. */
export function drawLabels(canvas, renderer, { selection, hover }) {
	const dpr = Math.min(2, devicePixelRatio || 1);
	const w = canvas.clientWidth, h = canvas.clientHeight;
	if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
	const g = canvas.getContext('2d');
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, w, h);
	if (!renderer.show.markers) return;
	g.font = '11px -apple-system, "Segoe UI", sans-serif';
	g.textAlign = 'center';
	const far = renderer.camera.distance > 220;
	for (const m of renderer.markers) {
		const important = selection.has(m.key) || (hover && hover.key === m.key);
		if (far && !important && m.kind !== 'warp' && m.kind !== 'npc') continue;
		// Lights, sounds, effects and signs only say what they are when pointed at.
		if ((typeof m.key === 'number' || m.kind === 'sign') && !important) continue;
		const s = m.sprite && renderer.sprites.get(m.sprite);
		const height = s ? (s.height / 35) * (m.scale || 1) : 1;
		const p = renderer.project([m.x + 0.5, m.z - height - 0.3, m.y + 0.5]);
		if (!p || p.x < -50 || p.y < -20 || p.x > w + 50 || p.y > h + 20) continue;
		const text = m.label || '';
		if (!text) continue;
		const tw = g.measureText(text).width + 8;
		g.fillStyle = important ? 'rgba(255,190,40,0.92)' : 'rgba(0,0,0,0.55)';
		g.beginPath();
		g.roundRect(p.x - tw / 2, p.y - 15, tw, 15, 4);
		g.fill();
		g.fillStyle = important ? '#111' : '#fff';
		g.fillText(text, p.x, p.y - 4);
	}
}
