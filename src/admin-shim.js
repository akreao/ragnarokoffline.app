// The Settings window's bridge, over HTTP, for a headless app's admin page.
//
// settings.html calls window.__ELECTRON__.core.invoke and .dialog.open/save,
// which in the app reach main.js over IPC (electron/preload.js). Served by a
// headless app (electron/headless/admin-server.js), the same calls go to
// /admin/api/invoke instead, and land on the same handlers.
//
// A handler that asks a question -- install this mod?, which file? -- has no
// screen to ask it on, so the app files it (electron/headless/remote-dialogs.js)
// and this page shows it, while any call is in flight. A file question takes a
// path on the host's machine, or a file uploaded from this one.
(function () {
	'use strict';

	const post = async (url, body, headers = {}) => {
		const r = await fetch(url, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'X-RO-Admin': '1', ...headers },
			body,
		});
		if (r.status === 401) throw new Error('Signed out: open the address the app printed when it started.');
		if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
		return r.json();
	};

	let info = null;
	const getInfo = async () => {
		if (!info) info = await (await fetch('/admin/api/info', { credentials: 'same-origin' })).json();
		return info;
	};

	// --- questions from the app ------------------------------------------------

	const shown = new Set();

	function modal(build) {
		const back = document.createElement('div');
		back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center';
		const box = document.createElement('div');
		box.style.cssText = 'background:#1d2130;color:#e8eaf0;max-width:560px;width:90%;padding:18px 20px;border-radius:8px;font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 40px rgba(0,0,0,.5)';
		back.appendChild(box);
		document.body.appendChild(back);
		build(box, () => back.remove());
	}

	function text(box, tag, value, style) {
		if (!value) return;
		const el = document.createElement(tag);
		el.textContent = value;
		if (style) el.style.cssText = style;
		box.appendChild(el);
	}

	function button(row, label, onClick, primary) {
		const b = document.createElement('button');
		b.textContent = label;
		b.style.cssText = `margin:4px 6px 0 0;padding:6px 14px;border-radius:5px;border:1px solid #556;cursor:pointer;${primary ? 'background:#e8b84b;color:#111;border-color:#e8b84b' : 'background:#2a3042;color:#e8eaf0'}`;
		b.onclick = onClick;
		row.appendChild(b);
		return b;
	}

	function show(q) {
		shown.add(q.id);
		const o = q.options || {};
		const answer = async value => {
			try {
				await post('/admin/api/answer', JSON.stringify({ id: q.id, value }), { 'Content-Type': 'application/json' });
			} finally {
				shown.delete(q.id);
			}
		};
		modal((box, close) => {
			text(box, 'div', o.title || o.message || (q.kind === 'save' ? 'Save to…' : q.kind === 'open' ? 'Choose a file' : ''), 'font-weight:600;margin-bottom:6px');
			if (o.title && o.message) text(box, 'div', o.message, 'margin-bottom:6px');
			text(box, 'pre', o.detail, 'white-space:pre-wrap;font:13px/1.45 system-ui,sans-serif;color:#b8bdcc;margin:0 0 10px;max-height:45vh;overflow:auto');
			const row = document.createElement('div');

			if (q.kind === 'message') {
				(o.buttons || ['OK']).forEach((label, i) => {
					button(row, label, () => { close(); answer(i); }, i === (o.defaultId || 0));
				});
				box.appendChild(row);
				return;
			}

			// A file or folder: a path on the host's machine, typed, or a file
			// uploaded from this one (an archive to install, a backup to restore).
			text(box, 'div', 'A path on the server running the app:', 'font-size:12px;color:#9aa0b0');
			const input = document.createElement('input');
			input.type = 'text';
			input.value = o.defaultPath || '';
			input.style.cssText = 'width:100%;box-sizing:border-box;padding:6px;margin:4px 0 8px;background:#11141d;color:#e8eaf0;border:1px solid #445;border-radius:4px';
			box.appendChild(input);
			const folderOnly = (o.properties || []).includes('openDirectory') && !(o.properties || []).includes('openFile');
			if (q.kind === 'open' && !folderOnly) {
				text(box, 'div', 'Or upload one from this computer:', 'font-size:12px;color:#9aa0b0');
				const file = document.createElement('input');
				file.type = 'file';
				const exts = [].concat(...(o.filters || []).map(f => f.extensions || [])).filter(e => e !== '*');
				if (exts.length) file.accept = exts.map(e => `.${e}`).join(',');
				file.style.cssText = 'margin:4px 0 10px';
				file.onchange = async () => {
					const f = file.files && file.files[0];
					if (!f) return;
					input.value = 'Uploading…';
					const r = await post(`/admin/api/upload?name=${encodeURIComponent(f.name)}`, f, { 'Content-Type': 'application/octet-stream' });
					input.value = r.path;
				};
				box.appendChild(file);
			}
			button(row, q.kind === 'save' ? 'Save' : 'Choose', () => { close(); answer(input.value); }, true);
			button(row, 'Cancel', () => { close(); answer(null); });
			box.appendChild(row);
			input.focus();
		});
	}

	let inFlight = 0;
	let polling = null;
	async function poll() {
		try {
			const r = await fetch('/admin/api/prompts', { credentials: 'same-origin' });
			if (r.ok) for (const q of await r.json()) if (!shown.has(q.id)) show(q);
		} catch {
			/* the next tick tries again */
		}
	}
	const watch = on => {
		inFlight += on ? 1 : -1;
		if (inFlight > 0 && !polling) polling = setInterval(poll, 500);
		if (inFlight <= 0 && polling) {
			clearInterval(polling);
			polling = null;
		}
	};

	// --- the calls ------------------------------------------------------------

	// A mod's own settings page, in a frame it cannot climb out of: sandboxed
	// with scripts but without allow-same-origin, so it has an origin of its
	// own, sends no cookie, and can reach nothing of the admin page's. Its
	// modSettings calls arrive here by postMessage; which mod they are for is
	// the ticket this page was given when it opened the frame, never anything
	// the frame says.
	async function openModPage(name) {
		const { ticket, url } = await invoke('mod_page_open', { name });
		modal((box, close) => {
			box.style.maxWidth = '640px';
			text(box, 'div', `${name} — settings`, 'font-weight:600;margin-bottom:8px');
			const frame = document.createElement('iframe');
			frame.setAttribute('sandbox', 'allow-scripts');
			frame.setAttribute('referrerpolicy', 'no-referrer');
			frame.src = url;
			frame.style.cssText = 'width:100%;height:70vh;border:1px solid #445;border-radius:4px;background:#fff';
			box.appendChild(frame);
			const onMessage = async e => {
				if (e.source !== frame.contentWindow || !e.data || e.data.roModSettings !== 'call') return;
				const { id, op, values } = e.data;
				let reply;
				try {
					reply = { ok: true, value: await invoke('mod_page_call', { ticket, op: String(op), values }) };
				} catch (error) {
					reply = { ok: false, error: (error && error.message) || String(error) };
				}
				// The frame's origin is opaque, so it cannot be named; the message
				// goes to that one window only.
				frame.contentWindow && frame.contentWindow.postMessage({ roModSettings: 'reply', id, ...reply }, '*');
			};
			window.addEventListener('message', onMessage);
			const row = document.createElement('div');
			button(row, 'Close', () => {
				window.removeEventListener('message', onMessage);
				invoke('mod_page_close', { ticket }).catch(() => {});
				close();
			}, true);
			box.appendChild(row);
		});
		return `Opened ${name} settings.`;
	}

	// Calls that mean something in the browser rather than on the server.
	const local = {
		// Settings -> Tools: our own pages, in a tab of their own.
		open_tool: async ({ id }) => {
			window.open(`/tools/${encodeURIComponent(String(id))}/`, '_blank', 'noopener');
		},
		open_mod_settings: async ({ name }) => openModPage(String(name)),
		copy_text: async ({ text: t }) => navigator.clipboard.writeText(String(t || '')),
		// Setup (where the client's files are) is a page of its own here, not a window.
		open_setup: async () => { location.href = '/setup'; },
		close_setup: async () => { location.href = '/settings'; },
		open_game: async () => {
			const { gameUrl } = await getInfo();
			window.open(gameUrl, '_blank', 'noopener');
			return `Opened ${gameUrl} in a new tab.`;
		},
	};

	async function invoke(name, args) {
		if (local[name]) return local[name](args || {});
		watch(true);
		try {
			const r = await post('/admin/api/invoke', JSON.stringify({ name, args: args || {} }), { 'Content-Type': 'application/json' });
			if (!r.ok) throw new Error(r.error);
			return r.value;
		} finally {
			watch(false);
		}
	}

	window.__ELECTRON__ = {
		core: { invoke },
		dialog: {
			open: (opts = {}) => invoke('__dialog_open', opts),
			save: (opts = {}) => invoke('__dialog_save', opts),
		},
	};
	window.__RO_HEADLESS__ = true;
})();
