'use strict';
//
// Discord chat bridge, Discord to game: what people say in the Discord channel
// the host's webhook posts to is said in the in-game #discord channel.
//
// A webhook can only post, so reading the channel takes a bot: the host makes
// one in the Discord developer portal, switches on its Message Content intent,
// adds it to their server and pastes its token into Settings. The app then
// reads the channel every few seconds over Discord's REST API (no gateway, no
// library) and hands each new message to the server with
// `ragnarok-stack host-message discord <name> <text>`. The discord-chat mod's
// script picks it up from there and says it in #discord.
//
// The channel is the webhook's own (a webhook link says which channel it
// posts to), so there is nothing else to set up, and what the bridge posts
// from the game is never read back: messages from webhooks and bots are
// skipped.
//
// The token is a credential (it acts as the bot), so like the webhook it lives
// in a file of its own under state/private, readable by this user only, and
// never goes back to a page in full.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API = 'https://discord.com/api/v10';
const TOKEN = /^[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{4,10}\.[A-Za-z0-9_-]{20,60}$/;
const POLL_MS = 3000;
const MAX_TEXT = 200;   // rAthena's CHAT_SIZE_MAX is 255, with the name and alias
const MAX_NAME = 23;    // NAME_LENGTH - 1

function parseToken(value) {
	const token = String(value || '').trim().replace(/^Bot\s+/i, '');
	return TOKEN.test(token) ? { token, hint: `…${token.slice(-4)}` } : null;
}

function store(stateDir) {
	const file = path.join(stateDir, 'private', 'discord-bot.json');
	return {
		read() {
			try { return parseToken(JSON.parse(fs.readFileSync(file, 'utf8')).token); } catch { return null; }
		},
		write(value) {
			const parsed = parseToken(value);
			if (!parsed) throw new Error('That is not a bot token. In the developer portal: your application → Bot → Reset Token, then copy it.');
			fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
			fs.writeFileSync(temporary, JSON.stringify({ token: parsed.token }) + '\n', { mode: 0o600 });
			fs.renameSync(temporary, file);
			return parsed;
		},
		clear() { fs.rmSync(file, { force: true }); },
	};
}

// The game client shows its own code page, not Unicode, so what it is sent is
// plain ASCII: accents dropped, curly quotes straightened, anything else ?.
function ascii(text) {
	return String(text)
		.normalize('NFKD').replace(/[̀-ͯ]/g, '')
		.replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"')
		.replace(/[–—−]/g, '-').replace(/…/g, '...')
		.replace(/[  -​]/g, ' ')
		.replace(/[^\x20-\x7e]+/g, '?');
}

// One Discord message as a line of game chat, or '' when there is nothing to
// say (an empty message, or one the bot can't read).
function gameText(message) {
	const users = new Map((message.mentions || []).map(u => [u.id, u.global_name || u.username]));
	let text = String(message.content || '')
		.replace(/<@!?(\d+)>/g, (_, id) => `@${users.get(id) || 'someone'}`)
		.replace(/<@&\d+>/g, '@role')
		.replace(/<#\d+>/g, '#channel')
		.replace(/<a?:(\w+):\d+>/g, ':$1:')
		.replace(/<t:(\d+)(?::\w)?>/g, (_, s) => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace('T', ' '));
	const files = (message.attachments || []).length;
	if (files) text += files === 1 ? ' [a file]' : ` [${files} files]`;
	if ((message.sticker_items || []).length) text += ' [a sticker]';
	text = ascii(text.replace(/\s+/g, ' ')).replace(/\s+/g, ' ').trim();
	return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 3) + '...' : text;
}

function speaker(message) {
	const name = ascii((message.member && message.member.nick) || message.author.global_name || message.author.username || 'Discord')
		.replace(/\s+/g, ' ').trim();
	return (name || 'Discord').slice(0, MAX_NAME);
}

// Message ids are snowflakes: decimal strings, ordered by time.
const newer = (a, b) => (a.length !== b.length ? a.length > b.length : a > b);

// The poller. `getToken` and `getWebhookUrl` are asked on every round, so a
// change in Settings takes effect at the next one; `deliver(name, text)` hands
// a message to the server and may throw.
function createBridge({ getToken, getWebhookUrl, deliver, fetch: fetchImpl = globalThis.fetch, log = () => {},
	timers = { setTimeout, clearTimeout }, pollMs = POLL_MS } = {}) {
	let timer = null;
	let running = false;
	let channel = null;     // { id, for: webhook url }
	let last = null;        // the newest message id seen
	let state = { state: 'off' };
	let refused = null;     // the token Discord refused, not tried again
	let quietLogged = false;

	function set(next) {
		if (next.state !== state.state || next.detail !== state.detail) {
			if (next.state === 'error') log(`discord bot: ${next.detail}`);
			if (next.state === 'reading') log(`discord bot: reading channel ${channel && channel.id}`);
		}
		state = next;
	}

	async function call(url, token) {
		const res = await fetchImpl(url, { headers: token ? { authorization: `Bot ${token}` } : {} });
		if (res.status === 429) {
			let wait = 5;
			try { wait = Number((await res.json()).retry_after) || 5; } catch { /* default */ }
			return { wait: Math.min(Math.max(wait * 1000, 1000), 60000) };
		}
		if (!res.ok) return { status: res.status };
		return { body: await res.json() };
	}

	async function round() {
		const token = getToken();
		const hook = getWebhookUrl();
		if (!token || !hook) { set({ state: 'off' }); channel = null; last = null; return pollMs * 5; }
		if (token === refused) return pollMs * 5;
		if (!channel || channel.for !== hook) {
			const got = await call(hook);
			if (got.wait) return got.wait;
			if (!got.body || !got.body.channel_id) {
				set({ state: 'error', detail: 'the webhook link no longer works, so the channel is unknown' });
				return pollMs * 10;
			}
			channel = { id: String(got.body.channel_id), for: hook };
			last = null;
		}
		if (last === null) {
			// Start from now: what was said before the bridge started stays in Discord.
			const got = await call(`${API}/channels/${channel.id}/messages?limit=1`, token);
			if (got.wait) return got.wait;
			if (!got.body) return failed(got.status, token);
			last = got.body.length ? String(got.body[0].id) : '0';
			set({ state: 'reading' });
			return pollMs;
		}
		const got = await call(`${API}/channels/${channel.id}/messages?limit=50&after=${last}`, token);
		if (got.wait) return got.wait;
		if (!got.body) return failed(got.status, token);
		const messages = got.body.filter(m => m && m.id).sort((a, b) => (newer(String(a.id), String(b.id)) ? 1 : -1));
		for (const m of messages) {
			last = String(m.id);
			// Our own posts (the webhook), other bots, joins and pins.
			if (m.webhook_id || (m.author && m.author.bot) || ![0, 19].includes(m.type)) continue;
			const text = gameText(m);
			if (!text) {
				if (!quietLogged && !m.content && !(m.attachments || []).length) {
					quietLogged = true;
					set({ state: 'error', detail: 'messages arrive empty: switch on Message Content Intent under Bot in the developer portal' });
				}
				continue;
			}
			try {
				await deliver(speaker(m), text);
				if (state.state !== 'reading') set({ state: 'reading' });
			} catch (e) {
				set({ state: 'error', detail: `could not pass a message to the server (${e.message})` });
			}
		}
		return pollMs;
	}

	function failed(status, token) {
		if (status === 401) {
			refused = token;
			set({ state: 'error', detail: 'Discord refused the bot token. Reset it in the developer portal and paste the new one.' });
			return pollMs * 5;
		}
		if (status === 403 || status === 404) {
			set({ state: 'error', detail: 'the bot cannot read the webhook\'s channel. Add the bot to your server, and let it View Channel and Read Message History there.' });
			return pollMs * 10;
		}
		set({ state: 'error', detail: `Discord answered ${status}` });
		return pollMs * 5;
	}

	async function loop() {
		timer = null;
		if (!running) return;
		let next = pollMs;
		try { next = await round(); } catch (e) {
			set({ state: 'error', detail: `could not reach Discord (${e.message})` });
			next = pollMs * 5;
		}
		if (running) {
			timer = timers.setTimeout(loop, next);
			if (timer && timer.unref) timer.unref();
		}
	}

	return {
		start() { if (running) return; running = true; loop(); },
		stop() { running = false; if (timer) timers.clearTimeout(timer); timer = null; },
		// After the token or webhook changes: start over from the newest message.
		reset() { channel = null; last = null; refused = null; quietLogged = false; set({ state: 'off' }); },
		status: () => ({ ...state }),
		round,
	};
}

module.exports = { parseToken, store, ascii, gameText, speaker, createBridge, POLL_MS };
