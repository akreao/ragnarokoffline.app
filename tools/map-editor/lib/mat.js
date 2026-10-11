// The few matrix and vector helpers the editor needs, column-major like
// gl-matrix (which roBrowser uses), with roBrowser's own additions
// (rotateQuat, extractRotation, calcNormal) behaving as theirs do, so models
// come out shaped the same.

export const mat4 = {
	create() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
	identity(m) { m.fill(0); m[0] = m[5] = m[10] = m[15] = 1; return m; },
	clone(a) { return new Float32Array(a); },
	copy(out, a) { out.set(a); return out; },
	multiply(out, a, b) {
		const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
		const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
		for (let i = 0; i < 4; i++) {
			const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
			out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
			out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
			out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
			out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
		}
		return out;
	},
	translate(out, a, v) {
		const [x, y, z] = v;
		if (out !== a) out.set(a);
		out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
		out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
		out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
		out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
		return out;
	},
	scale(out, a, v) {
		const [x, y, z] = v;
		for (let i = 0; i < 4; i++) { out[i] = a[i] * x; out[4 + i] = a[4 + i] * y; out[8 + i] = a[8 + i] * z; out[12 + i] = a[12 + i]; }
		return out;
	},
	rotate(out, a, rad, axis) {
		let [x, y, z] = axis;
		let len = Math.hypot(x, y, z);
		if (len < 1e-6) { if (out !== a) out.set(a); return out; }
		x /= len; y /= len; z /= len;
		const s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;
		const r = [x * x * t + c, y * x * t + z * s, z * x * t - y * s, 0, x * y * t - z * s, y * y * t + c, z * y * t + x * s, 0, x * z * t + y * s, y * z * t - x * s, z * z * t + c, 0, 0, 0, 0, 1];
		return mat4.multiply(out, a, r);
	},
	rotateX(out, a, rad) { return mat4.rotate(out, a, rad, [1, 0, 0]); },
	rotateY(out, a, rad) { return mat4.rotate(out, a, rad, [0, 1, 0]); },
	rotateZ(out, a, rad) { return mat4.rotate(out, a, rad, [0, 0, 1]); },
	/** roBrowser's rotateQuat: multiply by the (normalised) quaternion's matrix. */
	rotateQuat(out, a, q) {
		let [qa, qb, qc, qd] = q;
		const n = Math.sqrt(qa * qa + qb * qb + qc * qc + qd * qd) || 1;
		qa /= n; qb /= n; qc /= n; qd /= n;
		return mat4.multiply(out, a, [
			1 - 2 * (qb * qb + qc * qc), 2 * (qa * qb + qc * qd), 2 * (qa * qc - qb * qd), 0,
			2 * (qa * qb - qc * qd), 1 - 2 * (qa * qa + qc * qc), 2 * (qc * qb + qa * qd), 0,
			2 * (qa * qc + qb * qd), 2 * (qb * qc - qa * qd), 1 - 2 * (qa * qa + qb * qb), 0,
			0, 0, 0, 1,
		]);
	},
	/** A mat3 (9 numbers, column-major) as a mat4. */
	fromMat3(m3) {
		return new Float32Array([m3[0], m3[1], m3[2], 0, m3[3], m3[4], m3[5], 0, m3[6], m3[7], m3[8], 0, 0, 0, 0, 1]);
	},
	/** roBrowser's extractRotation: the upper 3x3 with each column normalised. */
	extractRotation(out, m) {
		const sx = 1 / Math.hypot(m[0], m[1], m[2]), sy = 1 / Math.hypot(m[4], m[5], m[6]), sz = 1 / Math.hypot(m[8], m[9], m[10]);
		out[0] = m[0] * sx; out[1] = m[1] * sx; out[2] = m[2] * sx;
		out[4] = m[4] * sy; out[5] = m[5] * sy; out[6] = m[6] * sy;
		out[8] = m[8] * sz; out[9] = m[9] * sz; out[10] = m[10] * sz;
		return out;
	},
	invert(out, a) {
		const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
		const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
		const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
		const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
		const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
		let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
		if (!det) return null;
		det = 1 / det;
		out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
		out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
		out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
		out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
		out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
		out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
		out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
		out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
		return out;
	},
	perspective(out, fovyRad, aspect, near, far) {
		const f = 1 / Math.tan(fovyRad / 2), nf = 1 / (near - far);
		out.fill(0);
		out[0] = f / aspect; out[5] = f; out[10] = (far + near) * nf; out[11] = -1; out[14] = 2 * far * near * nf;
		return out;
	},
	ortho(out, l, r, b, t, n, f) {
		out.fill(0);
		out[0] = 2 / (r - l); out[5] = 2 / (t - b); out[10] = -2 / (f - n);
		out[12] = -(r + l) / (r - l); out[13] = -(t + b) / (t - b); out[14] = -(f + n) / (f - n); out[15] = 1;
		return out;
	},
	lookAt(out, eye, center, up) {
		let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
		let len = Math.hypot(z0, z1, z2) || 1; z0 /= len; z1 /= len; z2 /= len;
		let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
		len = Math.hypot(x0, x1, x2) || 1; x0 /= len; x1 /= len; x2 /= len;
		const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
		out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
		out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
		out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
		out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
		out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
		out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
		out[15] = 1;
		return out;
	},
	transformPoint(m, p) {
		const [x, y, z] = p;
		const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
		return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
	},
	transformDir(m, d) {
		const [x, y, z] = d;
		return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
	},
};

export const vec3 = {
	sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
	add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
	scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
	dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
	cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
	length: a => Math.hypot(a[0], a[1], a[2]),
	normalize(a) { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; },
	/** roBrowser's vec3.calcNormal: normalize((c - b) x (a - b)). */
	calcNormal(a, b, c) {
		const x1 = c[0] - b[0], y1 = c[1] - b[1], z1 = c[2] - b[2];
		const x2 = a[0] - b[0], y2 = a[1] - b[1], z2 = a[2] - b[2];
		return vec3.normalize([y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2]);
	},
};
