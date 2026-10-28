// A DPS meter: the player's hits and, unless turned off, those of their side
// (homunculus, mercenary, party members and AI companions, companions' pets),
// from the client API's combat:damage event (one per damage packet the client
// receives), in a window of the plugin's own (api.ui.window).

// combat:damage `by` values the meter counts, per the count_party setting.
export const OWN_SOURCES = new Set(['me']);
export const SIDE_SOURCES = new Set(['me', 'homun', 'merc', 'party', 'companion-pet']);
const KIND_LABEL = { me: 'You', homun: 'Homunculus', merc: 'Mercenary', party: 'Party member', 'companion-pet': 'Companion pet' };

/** The name a hit is shown under in the breakdown. */
export function sourceLabel({ by, name }) {
    if (by === 'me') return 'You';
    return (typeof name === 'string' && name) || KIND_LABEL[by] || 'Other';
}

/**
 * The arithmetic, kept apart from the window so it can be tested. Times are
 * milliseconds. A fight starts with a hit and ends `idleMs` after the last
 * one; the next hit starts a new fight. Total and biggest run until reset().
 * Each hit has a source key (an entity id) and a label; read() gives every
 * source's share of the fight and of the total, biggest total first, with
 * each source's DPS over the same fight clock.
 */
export function createMeter({ idleMs = 5000 } = {}) {
    let total = 0, biggest = 0, hits = 0;
    let fight = null; // { start, last, damage, bySource: Map<key, damage> }
    let sources = new Map(); // key -> { label, total }
    return {
        hit(amount, now, key = 'me', label = 'You') {
            if (!Number.isFinite(amount) || amount <= 0) return;
            if (!fight || now - fight.last > idleMs) fight = { start: now, last: now, damage: 0, bySource: new Map() };
            fight.last = now;
            fight.damage += amount;
            fight.bySource.set(key, (fight.bySource.get(key) || 0) + amount);
            const source = sources.get(key) || { label, total: 0 };
            source.label = label;
            source.total += amount;
            sources.set(key, source);
            total += amount;
            hits += 1;
            biggest = Math.max(biggest, amount);
        },
        read(now) {
            const active = Boolean(fight) && now - fight.last <= idleMs;
            // While the fight is on, the clock runs; once it is over it stops at
            // the last hit. At least one second, so one hit is not "infinite" DPS.
            const ms = fight ? Math.max(1000, (active ? now : fight.last) - fight.start) : 0;
            const perSecond = damage => (fight ? damage / (ms / 1000) : 0);
            return {
                active,
                dps: perSecond(fight ? fight.damage : 0),
                fightDamage: fight ? fight.damage : 0,
                fightSeconds: ms / 1000,
                total, biggest, hits,
                sources: [...sources].map(([key, { label, total: sourceTotal }]) => {
                    const fightDamage = fight?.bySource.get(key) || 0;
                    return { key, label, fightDamage, dps: perSecond(fightDamage), total: sourceTotal };
                }).sort((a, b) => b.total - a.total),
            };
        },
        reset() { total = 0; biggest = 0; hits = 0; fight = null; sources = new Map(); },
    };
}

const STYLE = `
.meter { padding: 8px 10px; display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; }
.meter b { color: #556; font-weight: normal; }
.meter span { text-align: right; font-variant-numeric: tabular-nums; }
.meter .dps { font-size: 18px; font-weight: bold; color: #273256; }
.meter .idle { color: #889; }
.rows { padding: 0 10px 6px; display: grid; grid-template-columns: 1fr auto auto; gap: 2px 10px; border-top: 1px solid #ccd; padding-top: 6px; margin: 0 0 4px; }
.rows b { color: #556; font-weight: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rows span { text-align: right; font-variant-numeric: tabular-nums; }
.rows .head { color: #889; font-size: 10px; }
.actions { padding: 0 10px 8px; text-align: right; }
.actions button { font: inherit; padding: 2px 10px; }
.launcher { position: fixed; right: 145px; top: 92px; width: 43px; height: 22px; z-index: 8999; font: bold 11px Tahoma, sans-serif; padding: 0;
  border: 1px solid #6b7a99; border-radius: 4px; background: linear-gradient(#f3f6fd, #d3dbef); color: #273256; cursor: pointer; display: none; }
.launcher.ingame { display: block; }
`;

const number = value => Math.round(value).toLocaleString();

export default function init(parameters, api) {
    if (api?.version !== 1) throw new Error('dps-meter requires client API 1');
    const seconds = Number(parameters?.fight_timeout);
    const counted = parameters?.count_party === false ? OWN_SOURCES : SIDE_SOURCES;
    const meter = createMeter({ idleMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000 });
    const win = api.ui.window({ id: 'dps', title: 'DPS meter', width: 230, height: counted === OWN_SOURCES ? 190 : 300 });
    win.body.innerHTML = `<style>${STYLE}</style>
        <div class="meter">
            <b>DPS</b><span class="dps" data-k="dps">0</span>
            <b>This fight</b><span data-k="fight">0</span>
            <b>Fight time</b><span data-k="time">0s</span>
            <b>Total</b><span data-k="total">0</span>
            <b>Biggest hit</b><span data-k="biggest">0</span>
            <b>Hits</b><span data-k="hits">0</span>
        </div>
        <div class="rows" data-k="rows"></div>
        <div class="actions"><button>Reset</button></div>`;
    const field = key => win.body.querySelector(`[data-k="${key}"]`);
    const fields = Object.fromEntries(['dps', 'fight', 'time', 'total', 'biggest', 'hits'].map(key => [key, field(key)]));

    const rows = field('rows');
    function draw() {
        const now = performance.now();
        const r = meter.read(now);
        fields.dps.textContent = number(r.dps);
        fields.dps.classList.toggle('idle', !r.active);
        fields.fight.textContent = number(r.fightDamage);
        fields.time.textContent = `${r.fightSeconds.toFixed(1)}s`;
        fields.total.textContent = number(r.total);
        fields.biggest.textContent = number(r.biggest);
        fields.hits.textContent = number(r.hits);
        // Who dealt what: only worth a table once there is more than one source.
        rows.hidden = r.sources.length < 2;
        if (!rows.hidden) {
            rows.replaceChildren(...['', 'DPS', 'Total'].map(text => Object.assign(document.createElement('span'), { className: 'head', textContent: text })));
            for (const source of r.sources) {
                const name = Object.assign(document.createElement('b'), { textContent: source.label, title: source.label });
                const dps = Object.assign(document.createElement('span'), { textContent: number(source.dps) });
                const share = Object.assign(document.createElement('span'), { textContent: number(source.total) });
                rows.append(name, dps, share);
            }
        }
    }

    win.body.querySelector('.actions button').addEventListener('click', () => { meter.reset(); draw(); });
    api.on('combat:damage', hit => {
        // Before by existed (an older bridge), own was the only thing to go on.
        const by = hit.by || (hit.own ? 'me' : 'other');
        if (counted.has(by)) meter.hit(hit.amount, performance.now(), by === 'me' ? 'me' : hit.source, sourceLabel({ by, name: hit.name }));
    });

    // Redraw only while the window is open; the clock in "Fight time" moves.
    const timer = setInterval(() => { if (win.isOpen()) draw(); }, 250);
    api.cleanup(() => clearInterval(timer));

    let inGame = false;
    let launcher = null;
    const toggle = () => { win.toggle(); if (win.isOpen()) draw(); };
    const setInGame = value => {
        inGame = value;
        launcher?.classList.toggle('ingame', value);
        if (!value && win.isOpen()) win.hide();
    };
    api.on('map:enter', () => setInGame(true), { replay: true });
    api.on('map:leave', () => setInGame(false));

    const onKey = event => { if (inGame && event.altKey && event.code === 'KeyN') { event.preventDefault(); toggle(); } };
    addEventListener('keydown', onKey, true);
    api.cleanup(() => removeEventListener('keydown', onKey, true));
    if (parameters?.show_button !== false) {
        const host = document.createElement('div');
        const root = host.attachShadow({ mode: 'open' });
        // Under the in-game database's DB button (top 66px), same edge.
        root.innerHTML = `<style>${STYLE}</style><button class="launcher${inGame ? ' ingame' : ''}" title="DPS meter (Alt+N)">DPS</button>`;
        launcher = root.querySelector('button');
        // The map is under the button: a press here must not walk the character there.
        launcher.addEventListener('mousedown', event => event.stopImmediatePropagation());
        launcher.addEventListener('click', toggle);
        document.body.appendChild(host);
        api.cleanup(() => host.remove());
    }
}
