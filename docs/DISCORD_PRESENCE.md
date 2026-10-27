# Discord Rich Presence

While the game window is open, the player's Discord profile can say what they
are playing:

> **Ragnarok Offline**
> Lv 99/50 Assassin Cross
> Prontera · In a party (3 of 12)
> 12:34 elapsed

## How it works

- `patches/client/DiscordPresence.mjs`, wired in by `ExtensionBridge.mjs`,
  reads the character from the game page (map, job id, base and job level,
  party size, name). It sends `presence_update` to the app when one of those
  changes: on entering a map, and on a slow 15-second look for level and party
  changes. It does nothing in a browser tab, which has no `invoke`.
- `presence_update` in `electron/main.js` takes reports only from the game
  window's main frame. It keeps short strings and small numbers, and nothing
  else (`discordState`), because on a joined world the page comes from the other
  host.
- `electron/discord-presence.js` turns the report into an activity
  (`buildActivity`) and sends it to the Discord desktop app over its local IPC
  socket (`discord-ipc-0..9`), using Discord's framed-JSON protocol. It has no
  dependencies. Changes closer together than five seconds are merged, to stay
  under Discord's rate limit. When Discord isn't running, it checks again every
  30 seconds and logs that once.
- Job names come from `tools/control-panel/job-names.js` (rAthena's own English
  names), so they don't depend on the client's code page.

## Who gets it

Only programs on the player's own computer can set their Discord status. So
presence works for:

- the host, playing in the app;
- a friend who joins through the app (Join), whose own app sets their own status.

A friend playing in a web browser gets none. A browser page cannot reach the
Discord socket, and the host cannot set another person's status.

## Settings

Settings → General → Discord. Each switch is saved straight away, with no
server restart.

| Key | Default | Shows |
|---|---|---|
| `discord_presence` | on | anything at all |
| `discord_show_name` | **off** | the character's name |
| `discord_show_map` | on | the map name |
| `discord_show_party` | on | "In a party" and its size |

Job and level are always shown while presence is on.

## Setting up the Discord application

1. At <https://discord.com/developers/applications>, create an application. Its
   name is what Discord shows as the game ("Playing Ragnarok Offline").
2. Under **Rich Presence → Art Assets**, upload the logo with the key `logo`
   (at least 512×512).
3. Copy the **Application ID**. It isn't secret.
4. Either put it in `DISCORD_APP_ID` in `electron/main.js`, or, for a test, set
   it when you start the app:

   ```fish
   set -x RAGNAROK_OFFLINE_DISCORD_APP_ID 123456789012345678
   npm start
   ```

   With no ID, the feature is off, and Settings says "Not set up in this build".

## Linux

Wayland doesn't matter here, because this uses a socket and not the window.
The socket is looked for in `$XDG_RUNTIME_DIR`. It is also looked for in the
folders the Flatpak (`app/com.discordapp.Discord`) and Snap (`snap.discord`)
builds use, then `$TMPDIR` and `/tmp`. Vesktop needs its arRPC option turned on.
Discord running in a web browser has no socket.
