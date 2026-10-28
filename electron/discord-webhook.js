'use strict';
//
// Discord announcements: lines from the map server's log, posted to a channel
// webhook the host pasted into Settings.
//
// Server scripts cannot make web requests, so a script that wants to announce
// something writes it to its log instead:
//
//   debugmes "[discord] **Steve** defeated **Baphomet** on prt_maze03!";
//
// which rAthena prints as
//
//   [Debug]: script debug : 2000001 110000123 : [discord] **Steve** ...
//
// The app follows the map server's log while a webhook is set, and posts each
// such line. The bundled discord-announcements mod is the main user, and any
// other mod's script can do the same. The app adds one event of its own: the
// world coming online.
//
// Chat: with the rAthena extension channel_log on (the discord-chat mod turns
// it on), each message a player sends in the in-game #discord channel is
// written to the same log as
//
//   [Info]: [channel] #discord<TAB>Steve<TAB>anyone up for Orc Dungeon?
//
// and posted under the character's name.
//
// The webhook URL is a credential (anyone holding it can post in that
// channel), so it lives in a file of its own under state/private, readable by
// this user only, and is never handed back to a page in full.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{20,200})$/;
const LINE = /script debug : -?\d+ -?\d+ : \[discord\] (.+)$/;
const READY = /Server is 'ready' and listening on port/;
const CHAT = /\[channel\] #[^\t]+\t([^\t]+)\t(.*)$/;
const USERNAME = 'Ragnarok Offline';

const FLUSH_MS = 2000;      // lines arriving together go in one message
const MAX_LINES = 10;       // per message
const MAX_CONTENT = 2000;   // Discord's limit for `content`
const MAX_QUEUE = 100;      // past this, the oldest lines are dropped

function parseWebhook(value) {
	const url = String(value || '').trim();
	const m = WEBHOOK.exec(url);
	return m ? { url, id: m[1], hint: `…${m[2].slice(-4)}` } : null;
}

// Chat text as typed, shown as typed: no markdown, so `*` and `_` and links
// in brackets stay plain text.
function plain(text) {
	return String(text).replace(/[\\*_~`|>\[\]()#-]/g, c => '\\' + c);
}

// A character name Discord accepts as a webhook's display name: at most 80
// characters, without '@', '#', ':' or '```', and without the word "discord"
// or "clyde" (both refused). The rest is kept.
function displayName(name) {
	const cleaned = String(name).replace(/[@#:`]/g, '').replace(/discord|clyde/gi, m => m[0] + '.' + m.slice(1)).trim().slice(0, 80);
	return cleaned || 'Player';
}

// What a line of the map server's log has for Discord, or null: a string to
// post under the app's name, or { username, content } for a player's chat.
function announcement(text, { world = true, chat = true } = {}) {
	const c = CHAT.exec(String(text || ''));
	if (c) {
		const said = c[2].trim();
		return chat && said ? { username: displayName(c[1]), content: plain(said).slice(0, 1000), name: c[1] } : null;
	}
	const m = LINE.exec(String(text || ''));
	if (m) {
		const said = m[1].trim();
		return said ? said.slice(0, 500) : null;
	}
	if (world && READY.test(text)) return '🟢 The world is online.';
	return null;
}

// The file the URL is kept in.
function store(stateDir) {
	const file = path.join(stateDir, 'private', 'discord-webhook.json');
	return {
		read() {
			try {
				const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
				return parseWebhook(saved.url);
			} catch { return null; }
		},
		write(url) {
			const parsed = parseWebhook(url);
			if (!parsed) throw new Error('That is not a Discord webhook link. In Discord: Edit Channel → Integrations → Webhooks → Copy Webhook URL.');
			fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
			fs.writeFileSync(temporary, JSON.stringify({ url: parsed.url }) + '\n', { mode: 0o600 });
			fs.renameSync(temporary, file);
			return parsed;
		},
		clear() { fs.rmSync(file, { force: true }); },
	};
}

// The sender: a queue, flushed every two seconds, that waits out Discord's
// rate limit when told to. `getUrl` is asked on each send, so removing the
// webhook stops the next post.
function createSender({ getUrl, fetch: fetchImpl = globalThis.fetch, log = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
	const queue = [];
	let timer = null;
	let sending = false;
	let dropped = 0;

	function schedule(ms = FLUSH_MS) {
		if (timer || sending) return;
		timer = timers.setTimeout(() => { timer = null; flush(); }, ms);
		if (timer && timer.unref) timer.unref();
	}

	async function post(url, content, username = USERNAME) {
		const res = await fetchImpl(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ content, username, allowed_mentions: { parse: [] } }),
		});
		if (res.status === 429) {
			let wait = 5;
			try { wait = Number((await res.json()).retry_after) || 5; } catch { /* default */ }
			return { retryMs: Math.min(Math.max(wait * 1000, 1000), 60000) };
		}
		// A name Discord still refuses: say who it was in the message instead.
		if (res.status === 400 && username !== USERNAME) return { badName: true };
		if (!res.ok) {
			const why = res.status === 404 || res.status === 401 ? 'the webhook was deleted or its link is wrong' : `Discord answered ${res.status}`;
			return { error: why, permanent: res.status === 404 || res.status === 401 };
		}
		return {};
	}

	async function flush() {
		const url = getUrl();
		if (!url) { queue.length = 0; return; }
		if (!queue.length) return;
		sending = true;
		// One message holds lines from one speaker: the app's announcements,
		// or one player's chat, under their name.
		const username = queue[0].username;
		const taken = [];
		const lines = [];
		let size = 0;
		if (dropped && username === USERNAME) { lines.push(`(${dropped} earlier announcements were skipped)`); size += lines[0].length + 1; dropped = 0; }
		while (queue.length && queue[0].username === username && lines.length < MAX_LINES && size + queue[0].content.length + 1 <= MAX_CONTENT) {
			const item = queue.shift();
			taken.push(item);
			lines.push(item.content);
			size += item.content.length + 1;
		}
		let next = queue.length ? FLUSH_MS : null;
		try {
			let result = await post(url, lines.join('\n'), username);
			if (result.badName) {
				result = await post(url, taken.map(i => `**${plain(i.name || i.username)}:** ${i.content}`).join('\n').slice(0, MAX_CONTENT));
			}
			if (result.retryMs) { queue.unshift(...taken); next = result.retryMs; }
			else if (result.error) {
				log(`discord webhook: ${result.error}`);
				if (result.permanent) queue.length = 0;
			}
		} catch (e) {
			log(`discord webhook: could not post (${e.message})`);
		} finally {
			sending = false;
		}
		if (next !== null && queue.length) schedule(next);
	}

	return {
		// A string is posted under the app's name; { username, content } under
		// that name (a player's chat).
		add(line) {
			if (!getUrl()) return;
			const item = line && typeof line === 'object'
				? { username: String(line.username || USERNAME).slice(0, 80), content: String(line.content || '').slice(0, MAX_CONTENT), name: line.name }
				: { username: USERNAME, content: String(line).slice(0, MAX_CONTENT) };
			if (!item.content) return;
			queue.push(item);
			while (queue.length > MAX_QUEUE) { queue.shift(); dropped++; }
			schedule();
		},
		// One message now, for Settings' "Send a test". Throws with a reason.
		async test(url) {
			const result = await post(url, '✅ Ragnarok Offline will post announcements here.');
			if (result.retryMs) throw new Error('Discord says to slow down. Try again in a minute.');
			if (result.error) throw new Error(`Could not post: ${result.error}.`);
			return true;
		},
		pending: () => queue.length,
	};
}

// Follows the map log while a webhook is set. `subscribe` is log-stream's.
function createAnnouncer({ subscribe, getUrl, getOptions = () => ({}), sender, now = Date.now, log = () => {} }) {
	let stop = null;
	let since = 0;

	function onEvent(event) {
		if (event.level === 'marker') return;
		// The follow starts with the log's last lines; only what happens from
		// now on is news. Ten seconds of slack for the engine's clock.
		const at = Date.parse(event.time);
		if (Number.isFinite(at) && at < since - 10000) return;
		const options = getOptions();
		const said = announcement(event.text, { world: options.world !== false, chat: options.chat !== false });
		if (said) sender.add(said);
	}

	return {
		// Call whenever the webhook changes: follows while one is set.
		refresh() {
			const want = Boolean(getUrl());
			if (want && !stop) {
				since = now();
				stop = subscribe(['map'], onEvent);
				log('discord webhook: following the map server for announcements');
			} else if (!want && stop) {
				stop();
				stop = null;
			}
		},
		stop() { if (stop) stop(); stop = null; },
		following: () => Boolean(stop),
	};
}

module.exports = { parseWebhook, announcement, displayName, plain, store, createSender, createAnnouncer, MAX_LINES };
