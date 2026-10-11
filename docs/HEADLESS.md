# Running headless

> **Experimental.** Headless mode is new and has not been through a release's
> worth of testing yet. Try it on a machine whose world you have backed up
> (Settings → Save data → Back up everything).

Ragnarok Offline normally hosts from its game window: open the app, and the
server starts. Headless mode is the same app with no windows at all. It starts
the server on its own, and Settings opens in a browser, at an address the app
prints when it starts. It is for:

- a spare machine in a cupboard, or a home server with no screen;
- a cloud machine you reach over SSH;
- keeping a world up for friends without a game window on your desktop.

It runs on macOS, Windows and Linux, from the same install as the desktop app.
Nothing extra is needed, and nothing about the world changes: the same
characters, mods and settings, whichever way the app was started.

## Starting it

Add `--headless` to the app's own executable. Quit the desktop app first: one
copy at a time (both would want the same ports and the same data).

**macOS**

```sh
"/Applications/Ragnarok Offline.app/Contents/MacOS/Ragnarok Offline" --headless
```

**Windows** (PowerShell)

```powershell
& "$env:LOCALAPPDATA\Programs\Ragnarok Offline\Ragnarok Offline.exe" --headless
```

That is where the installer puts it for one user; for all users it is under
`C:\Program Files\Ragnarok Offline\`. A windowed program on Windows prints to no
terminal, so read the address from the file below.

**Linux** (the AppImage)

```sh
./Ragnarok.Offline-*-x86_64.AppImage --headless
```

`RAGNAROK_OFFLINE_HEADLESS=1` in the environment does the same as the flag.

It prints:

```
Ragnarok Offline 1.5.2, headless.
  Game:     http://127.0.0.1:3338/
            (this machine only; turn on LAN in Settings -> Multiplayer for others)
  Settings: http://127.0.0.1:3339/settings?token=vZTPpbZ2zMYgH9bKdLOw7wSZJbGXQpEc
            (this address signs you in; it changes every start)
            from another machine: ssh -L 3339:127.0.0.1:3339 <this host>
  Also in:  ~/.local/share/Ragnarok Offline/state/headless-admin.url
```

and then the server's progress, as the loading screen would show it, ending in
`headless: ready. Players open http://…:3338/`.

**Game** is where the game itself is: open it in any browser to play on this
world, or give it to players (see [Letting players in](#letting-players-in)).
From another machine over SSH, forward it too:
`ssh -L 3338:127.0.0.1:3338 -L 3339:127.0.0.1:3339 you@the-server`, then open
both addresses on your own computer.

The address is also written to `state/headless-admin.url` in the app's data
folder, readable only by your user:

| | |
|---|---|
| macOS | `~/Library/Application Support/Ragnarok Offline/state/headless-admin.url` |
| Windows | `%APPDATA%\Ragnarok Offline\state\headless-admin.url` |
| Linux | `~/.local/share/Ragnarok Offline/state/headless-admin.url` |

## Settings, in a browser

Open the printed address. It is the app's own Settings, every tab of it: era,
rates, accounts, mods (installing, updating, switching on and off, Apply &
restart), backups, multiplayer, population. Start, Stop and Apply restart the
server as they do in the app.

Where the app would show a native dialog, the page shows it instead:

- **"Install this mod?"**, **"Remove it?"** and the like: the same question,
  with the same buttons.
- **Choosing a file or folder**: type a path on the machine running the app,
  or, for a file (a mod's `.zip` or `.rar`, a backup to restore), upload one
  from the computer you are browsing from.
- **Change asset locations** (where `data.grf` and the rest are) opens Setup as
  a page of its own. The files have to be on the machine running the app;
  copy your client there first.

A few things are different without a screen:

| In the app | Headless |
|---|---|
| Open game | opens the game in a new browser tab |
| Open mods folder / data folder | shows the folder's path on the server |
| Copy diagnostics, Report an issue | saves diagnostics to a file in the data folder's `state/logs/` and says where |
| Copy (an invitation, a link) | copies in your browser, for anything the page itself shows |
| Tools (item and monster browsers, database browser, control panel, log viewer) | open in a new tab, under the same sign-in |
| A mod's own settings page | opens over Settings, in a sandboxed frame (below) |
| The AI agent's guide | not yet |

### A mod's own settings page

Some mods have a settings page of their own (Settings… on the mod in the Mods
tab). That page is the mod author's code, so it never gets your sign-in. It
opens in a sandboxed frame with an origin of its own: it sends no cookie,
cannot read the Settings page around it, and cannot call anything the
Settings page can. It reads its files from one address that serves only its
mod's folder, and it can do exactly what it can in the desktop app: read its
own settings, save them, and ask for the server to restart. Which mod a call is
for is decided by the frame it came from, never by what the page says.

### Who can open it

Settings can install code (mods) and replace every character with a backup, so
it is yours alone:

- **The address is the key.** Its token is made fresh at every start and
  printed only to you. Opening it swaps the token for a session cookie and
  takes the token out of the address bar.
- **It listens on this machine only** (`127.0.0.1`). From another computer,
  forward the port over SSH, and open the printed address there:

  ```sh
  ssh -L 3339:127.0.0.1:3339 you@the-server
  ```

- `--admin-port <n>` (or `RAGNAROK_OFFLINE_ADMIN_PORT`) moves it off 3339.
- The Tools pages are ours and share your session; their requests are accepted
  only from the admin page's own address.
- `--admin-host 0.0.0.0` (or `RAGNAROK_OFFLINE_ADMIN_HOST`) makes it listen on
  every network. It is plain HTTP, so anyone on the network path can read the
  token as you type it. Prefer the SSH tunnel, or a network only you are on.

Pages on other sites cannot use your session: every change needs a header a
form or a link cannot send, and the server answers only to its own address.

## Letting players in

Headless changes nothing about who can play:

- **This machine only** is the default. To let other machines on your network
  in, turn on LAN in Settings → Multiplayer and restart. Players open
  `http://<this machine's address>:3338/` in a browser, or join from their own
  copy of the app.
- **Friends over the internet**: Settings → Multiplayer → Share with friends,
  as in the app.

## Stopping it

Ctrl-C in the terminal, or `SIGTERM` from a service manager. Either stops the
server cleanly before the app exits, as quitting the desktop app does. That
can take most of a minute; wait for it. Killing it outright (`kill -9`, Task
Manager's End task) skips that.

## Starting it with the machine

**Linux, systemd** (a user service, so it runs as you and uses your data
folder):

```ini
# ~/.config/systemd/user/ragnarok-offline.service
[Unit]
Description=Ragnarok Offline (headless)
After=network-online.target

[Service]
ExecStart=/home/you/Ragnarok.Offline-1.5.2-x86_64.AppImage --headless
Restart=on-failure
TimeoutStopSec=180

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now ragnarok-offline
loginctl enable-linger you    # keep it running when you are logged out
journalctl --user -u ragnarok-offline -f    # the printed address is here
```

**macOS, launchd**: a LaunchAgent with `ProgramArguments` set to the executable
above and `--headless`, `RunAtLoad` true, and `ExitTimeOut` of 180 so a stop
has time to finish.

**Windows**: Task Scheduler, "At log on" (or at startup, running as your user),
with the program above and `--headless` as its argument. Read the address from
`headless-admin.url`.

## Linux without a display

The app is Chromium underneath, and on Linux Chromium looks for a display
(X11 or Wayland) as it starts, even when it opens no window. When neither
`DISPLAY` nor `WAYLAND_DISPLAY` is set, headless mode starts Chromium on its
built-in headless platform instead, so a server with no desktop needs nothing
installed for it.

If that fails on your machine (the app exits at once mentioning a display or
`ozone`), give it a virtual display instead:

```sh
sudo apt install xvfb
xvfb-run -a ./Ragnarok.Offline-*-x86_64.AppImage --headless
```

and please open an issue with what it printed.

## When it does not start

| What you see | What it means |
|---|---|
| It exits straight away, printing nothing | another copy is running, the desktop app or another headless one; one at a time |
| `no client data (data.grf) is set yet` | open Settings, General, Change asset locations, and point it at the client on this machine |
| `this install is set to join a friend's server` | switch to hosting in Settings → Multiplayer |
| The address says `401` or `403` | the app has restarted since; use the address it printed this time (`headless-admin.url`) |
| `EADDRINUSE` on 3339 | something else has the port: `--admin-port 3340` |

Everything it prints also goes to `state/app.log`, which Settings → Tools → Log
viewer shows in the desktop app.
