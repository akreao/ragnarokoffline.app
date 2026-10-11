// The map editor's MCP tools, transport aside: every command is a tool
// (`map.open` is `map_open`), and screenshots come back as images.
//
// Two transports use it: `ragnarok-map mcp` on stdin/stdout (cli.js), and the
// app's local API for agents at /mcp/map (electron/map-editor.js), the same
// listener the game agent's /mcp is on.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../lib/commands.js';
import { PAGE_COMMANDS } from '../lib/page-commands.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** Every command, page and editing, with its description and arguments. */
export function allCommands() {
	return { ...PAGE_COMMANDS, ...Object.fromEntries(Object.entries(COMMANDS).map(([k, v]) => [k, { describe: v.describe, args: v.args }])) };
}

const toolName = n => n.replace(/\./g, '_');

export function toolList() {
	return Object.entries(allCommands()).map(([name, spec]) => ({
		name: toolName(name),
		description: spec.describe,
		inputSchema: {
			type: 'object',
			properties: Object.fromEntries(Object.entries(spec.args).map(([a, [type, description]]) => [a, { type: type === 'object' ? 'object' : type === 'number' ? 'number' : type === 'boolean' ? 'boolean' : 'string', description }])),
			required: Object.entries(spec.args).filter(([, s]) => !s[2]).map(([a]) => a),
		},
	}));
}

/**
 * @param {object} opts
 *   run(cmd, args) -> Promise<result>   runs one command in an editor
 * @returns handle(message) -> Promise<reply | null>; null for a notification
 */
export function createMcp({ run }) {
	const tools = toolList();
	const byTool = new Map(Object.keys(allCommands()).map(n => [toolName(n), n]));
	const guide = path.join(HERE, '..', 'AGENTS.md');
	return async function handle(msg) {
		const { id, method, params } = msg || {};
		if (id === undefined) return null; // a notification
		const reply = result => ({ jsonrpc: '2.0', id, result });
		const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
		if (method === 'initialize') {
			const want = params && params.protocolVersion;
			return reply({
				protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
				capabilities: { tools: {} },
				serverInfo: { name: 'ragnarok-map', version: '1.0.0' },
				instructions: fs.existsSync(guide) ? fs.readFileSync(guide, 'utf8').slice(0, 6000) : 'Ragnarok Offline map editor.',
			});
		}
		if (method === 'ping') return reply({});
		if (method === 'tools/list') return reply({ tools });
		if (method === 'tools/call') {
			const name = byTool.get(params && params.name);
			if (!name) return fail(-32602, `no tool ${params && params.name}`);
			try {
				const result = await run(name, (params && params.arguments) || {});
				if (result && result.png) {
					const { png, ...rest } = result;
					return reply({ content: [{ type: 'image', data: png, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(rest) }] });
				}
				return reply({ content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 1) }] });
			} catch (e) {
				return reply({ content: [{ type: 'text', text: e.message }], isError: true });
			}
		}
		return fail(-32601, `no method ${method}`);
	};
}
