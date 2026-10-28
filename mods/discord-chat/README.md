# discord-chat

Adds a `#discord` chat channel to the game and joins it to a Discord channel.
Whatever players say in it is posted to Discord under each character's name,
and with a bot set up, what people write in Discord shows in it too.

## Setting it up

1. Set a channel webhook in **Settings → General → Discord announcements**
   (see [discord-announcements](../discord-announcements/README.md) for how to
   get one) and press **Send a test**.
2. Turn this mod on under **Settings → Mods** and **Apply**.
3. For replies from Discord, set a bot token in the same place, under
   **Replies from Discord**. Settings lists the steps: make a bot, switch on
   its Message Content intent, add it to your server and paste its token.

## Talking in #discord

With **Everyone joins #discord** on (the default), every player is in the
channel from login. Otherwise a player joins with `@join #discord`, and leaves
with `@leave #discord`.

- To say something in it, whisper to `#discord`: put `#discord` in the
  whisper name box and type the message.
- To make ordinary chat go there instead, type `@channel bind #discord`.
  `@channel unbind` puts it back.

Messages show in game as `#discord Name : message`, and in Discord under the
character's name. What people write in Discord shows as
`#discord Ann (Discord) : message`, a few seconds later. The game can only
show plain letters, so accents are dropped and emoji become `?`. Discord formatting is shown as typed, and mentions are
switched off, so a message can't ping `@everyone`.

## What it needs

The server's `channel_log` extension, which this mod switches on
(`db/extension_db.yml`). It writes each message in `#discord` to the map
server's log, and the app follows that log while a webhook is set. A server
built without the extension keeps `#discord` working in game, says so in the
map server's log, and posts nothing to Discord.

Replies come the other way through the app: it reads the webhook's channel as
the bot (skipping its own posts and other bots), and hands each message to the
server with `ragnarok-stack host-message discord <name> <text>`. That writes
it to the `host_messages` table, and this mod's script reads the table every
two seconds and says it in `#discord`. Script messages never reach
`channel_log`, so nothing comes back around.
