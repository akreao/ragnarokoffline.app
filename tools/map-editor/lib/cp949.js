// CP949 (EUC-KR) file names.
//
// Every path inside a map file -- a ground texture, a model, a sound -- is
// CP949 bytes, and most official ones are Korean. The asset server is asked for
// them as Korean text (UTF-8 in the URL), and its search answers with Korean
// text. So a name read from a file is decoded to show and to fetch, and a name
// picked from the browser is encoded back before it is written.
//
// TextDecoder knows EUC-KR in browsers and Node; nothing encodes it, so the
// encoder is built once by decoding every double-byte sequence.

let decoder = null;
function korean() {
	if (!decoder) decoder = new TextDecoder('euc-kr');
	return decoder;
}

/** A binary string (one char per byte) as text. ASCII stays as it is. */
export function decodeName(binary) {
	if (!/[\x80-\xff]/.test(binary)) return binary;
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
	return korean().decode(bytes);
}

let table = null;
function encoderTable() {
	if (table) return table;
	table = new Map();
	const dec = korean();
	const pair = new Uint8Array(2);
	for (let lead = 0x81; lead <= 0xfe; lead++) {
		for (let trail = 0x41; trail <= 0xfe; trail++) {
			pair[0] = lead; pair[1] = trail;
			const ch = dec.decode(pair);
			if (ch.length === 1 && ch !== '�' && !table.has(ch)) table.set(ch, String.fromCharCode(lead, trail));
		}
	}
	return table;
}

/**
 * Text as a binary string of CP949 bytes. Throws on a character CP949 cannot
 * hold, rather than writing a name the client would never find.
 */
export function encodeName(text) {
	if (!/[^\x00-\x7f]/.test(text)) return text;
	const t = encoderTable();
	let out = '';
	for (const ch of text) {
		if (ch.charCodeAt(0) < 0x80) { out += ch; continue; }
		const bytes = t.get(ch);
		if (!bytes) throw new Error(`"${ch}" in "${text}" has no CP949 spelling`);
		out += bytes;
	}
	return out;
}

/**
 * A client path as the asset server is asked for it: Korean as text,
 * forward slashes, each part URL-encoded. `name` is text (already decoded).
 */
export function assetUrl(base, name) {
	const parts = name.replace(/\\/g, '/').split('/').filter(Boolean);
	return `${base.replace(/\/$/, '')}/${parts.map(encodeURIComponent).join('/')}`;
}
