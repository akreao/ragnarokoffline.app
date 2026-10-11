'use strict';
// A window-less map editor for `ragnarok-map` in a source checkout with no
// Playwright: Electron opens the page served by `ragnarok-map` in a hidden
// window and keeps it open until the CLI is done with it. (The shipped app
// does the same through its own window: see electron/map-editor.js.)
//
//   electron server/headless-electron.cjs <url> [width] [height]

const { app, BrowserWindow } = require('electron');

const [url, width = '1280', height = '800'] = process.argv.slice(2);
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.whenReady().then(() => {
	const win = new BrowserWindow({ width: Number(width), height: Number(height), show: false, webPreferences: { offscreen: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
	win.loadURL(url);
});
app.on('window-all-closed', () => app.quit());
