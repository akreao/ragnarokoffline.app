// Talking to whatever serves the page: the app (ro-tool://map-editor/) or
// `ragnarok-map serve` (http://127.0.0.1:<port>/). Both answer the same
// routes (server/bridge.js); the CLI's server wants its page token on every
// call that is not a plain file read.

import { decodeImage } from '../lib/image.js';

const HOST = window.MAP_EDITOR_HOST || { name: 'app' };

function headers(extra = {}) {
	return HOST.token ? { ...extra, 'x-map-editor': HOST.token } : extra;
}

export async function get(route) {
	const res = await fetch(route, { headers: headers(), cache: 'no-store' });
	const body = await res.json().catch(() => null);
	if (!res.ok || (body && body.error)) throw new Error((body && body.error) || `${route}: ${res.status}`);
	return body;
}

export async function post(route, data) {
	const res = await fetch(route, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(data ?? {}) });
	const body = await res.json().catch(() => null);
	if (!res.ok || (body && body.error)) throw new Error((body && body.error) || `${route}: ${res.status}`);
	return body;
}

export const hostName = HOST.name;

/** A client file's URL, from its path as text ("data/texture/워터/water000.jpg"). */
export function assetUrl(path) {
	return 'asset/' + String(path).replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

/**
 * The renderer's view of the client's files: bytes, and pictures (BMP and
 * TGA decoded here, magenta made transparent; JPEG and PNG by the browser).
 */
export function createAssets() {
	const files = new Map();
	const images = new Map();
	const assets = {
		file(path) {
			const key = path.toLowerCase();
			if (!files.has(key)) {
				files.set(key, fetch(assetUrl(path), { headers: headers() }).then(r => (r.ok ? r.arrayBuffer().then(b => new Uint8Array(b)) : null)).catch(() => null));
			}
			return files.get(key);
		},
		image(path) {
			const key = path.toLowerCase();
			if (!images.has(key)) {
				images.set(key, assets.file(path).then(async bytes => {
					if (!bytes) return null;
					const decoded = (() => { try { return decodeImage(bytes, path); } catch { return null; } })();
					if (decoded) return decoded;
					try { return await createImageBitmap(new Blob([bytes])); } catch { return null; }
				}));
			}
			return images.get(key);
		},
		async exists(path) { return !!(await assets.file(path)); },
		forget(prefix) {
			for (const k of [...files.keys()]) if (!prefix || k.startsWith(prefix.toLowerCase())) files.delete(k);
			for (const k of [...images.keys()]) if (!prefix || k.startsWith(prefix.toLowerCase())) images.delete(k);
		},
	};
	return assets;
}
