// The music browser on its own (#414): the map editor's list of tracks, for
// anyone picking music for a mod. Choosing one shows the line for mod.json.

import { get, createAssets } from './host.js';
import { bgmBrowser } from './browsers.js';
import { h } from './dom.js';

const E = { assets: createAssets(), tables: {}, opts: {} };
const root = document.getElementById('music');

async function paint(current = null) {
	const snippet = h('div.snippet');
	if (current) snippet.append(h('p', 'In your mod\'s mod.json, under "maps" and the map\'s name:'), h('div.code', `"bgm": "${current}"`));
	root.replaceChildren(bgmBrowser(E, current, file => paint(file), { tall: true }), snippet);
}

get('api/maps').then(maps => { E.tables.maps = maps; paint(); }).catch(() => paint());
