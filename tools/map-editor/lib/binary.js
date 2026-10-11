// Little-endian readers and writers for the map formats.
//
// Strings in RO files are fixed-width, NUL-padded CP949 bytes. They are kept
// here as "binary strings" -- one char per byte, 0..255 -- exactly as
// roBrowser's BinaryReader keeps them, so a name read and written back is the
// same bytes whatever its encoding. cp949.js turns one into text for showing.

export class Reader {
	constructor(buffer) {
		const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
		this.u8 = u8;
		this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
		this.offset = 0;
		this.length = u8.byteLength;
	}
	get remaining() { return this.length - this.offset; }
	need(n) {
		if (this.offset + n > this.length) throw new Error(`unexpected end of file at byte ${this.offset} (wanted ${n} more)`);
	}
	u8v() { this.need(1); return this.view.getUint8(this.offset++); }
	i8() { this.need(1); return this.view.getInt8(this.offset++); }
	u16() { this.need(2); const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
	i16() { this.need(2); const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
	u32() { this.need(4); const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
	i32() { this.need(4); const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
	f32() { this.need(4); const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
	/** A fixed-width string, cut at the first NUL. */
	str(n) {
		this.need(n);
		let s = '';
		for (let i = 0; i < n; i++) {
			const c = this.u8[this.offset + i];
			if (c === 0) break;
			s += String.fromCharCode(c);
		}
		this.offset += n;
		return s;
	}
	/** A fixed-width field kept whole, padding included, for byte-exact rewrites. */
	field(n) {
		this.need(n);
		const raw = this.u8.slice(this.offset, this.offset + n);
		this.offset += n;
		return raw;
	}
	bytes(n) {
		this.need(n);
		const out = this.u8.slice(this.offset, this.offset + n);
		this.offset += n;
		return out;
	}
	f32s(n) {
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) out[i] = this.f32();
		return out;
	}
}

export class Writer {
	constructor(size = 1 << 16) {
		this.u8 = new Uint8Array(size);
		this.view = new DataView(this.u8.buffer);
		this.offset = 0;
	}
	grow(n) {
		if (this.offset + n <= this.u8.length) return;
		let size = this.u8.length * 2;
		while (size < this.offset + n) size *= 2;
		const next = new Uint8Array(size);
		next.set(this.u8.subarray(0, this.offset));
		this.u8 = next;
		this.view = new DataView(next.buffer);
	}
	u8v(v) { this.grow(1); this.view.setUint8(this.offset++, v); return this; }
	i8(v) { this.grow(1); this.view.setInt8(this.offset++, v); return this; }
	u16(v) { this.grow(2); this.view.setUint16(this.offset, v, true); this.offset += 2; return this; }
	i16(v) { this.grow(2); this.view.setInt16(this.offset, v, true); this.offset += 2; return this; }
	u32(v) { this.grow(4); this.view.setUint32(this.offset, v >>> 0, true); this.offset += 4; return this; }
	i32(v) { this.grow(4); this.view.setInt32(this.offset, v | 0, true); this.offset += 4; return this; }
	f32(v) { this.grow(4); this.view.setFloat32(this.offset, v, true); this.offset += 4; return this; }
	f32s(list) { for (const v of list) this.f32(v); return this; }
	bytes(u8) { this.grow(u8.length); this.u8.set(u8, this.offset); this.offset += u8.length; return this; }
	/**
	 * A fixed-width string. `raw` is the field as it was read: when the text
	 * is unchanged its padding is kept, so a rewrite is byte for byte the
	 * original (official files carry leftover bytes after the NUL).
	 */
	str(s, n, raw) {
		this.grow(n);
		if (raw && raw.length === n && fieldText(raw) === s) {
			this.u8.set(raw, this.offset);
		} else {
			if (s.length > n) throw new Error(`"${s}" is longer than its ${n}-byte field`);
			for (let i = 0; i < n; i++) this.u8[this.offset + i] = i < s.length ? s.charCodeAt(i) & 0xff : 0;
		}
		this.offset += n;
		return this;
	}
	result() { return this.u8.slice(0, this.offset); }
}

/** A raw fixed-width field's text, as Reader.str reads it. */
export function fieldText(raw) {
	let s = '';
	for (const c of raw) {
		if (c === 0) break;
		s += String.fromCharCode(c);
	}
	return s;
}

export function equalBytes(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Base64 for Uint8Arrays, in browsers and Node alike. */
export function toBase64(u8) {
	if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
	let s = '';
	for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
	return btoa(s);
}

export function fromBase64(text) {
	if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
	const s = atob(text);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}
