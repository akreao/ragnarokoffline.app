// A tiny DOM builder for the panels: h('div.sec', {onclick}, children...).

export function h(spec, attrs, ...children) {
	if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { children.unshift(attrs); attrs = {}; }
	const [tag, ...classes] = spec.split('.');
	const [name, id] = tag.split('#');
	const el = document.createElement(name || 'div');
	if (id) el.id = id;
	if (classes.length) el.className = classes.join(' ');
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
		else if (k === 'value') el.value = v;
		else if (k === 'checked') el.checked = !!v;
		else if (k === 'html') el.innerHTML = v;
		else el.setAttribute(k, v === true ? '' : v);
	}
	for (const c of children.flat(Infinity)) {
		if (c === null || c === undefined || c === false) continue;
		el.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return el;
}

/** A labelled row. */
export const field = (label, ...control) => h('div.field', h('label', label), ...control);

/** A segmented choice: options [[value, label, title]], current, onpick. */
export function seg(options, current, onpick) {
	return h('div.seg', options.map(([value, label, title]) => h('button', { type: 'button', class: value === current ? 'on' : '', title: title || '', onclick: () => onpick(value) }, label)));
}

/** A slider with its value beside it. */
export function slider(value, min, max, step, oninput, fmt = v => v) {
	const val = h('span.val', fmt(value));
	const input = h('input', { type: 'range', min, max, step, value, oninput: e => { val.textContent = fmt(Number(e.target.value)); oninput(Number(e.target.value), false); }, onchange: e => oninput(Number(e.target.value), true) });
	return [input, val];
}

export const rgbToHex = c => '#' + c.slice(0, 3).map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
export const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

export function debounce(fn, ms = 200) {
	let t = 0;
	return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
