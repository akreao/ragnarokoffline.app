'use strict';
// Settings → Mods: release notes on the Updates tab, and which questions are
// asked in the settings window and which stay native. Read from the sources,
// as mod-relink.test.cjs does: the decisions are in where the code asks.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'src', 'settings.html'), 'utf8');

const fn = (source, name) => {
	const found = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\r?\\n\\}\\r?\\n`));
	assert.ok(found, `${name} is defined`);
	return found[0];
};

// Release notes are text a mod's author wrote on GitHub.
test('release notes are shown as text, never as HTML', () => {
	const block = fn(settings, 'notesBlock');
	assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML|outerHTML/);
	assert.match(block, /el\('p'/);
});

// The page renders text the internet wrote; the decision to put a release's
// code into the server is not the page's (installFromSource's own comment).
test('an install or update from GitHub is confirmed in a native box, without release notes', () => {
	const install = fn(main, 'installFromSource');
	assert.match(install, /dialog\.showMessageBox/);
	assert.doesNotMatch(install, /release\.notes|Release notes:/, 'notes are on the Updates tab and the release page, not in the box');
	assert.doesNotMatch(fn(settings, 'askInWindow'), /installFromSource|install_registry_mod/);
});

test('Remove asks in the settings window, and natively only for a caller that did not', () => {
	const remove = main.match(/\tremove_mod: async [\s\S]*?\r?\n\t\},\r?\n/);
	assert.ok(remove, 'remove_mod handler found');
	assert.match(remove[0], /if \(asked !== true\) \{[\s\S]*?dialog\.showMessageBox/);
	assert.match(settings, /invoke\('remove_mod', \{ name: m\.name, asked: true \}\)/);
});

test('folder or archive is asked in the settings window and passed on as kind', () => {
	assert.match(fn(main, 'pickFolderOrArchive'), /kind === 'folder' \|\| kind === 'archive'/);
	for (const handler of ['install_mod', 'install_skin']) {
		assert.match(main, new RegExp(`\\t${handler}: async \\(\\{ kind \\} = \\{\\}\\) =>`));
		assert.match(settings, new RegExp(`invoke\\('${handler}', kind === 'any' \\? \\{\\} : \\{ kind \\}\\)`));
	}
});
