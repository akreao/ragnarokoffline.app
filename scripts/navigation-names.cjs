/**
 * English names for the navigation tables, for patch-navigation-client.cjs.
 *
 * kRO's navi_*_krpri.lub tables name maps, NPCs, monsters and links in Korean.
 * ROenglishRE's SystemEN/Navi_Data.lub maps each Korean name to English, and
 * kRO's own navi_f_krpri.lub swaps them in at lookup time. The client reads
 * the tables directly, so this does the same while each table is loaded --
 * in Lua, so a name and its key are compared as the same bytes.
 *
 * A name the dictionary does not hold is left as it is: an iRO table already
 * in English, or an entry newer than the translation. With the translation off
 * there is no SystemEN to load, and every table keeps the client's own names.
 *
 * The navigation-server-warps mod adds navi_link_server.lub: the server's own
 * warp portals (stack/src/navwarp.rs). Loaded with the dictionary, it takes
 * the place of the GRF's portals (type 200) in Navi_Link, and the GRF's
 * Navi_Distance, which describes routes over those portals by their ids, is
 * set aside. The GRF's other links -- sailors, signposts -- stay. Without the
 * mod the file is not there and nothing changes.
 */
'use strict';

// Injected next to loadLuaValue in the bundle. The column each table keeps its
// name in (Lua, 1-based), and the Navi_Data table that translates it. NPC rows
// of class 99999 are left alone, as navi_f does.
const IMPLEMENTATION = `const NAVIGATION_NAME_COLUMNS = {
	Navi_Map: [2, "Navi_Data_Map", false],
	Navi_Npc: [5, "Navi_Data_NPC", true],
	Navi_Mob: [5, "Navi_Data_Mob", false],
	Navi_Link: [5, "Navi_Data_Link", false]
};
let _navigationNamesLoad = null;
let _navigationNamesTurn = null;
// Every table waits for the dictionary, so without this they would all resume
// together and run lua.doFile interleaved on the one Lua state, and wasmoon
// tracks a running chunk by its slot on that state's stack: overlapping runs
// remove each other's slots and corrupt the heap ("memory access out of
// bounds", the renderer gone). Each table is let through in a task of its own
// instead, as it would have arrived from Client.loadFile, and a table's
// doFile settles within that task.
function navigationNamesTurn() {
	_navigationNamesTurn = (_navigationNamesTurn || loadNavigationNames()).then(() => new Promise((resolve) => setTimeout(resolve, 0)));
	return _navigationNamesTurn;
}
// What every navigation table waits for: the dictionary, then the server's
// portals. One after the other, each in its own Client.loadFile callback, for
// the reason above.
function loadNavigationNames() {
	const load = (file, what) => new Promise((resolve) => {
		Client.loadFile(file, async (data) => {
			try {
				lua.mountFile(file, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
				await lua.doFile(file);
				lua.unmountFile(file);
			} catch (error) {
				console.warn("(" + file + ") " + what, error);
			}
			resolve();
		}, () => resolve());
	});
	if (!_navigationNamesLoad) _navigationNamesLoad = load("SystemEN/Navi_Data.lub", "navigation names stay as the tables have them:")
		.then(() => load(DB.LUA_PATH + "navigation/navi_link_server.lub", "routes keep the client's own portals:"));
	return _navigationNamesLoad;
}
// Lua: the server's portals in place of the GRF's, and the GRF's route
// distances, which name its portals by id, set aside.
function navigationServerLinks(variableName) {
	const present = 'type(Navi_Link_Server) == "table" and #Navi_Link_Server > 0';
	if (variableName === "Navi_Link") return \`
							if \${present} and type(Navi_Link) == "table" then
								local links = {}
								for _, row in ipairs(Navi_Link) do
									if row[3] ~= 200 then links[#links + 1] = row end
								end
								for _, row in ipairs(Navi_Link_Server) do links[#links + 1] = row end
								Navi_Link = links
							end\`;
	if (variableName === "Navi_Distance") return \`
							if \${present} then Navi_Distance = {} end\`;
	return "";
}
function navigationNameSwap(variableName) {
	const columns = NAVIGATION_NAME_COLUMNS[variableName];
	if (!columns) return "";
	const [column, dictionary, skipSpecial] = columns;
	return \`
							do
								local names = \${dictionary}
								if type(names) == "table" and type(\${variableName}) == "table" then
									for _, row in ipairs(\${variableName}) do
										local name = row[\${column}]
										if type(name) == "string" and names[name] ~= nil and not (\${skipSpecial} and row[4] == 99999) then
											row[\${column}] = names[name]
										end
									end
								end
							end\`;
}
`;

const LOAD_NEEDLE = 'await lua.doFile(file_path);';
const EXTRACT_NEEDLE = 'extractValue(to_json(${variable_name}))';

/**
 * Edit loadLuaValue's source: load the dictionary and the server's portals
 * before a navigation table, then put the portals in and rename the table's
 * entries before it is converted to JSON.
 */
function patchLoader(loader) {
  if (loader.split(LOAD_NEEDLE).length !== 2) throw Error('Navigation Lua load call not found');
  if (loader.split(EXTRACT_NEEDLE).length !== 2) throw Error('Navigation value extraction not found');
  return IMPLEMENTATION + loader
    .replace(LOAD_NEEDLE, `if (NAVIGATION_NAME_COLUMNS[variable_name] || variable_name === "Navi_Distance") await navigationNamesTurn();\n\t\t\t\t${LOAD_NEEDLE}`)
    .replace(EXTRACT_NEEDLE, '${navigationServerLinks(variable_name)}${navigationNameSwap(variable_name)}\n\t\t\t\t\t\t\t' + EXTRACT_NEEDLE);
}

module.exports = { IMPLEMENTATION, patchLoader };
