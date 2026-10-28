# DPS meter

A small window that shows how hard you are hitting. Install it from
Settings → Mods → Find Mods. In game, press **Alt+N** or the **DPS**
button under the **DB** button to open it. Drag it by its title bar; it
remembers where you left it.

| Line | What it means |
|---|---|
| DPS | damage per second over the current fight |
| This fight | damage dealt in the current fight |
| Fight time | from the fight's first hit to now, or to its last hit once it is over |
| Total | all damage since the window was last reset |
| Biggest hit | the largest single hit since the last reset |
| Hits | how many hits landed since the last reset |

A fight starts with your first hit and ends after five seconds with no hits
(change it in the mod's settings). The next hit starts a new fight. **Reset**
clears everything.

It counts your side's damage: your character, your homunculus and mercenary,
your party members (AI companions are party members) and the pets the
companion mods spawn for them. Plain attacks, criticals, double attacks, the
off hand when dual wielding, and skills all count; misses count as nothing.
The top lines are everyone together. Once more than one of you has hit, a
table below lists each one (**You**, then companions by name) with their DPS
for this fight and their total, biggest total first. Other players and
monsters never count.

To count only yourself, turn off **Count companions' damage** in the mod's
settings.

The numbers are what the server told the client, from the client API's
`combat:damage` event ([docs/MODDING.md](../../../docs/MODDING.md#client-api-1)),
so the meter needs app 1.7.5 or later.
