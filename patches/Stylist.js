/**
 * UI/Components/Stylist/Stylist.js
 *
 * The stylist window (ZC_UI_OPEN, ui_type 1).
 *
 * roBrowser implements three of the eleven ui_types the server can ask for,
 * and the stylist is not one of them -- `onUIOpen` logged "not implemented" and
 * returned. rAthena does not know that, so every stylist NPC in renewal
 * closes its dialogue, asks for this window and leaves the player facing
 * nothing at all. This is that window.
 *
 * Laid out like the official one: the character on the left, turned with two
 * buttons; a tab per look, each a grid of the choices drawn on the character;
 * what is being bought and how to pay for it at the bottom.
 *
 * **The pictures are the player's own character, undressed.** Each one is an
 * Entity of its own drawn on a canvas, the way the equipment window draws its
 * portrait: the player's class (and alternative outfit), sex, hair and colours,
 * and nothing worn, so a hat never hides the haircut being chosen. Hair styles
 * differ between the sexes, and the sprites already do.
 *
 * **Indices are not look values.** The packet carries indices into the
 * server's stylist table, and rAthena resolves them through `stylist.yml`.
 * In the table rAthena ships they match except for the default colours: hair
 * colour 0 is index -1 and clothes colour 0 is index 1 (there is no clothes
 * colour 1 to buy). `LOOKS` mirrors that table. A server with a rewritten one
 * could map them differently; it validates every index and answers
 * ZC_STYLE_CHANGE_RES with a failure flag, which is reported rather than
 * swallowed.
 *
 * **Prices and coupons come from the NPC, when it gives them.** Nothing in the
 * stylist packets carries a price, and nothing carries how the player wants to
 * pay. A script that knows both says so before it opens the window, in a line
 * PluginWindows.mjs keeps out of chat:
 *
 *     @@event stylist pay=<command> head=<zeny>:<item> headpalette=... bodypalette=... bodystyle=...
 *
 * Every part is optional. `<item>` is the coupon that pays for that look
 * instead of the Zeny (0: Zeny only). The outfit tab (standard or alternative
 * outfit) is there only when the NPC prices it: which classes have an
 * alternative outfit is the server's table, so the NPC says so by offering it. With `pay=`, the window offers Zeny or
 * coupons, and on Buy first asks `@<command> <id> pay <0|1>` -- a server
 * request the script answers (setstylistpayment, rAthena's
 * stylist_script_costs extension) -- and only then sends the purchase. With
 * no line at all the window shows no prices and sells as it always has.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import DB from 'DB/DBManager.js';
import Network from 'Network/NetworkManager.js';
import PACKET from 'Network/PacketStructure.js';
import PACKETVER from 'Network/PacketVerManager.js';
import Preferences from 'Core/Preferences.js';
import Renderer from 'Renderer/Renderer.js';
import Camera from 'Renderer/Camera.js';
import Entity from 'Renderer/Entity/Entity.js';
import SpriteRenderer from 'Renderer/SpriteRenderer.js';
import Session from 'Engine/SessionStorage.js';
import UIManager from 'UI/UIManager.js';
import GUIComponent from 'UI/GUIComponent.js';
import ChatBox from 'UI/Components/ChatBox/ChatBox.js';
import htmlText from './Stylist.html?raw';
import cssText from './Stylist.css?raw';

/**
 * Create component
 */
const Stylist = new GUIComponent('Stylist', cssText);

Stylist.render = () => htmlText;

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * What the player may choose.
 *
 * `prop` is the Entity property that shows it, `field` its field in
 * CZ_REQ_STYLE_CHANGE2, `values` what the stylist table rAthena ships
 * (`db/re/stylist.yml`) sells, `index` the table's index for a value, `key`
 * its name in the NPC's offer when that is not `prop`, `labels` a caption per
 * value.
 */
const LOOKS = [
	{ prop: 'head', field: 'HeadStyle', name: 'Hair style', values: range(1, 42), index: (v) => v },
	{
		prop: 'headpalette',
		field: 'HeadPalette',
		name: 'Hair colour',
		values: range(0, 8),
		index: (v) => (v === 0 ? -1 : v)
	},
	{
		prop: 'bodypalette',
		field: 'BodyPalette',
		name: 'Clothes colour',
		values: [0, 2, 3, 4, 5, 6, 7],
		index: (v) => (v === 0 ? 1 : v)
	},
	{
		// 0 the class's own outfit, 1 its alternative outfit: the client draws
		// any body style above 0 as the class's alternative outfit.
		prop: 'body',
		key: 'bodystyle',
		field: 'BodyStyle',
		name: 'Outfit',
		values: [0, 1],
		index: (v) => v + 1,
		labels: ['Standard', 'Alternative']
	}
];

/**
 * Whether the look gets a tab: the outfit only when the NPC offers it
 */
function offered(look) {
	return look.prop !== 'body' || !!(_offer && _offer.costs.body);
}

/**
 * The outfit tab's value for a character. The server sends the body style as
 * 0 or 1, but an entity may carry its outfit's job ID instead.
 */
function bodyStyle(player) {
	return player && player.body > 0 && player.body !== baseJob(player) ? 1 : 0;
}

/**
 * The character's own class. `job` is what it is drawn as: the mount's
 * sprite while riding (Peco Peco, Dragon, Gryphon, Madogear, ...).
 */
function baseJob(player) {
	return player._job >= 0 ? player._job : player.job;
}

/**
 * Where a character stands on each kind of canvas (its feet), and how big
 * the canvas is. The hair grid shows the head only: the feet are below it.
 */
const STAGE = { width: 80, height: 120, x: 40, y: 112 };
const HAIR_CELL = { width: 40, height: 36, x: 20, y: 100, scale: 1.5 };
const COLOR_CELL = { width: 64, height: 110, x: 32, y: 104, scale: 1 };

/**
 * The thumbnails do not move, so they are drawn a few times a second: often
 * enough to show sprites as they finish loading.
 */
const THUMB_INTERVAL = 250;

/**
 * An NPC's offer lasts until its window opens, and no longer: a window some
 * other NPC opens later must not inherit it.
 */
const OFFER_LIFETIME = 5000;

/**
 * @var {Preferences} window position
 */
const _preferences = Preferences.get(
	'Stylist',
	{
		x: 200,
		y: 120
	},
	1.0
);

let _original = null; // the look when the window opened, so Cancel means something
let _choice = null; // the look being tried
let _tab = 'head';
let _direction = 0;
let _pay = 0; // 0 Zeny, 1 coupons
let _busy = false; // a purchase is on its way
let _offer = null; // { pay, costs: { prop: { zeny, item } }, time }
let _ask = null; // (command, text) => Promise, from ExtensionBridge.mjs
let _preview = null; // { ctx, entity }
let _thumbs = []; // [{ ctx, entity, area }]
let _thumbTick = 0;
let _entities = 0; // for a GID of each picture's own

/**
 * The NPC's prices and payment command, sent just before the window opens
 * (ExtensionBridge.mjs hands every `@@event stylist` line here).
 *
 * @param {string} text - `pay=<command> head=<zeny>:<item> ...`
 * @param {Function} ask - sends a server request, resolves with its answer
 */
Stylist.setOffer = function setOffer(text, ask) {
	const offer = { pay: null, costs: {}, time: Date.now() };

	String(text)
		.split(/\s+/)
		.forEach((part) => {
			const [key, value = ''] = part.split('=');
			if (key === 'pay' && /^[a-z][a-z0-9_]{1,23}$/.test(value)) {
				offer.pay = value;
				return;
			}
			const look = LOOKS.find((l) => (l.key || l.prop) === key);
			if (look) {
				const [zeny, item] = value.split(':').map((n) => parseInt(n, 10) || 0);
				offer.costs[look.prop] = { zeny: Math.max(0, zeny), item: Math.max(0, item || 0) };
			}
		});

	_offer = offer;
	_ask = ask;

	// Only while the window is open
	if (_choice) {
		refresh();
	}
};

/**
 * Initialize the component
 */
Stylist.init = function init() {
	const root = this.getRoot();

	this.draggable('.titlebar');

	root.querySelector('.titlebar .close').addEventListener('click', () => Stylist.remove());
	root.querySelector('.cancel').addEventListener('click', () => Stylist.remove());
	root.querySelector('.buy').addEventListener('click', () => buy());

	root.querySelector('.undo').addEventListener('click', () => {
		_choice = { ..._original };
		showChoice();
		buildPane();
		refresh();
	});

	root.querySelector('.turn.left').addEventListener('click', () => {
		_direction = (_direction + 1) % 8;
	});
	root.querySelector('.turn.right').addEventListener('click', () => {
		_direction = (_direction + 7) % 8;
	});

	root.querySelectorAll('.tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			_tab = tab.getAttribute('data-look');
			buildPane();
			refresh();
		});
	});

	root.querySelectorAll('.option').forEach((option) => {
		option.addEventListener('click', () => {
			if (!option.classList.contains('off')) {
				_pay = parseInt(option.getAttribute('data-pay'), 10);
				refresh();
			}
		});
	});

	root.querySelector('.pane').addEventListener('click', (event) => {
		const cell = event.target.closest('.cell');
		if (!cell || !_choice) {
			return;
		}
		_choice[_tab] = parseInt(cell.getAttribute('data-value'), 10);
		showChoice();
		refresh();
	});
};

/**
 * Remember the character, and start drawing it
 */
Stylist.onAppend = function onAppend() {
	const player = Session.Entity;

	if (_offer && Date.now() - _offer.time > OFFER_LIFETIME) {
		_offer = null;
	}

	_original = {};
	LOOKS.forEach((look) => {
		_original[look.prop] = player ? player[look.prop] | 0 : 0;
	});
	_original.body = bodyStyle(player);
	_choice = { ..._original };
	_tab = 'head';
	_direction = 0;
	_pay = 0;
	_busy = false;

	const root = this.getRoot();
	_preview = {
		ctx: root.querySelector('.stage canvas').getContext('2d'),
		entity: makeEntity(_choice)
	};

	// `_host`, not `getRoot()`: getRoot() hands back the ShadowRoot, which has
	// no style of its own. Setting `.style.left` on it throws inside append(),
	// which leaves the component half-attached and -- because onKeyDown was
	// then live -- eating the Escape that would have got the player out.
	const host = this._host;
	host.style.left =
		Math.min(Math.max(0, _preferences.x), Renderer.width - host.offsetWidth) + 'px';
	host.style.top =
		Math.min(Math.max(0, _preferences.y), Renderer.height - host.offsetHeight) + 'px';

	buildPane();
	refresh();
	Renderer.render(draw);
};

/**
 * Keep the position, and stop drawing
 */
Stylist.onRemove = function onRemove() {
	Renderer.stop(draw);

	_original = null;
	_choice = null;
	_offer = null;
	_preview = null;
	_thumbs = [];

	_preferences.x = parseInt(this._host.style.left, 10) || 0;
	_preferences.y = parseInt(this._host.style.top, 10) || 0;
	_preferences.save();

	// Tell the server the window is gone, so it stops considering the stylist
	// open. Without this `sd->state.stylist_open` stays true until the next
	// map change and a second visit to the NPC is refused.
	if (PACKETVER.value >= 20151104) {
		Network.sendPacket(new PACKET.CZ.REQ_STYLE_CLOSE());
	}
};

/**
 * Escape closes it, like every other window
 */
Stylist.onKeyDown = function onKeyDown(event) {
	// A component that failed to append must not hold the keyboard hostage.
	// Escape is how a stuck player gets back to character select, and that is
	// exactly the moment it has to work.
	if (!this._host || this._host.style.display === 'none') {
		return true;
	}
	if (event.which === 27 || event.key === 'Escape') {
		this.remove();
		event.stopImmediatePropagation();
		return false;
	}
	return true;
};

/**
 * A character to draw: the player's class and sex, the given look (outfit
 * included), and nothing worn
 */
function makeEntity(look) {
	const player = Session.Entity;
	const entity = new Entity();

	entity.set({
		GID: 'stylist_' + ++_entities,
		objecttype: Entity.TYPE_PC,
		job: player ? baseJob(player) : 0,
		sex: player ? player.sex : 0,
		name: '',
		hideShadow: true,
		head: look.head,
		headpalette: look.headpalette,
		bodypalette: look.bodypalette,
		action: 0,
		direction: 0
	});

	// Entity.set() leaves out the body style (alternative outfit).
	if (look.body) {
		entity.body = look.body;
	}

	return entity;
}

/**
 * Show the look being tried on the big character
 */
function showChoice() {
	if (!_preview) {
		return;
	}
	LOOKS.forEach((look) => {
		if (_preview.entity[look.prop] !== _choice[look.prop]) {
			_preview.entity[look.prop] = _choice[look.prop];
		}
	});
}

/**
 * Fill the open tab with a picture of each choice
 */
function buildPane() {
	const root = Stylist.getRoot();
	const look = LOOKS.find((l) => l.prop === _tab);
	const area = _tab === 'head' ? HAIR_CELL : COLOR_CELL;
	const pane = root.querySelector('.pane');
	const grid = document.createElement('div');

	grid.className = _tab === 'head' ? 'grid' : 'grid colors';
	_thumbs = [];

	look.values.forEach((value) => {
		const cell = document.createElement('div');
		cell.className = 'cell';
		cell.setAttribute('data-value', value);

		const canvas = document.createElement('canvas');
		canvas.width = area.width;
		canvas.height = area.height;
		canvas.style.width = area.width * area.scale + 'px';
		canvas.style.height = area.height * area.scale + 'px';
		cell.appendChild(canvas);

		if (look.labels) {
			const label = document.createElement('div');
			label.className = 'label';
			label.textContent = look.labels[look.values.indexOf(value)];
			cell.appendChild(label);
			cell.classList.add('labelled');
		}

		if (value === _original[look.prop]) {
			const now = document.createElement('div');
			now.className = 'now';
			now.textContent = 'now';
			cell.appendChild(now);
		}

		// Each picture shows the character as it is being tried, with only
		// this tab's look changed.
		_thumbs.push({
			ctx: canvas.getContext('2d'),
			entity: makeEntity({ ..._choice, [look.prop]: value }),
			area
		});

		grid.appendChild(cell);
	});

	pane.innerHTML = '';
	pane.appendChild(grid);
	pane.scrollTop = 0;
	_thumbTick = 0;
}

/**
 * Draw the characters. Runs as a Renderer callback, after the map's frame.
 */
function draw(tick) {
	if (!_preview) {
		return;
	}

	const cameraDirection = Camera.direction;
	Camera.direction = 0;

	_preview.entity.direction = _direction;
	SpriteRenderer.bind2DContext(_preview.ctx, STAGE.x, STAGE.y);
	_preview.ctx.clearRect(0, 0, STAGE.width, STAGE.height);
	_preview.entity.renderEntity(_preview.ctx);

	if (tick - _thumbTick >= THUMB_INTERVAL) {
		_thumbTick = tick;
		_thumbs.forEach((thumb) => {
			SpriteRenderer.bind2DContext(thumb.ctx, thumb.area.x, thumb.area.y);
			thumb.ctx.clearRect(0, 0, thumb.area.width, thumb.area.height);
			thumb.entity.renderEntity(thumb.ctx);
		});
	}

	Camera.direction = cameraDirection;
}

/**
 * The looks that differ from the character's own
 */
function changes() {
	return LOOKS.filter((look) => _choice && _choice[look.prop] !== _original[look.prop]);
}

function itemName(id) {
	const item = DB.getItemInfo(id);
	return (item && item.identifiedDisplayName) || `item ${id}`;
}

function itemCount(id) {
	const inventory = UIManager.getComponent('Inventory');
	const item = inventory && inventory.getItemById ? inventory.getItemById(id) : null;
	return item ? item.count || 1 : 0;
}

const zeny = (n) => n.toLocaleString('en-US') + ' z';

/**
 * Put the window in step with the choice: the tabs, the selected picture,
 * the order and what it costs
 */
function refresh() {
	if (!_choice) {
		return;
	}

	const root = Stylist.getRoot();
	const order = changes();
	const costs = _offer ? _offer.costs : {};

	root.querySelectorAll('.tab').forEach((tab) => {
		const prop = tab.getAttribute('data-look');
		tab.classList.toggle('hidden', !offered(LOOKS.find((l) => l.prop === prop)));
		tab.classList.toggle('on', prop === _tab);
		tab.classList.toggle('changed', _choice[prop] !== _original[prop]);
	});

	root.querySelectorAll('.pane .cell').forEach((cell) => {
		cell.classList.toggle('on', parseInt(cell.getAttribute('data-value'), 10) === _choice[_tab]);
	});

	// The order, a line per look
	const lines = root.querySelector('.lines');
	lines.innerHTML = '';
	if (!order.length) {
		const row = lines.insertRow();
		row.className = 'none';
		row.insertCell().textContent = 'Pick a new look above. Nothing is bought until you press Buy.';
	}
	order.forEach((look) => {
		const cost = costs[look.prop];
		const row = lines.insertRow();
		row.insertCell().textContent = look.name;
		const price = row.insertCell();
		price.className = 'price';
		if (!cost) {
			price.textContent = '';
		} else if (cost.item) {
			price.textContent = `${zeny(cost.zeny)} or 1 ${itemName(cost.item)}`;
		} else {
			price.textContent = zeny(cost.zeny);
		}
	});

	// The two ways to pay: only when the NPC said what things cost and how
	// to tell it the choice, and a coupon pays for at least one of them.
	const pay = root.querySelector('.pay');
	const priced = order.length && order.every((look) => costs[look.prop]);
	const couponLooks = order.filter((look) => costs[look.prop] && costs[look.prop].item);
	const choosing = !!(_offer && _offer.pay && priced);

	pay.classList.toggle('hidden', !choosing);
	if (choosing) {
		const total = order.reduce((sum, look) => sum + costs[look.prop].zeny, 0);
		const rest = order
			.filter((look) => !costs[look.prop].item)
			.reduce((sum, look) => sum + costs[look.prop].zeny, 0);

		// Coupons of each kind the order takes, and whether the bag holds them
		const needed = new Map();
		couponLooks.forEach((look) => {
			const id = costs[look.prop].item;
			needed.set(id, (needed.get(id) || 0) + 1);
		});
		const short = [...needed].filter(([id, count]) => itemCount(id) < count);
		const couponsOk = needed.size > 0 && short.length === 0;

		if (!couponsOk && _pay === 1) {
			_pay = 0;
		}

		const zenyOption = pay.querySelector('.option[data-pay="0"]');
		zenyOption.querySelector('.total').textContent = 'Total: ' + zeny(total);
		zenyOption.querySelector('.have').textContent = 'You have ' + zeny(Session.zeny | 0);

		const couponOption = pay.querySelector('.option[data-pay="1"]');
		const parts = [...needed].map(([id, count]) => `${count} ${itemName(id)}`);
		if (rest) {
			parts.push(zeny(rest));
		}
		couponOption.querySelector('.total').textContent = needed.size
			? 'Total: ' + parts.join(' + ')
			: 'No coupon for this look';
		const have = couponOption.querySelector('.have');
		have.className = 'have';
		if (!needed.size) {
			have.textContent = '';
		} else if (short.length) {
			have.classList.add('short');
			have.textContent = 'Not enough: ' + short.map(([id]) => itemName(id)).join(', ');
		} else {
			have.textContent =
				'You have ' + [...needed].map(([id]) => `${itemCount(id)} ${itemName(id)}`).join(', ');
		}
		couponOption.classList.toggle('off', !couponsOk);

		pay.querySelectorAll('.option').forEach((option) => {
			option.classList.toggle('on', parseInt(option.getAttribute('data-pay'), 10) === _pay);
		});
	}

	root.querySelector('.buy').disabled = !order.length || _busy;
}

/**
 * Buy it: say how to pay, when the NPC asked to be told, then send the order
 */
async function buy() {
	const order = changes();
	if (!order.length || _busy) {
		return;
	}

	_busy = true;
	refresh();

	if (_offer && _offer.pay && _ask) {
		try {
			const answer = await _ask(_offer.pay, `pay ${_pay}`);
			if (!/^ok\b/.test(String(answer))) {
				throw new Error(String(answer) || 'no answer');
			}
		} catch (error) {
			console.error('[Stylist] payment choice not taken:', error);
			ChatBox.addText('The stylist did not take your payment choice; nothing was bought.', ChatBox.TYPE.ERROR);
			_busy = false;
			refresh();
			return;
		}
		// The window may have been closed while the server answered.
		if (!_choice) {
			return;
		}
	}

	const pkt = new PACKET.CZ.REQ_STYLE_CHANGE2();
	// Zero means "leave this one alone" to the server, which is exactly what
	// an untouched look means here.
	order.forEach((look) => {
		pkt[look.field] = look.index(_choice[look.prop]);
	});
	Network.sendPacket(pkt);
}

/**
 * The server's answer.
 *
 * On success it has already sent the look changes as ordinary sprite updates,
 * so the character on the map is the truth now and the window closes.
 *
 * On a refusal the window stays open with the choice as it was, so the player
 * can change it or the way to pay and try again. The server does not say why
 * it refused; with rAthena's own table it is nearly always the price or the
 * coupon.
 *
 * @param {object} pkt - PACKET.ZC.STYLE_CHANGE_RES
 */
function onStyleChangeResult(pkt) {
	if (!_choice) {
		return;
	}

	_busy = false;

	if (pkt.flag) {
		ChatBox.addText(
			'The stylist cannot do that one (not enough Zeny, or a coupon missing).',
			ChatBox.TYPE.ERROR
		);
		refresh();
		return;
	}

	Stylist.remove();
}

/**
 * Hook the answer
 */
Network.hookPacket(PACKET.ZC.STYLE_CHANGE_RES, onStyleChangeResult);

/**
 * Export
 */
export default UIManager.addComponent(Stylist);
