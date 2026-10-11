// The live channel: how a command from the CLI or an MCP client reaches the
// map editor page that is open, so an agent edits the same map a person is
// looking at, the edit shows at once and Undo takes it back.
//
// The page long-polls for commands (api/remote/poll) and posts each result
// back (api/remote/result). The host side calls run(cmd, args), which waits
// for the page's answer.

export function createRemote() {
	const queue = [];
	const pending = new Map();
	let waiting = null;
	let lastPoll = 0;
	let seq = 0;
	let pageInfo = null;

	function flush() {
		if (waiting && queue.length) {
			const w = waiting;
			waiting = null;
			clearTimeout(w.timer);
			w.resolve({ commands: queue.splice(0) });
		}
	}

	/** Whether a page has asked for work in the last few seconds. */
	function connected() { return Date.now() - lastPoll < 35000; }

	function run(cmd, args = {}, timeoutMs = 120000) {
		if (!connected()) return Promise.reject(new Error('No map editor is open. Open it from Settings → Tools → Map editor, or run `ragnarok-map serve`.'));
		const id = ++seq;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { pending.delete(id); reject(new Error(`the map editor did not answer "${cmd}" in ${timeoutMs / 1000}s`)); }, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			queue.push({ id, cmd, args });
			flush();
		});
	}

	async function page(action, body) {
		if (action === 'poll') {
			lastPoll = Date.now();
			if (body && body.info) pageInfo = body.info;
			if (queue.length) return { commands: queue.splice(0) };
			if (waiting) { clearTimeout(waiting.timer); waiting.resolve({ commands: [] }); }
			return new Promise(resolve => {
				waiting = { resolve, timer: setTimeout(() => { if (waiting && waiting.resolve === resolve) waiting = null; resolve({ commands: [] }); }, 20000) };
			});
		}
		if (action === 'result') {
			lastPoll = Date.now();
			const p = pending.get(body.id);
			if (p) {
				pending.delete(body.id);
				clearTimeout(p.timer);
				if (body.error) p.reject(new Error(body.error)); else p.resolve(body.result);
			}
			return { ok: true };
		}
		return { error: `no remote action ${action}` };
	}

	return { run, page, connected, info: () => pageInfo };
}
