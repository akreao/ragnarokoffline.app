# discord-chat

Adds a `#discord` chat channel to the game. Whatever players say in it is
posted to your Discord channel, under each character's name.

## Setting it up

1. Set a channel webhook in **Settings → General → Discord announcements**
   (see [discord-announcements](../discord-announcements/README.md) for how to
   get one) and press **Send a test**.
2. Turn this mod on under **Settings → Mods** and **Apply**.

## Talking in #discord

With **Everyone joins #discord** on (the default), every player is in the
channel from login. Otherwise a player joins with `@join #discord`, and leaves
with `@leave #discord`.

- To say something in it, whisper to `#discord`: put `#discord` in the
  whisper name box and type the message.
- To make ordinary chat go there instead, type `@channel bind #discord`.
  `@channel unbind` puts it back.

Messages show in game as `[Discord] Name : message`, and in Discord under the
character's name. Discord formatting is shown as typed, and mentions are
switched off, so a message can't ping `@everyone`.

## What it needs

The server's `channel_log` extension, which this mod switches on
(`db/extension_db.yml`). It writes each message in `#discord` to the map
server's log, and the app follows that log while a webhook is set. A server
built without the extension keeps `#discord` working in game, says so in the
map server's log, and posts nothing to Discord.

Replies from Discord into the game are not part of this yet.
