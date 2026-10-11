'use strict';
//
// Native dialogs, answered from a browser instead.
//
// A headless app has no screen to put a dialog on, and several handlers ask
// one: install or update this mod?, remove it?, which folder or archive? The
// Settings page's own file pickers go through dialog.showOpenDialog too. So in
// headless mode the dialog methods are replaced by ones that file the question
// here and wait. The admin page (admin-shim.js) polls `pending()` while one of
// its calls is in flight, shows the question, and posts the answer back with
// `answer()`, which settles the waiting handler as if the player had clicked.
//
// A question nobody answers is cancelled after `timeoutMs`, so a handler can
// never hang for ever on a browser tab that was closed.
//

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

class RemoteDialogs {
	constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
		this.timeoutMs = timeoutMs;
		this.log = log;
		this.questions = new Map();
		this.next = 1;
	}

	/**
	 * File a question and wait for its answer. `kind` is 'message', 'open' or
	 * 'save'; `options` is what the handler gave Electron's dialog.
	 */
	ask(kind, options, cancelled) {
		const id = String(this.next++);
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				if (this.questions.delete(id)) {
					this.log(`headless: dialog ${id} (${kind}) was not answered in time; cancelled`);
					resolve(cancelled);
				}
			}, this.timeoutMs);
			this.questions.set(id, { id, kind, options: plain(options), resolve, timer });
		});
	}

	/** The questions waiting for an answer, as the browser sees them. */
	pending() {
		return [...this.questions.values()].map(({ id, kind, options }) => ({ id, kind, options }));
	}

	/**
	 * Answer question `id`. For 'message', `value` is the index of the button
	 * pressed; for 'open' and 'save', a path on this machine, or null to
	 * cancel. Returns false for a question that is not waiting.
	 */
	answer(id, value) {
		const q = this.questions.get(String(id));
		if (!q) return false;
		this.questions.delete(q.id);
		clearTimeout(q.timer);
		if (q.kind === 'message') {
			const buttons = (q.options && q.options.buttons) || ['OK'];
			const n = Number(value);
			const cancel = q.options && Number.isInteger(q.options.cancelId) ? q.options.cancelId : buttons.length - 1;
			q.resolve({ response: Number.isInteger(n) && n >= 0 && n < buttons.length ? n : cancel, checkboxChecked: false });
		} else if (q.kind === 'open') {
			const paths = (Array.isArray(value) ? value : [value]).filter(p => typeof p === 'string' && p.trim());
			q.resolve({ canceled: paths.length === 0, filePaths: paths.map(p => p.trim()) });
		} else {
			const p = typeof value === 'string' ? value.trim() : '';
			q.resolve({ canceled: !p, filePath: p || undefined });
		}
		return true;
	}

	/**
	 * Replace `dialog`'s methods (Electron's `dialog` module) with these. The
	 * handlers keep calling dialog.showMessageBox and the rest exactly as they
	 * do with a screen; only the answer comes from somewhere else.
	 */
	install(dialog) {
		// Electron's message and file dialogs take an optional parent window first.
		const opts = args => (args.length > 1 ? args[1] : args[0]) || {};
		dialog.showMessageBox = (...args) => {
			const o = opts(args);
			const buttons = o.buttons && o.buttons.length ? o.buttons : ['OK'];
			const cancel = Number.isInteger(o.cancelId) ? o.cancelId : buttons.length - 1;
			return this.ask('message', { ...o, buttons }, { response: cancel, checkboxChecked: false });
		};
		dialog.showOpenDialog = (...args) => this.ask('open', opts(args), { canceled: true, filePaths: [] });
		dialog.showSaveDialog = (...args) => this.ask('save', opts(args), { canceled: true, filePath: undefined });
		// Nothing waits on an error box; it is for a human to read, and there is
		// none at this screen.
		dialog.showErrorBox = (title, content) => this.log(`headless: ${title}: ${content}`);
		return this;
	}
}

/**
 * The parts of a dialog's options that mean anything to a browser: no
 * functions, no window objects, nothing that cannot be sent as JSON.
 */
function plain(options) {
	const o = options || {};
	const keep = ['type', 'title', 'message', 'detail', 'buttons', 'defaultId', 'cancelId', 'properties', 'filters', 'defaultPath'];
	const out = {};
	for (const k of keep) if (o[k] !== undefined) out[k] = o[k];
	return JSON.parse(JSON.stringify(out));
}

module.exports = { RemoteDialogs };
