# dsh-minecraft

Play Minecraft from DeepSeek Harness. The agent joins a real server through a
live [Mineflayer](https://github.com/PrismarineJS/mineflayer) bot and looks,
walks, and mines through tools.

```
dsh plugin --profile <name> add dsh-minecraft
```

## Twelve tools

| Tool | What it does |
|---|---|
| `mc_connect` | Join a server. Defaults to `127.0.0.1:25565`. |
| `mc_observe` | Position, health, food, inventory, nearby blocks and entities — **plus what happened since the last look**. |
| `mc_find` | Nearest **exposed** blocks of a kind, with coordinates. |
| `mc_goto` | Walk somewhere, pathfinding around obstacles. |
| `mc_dig` | Break a block and collect its drop. |
| `mc_craft` | Make an item from what is already in the inventory. |
| `mc_place` | Put a block from the inventory into the world. |
| `mc_equip` | Hold a named item — digging uses whatever is in hand. |
| `mc_smelt` | Smelt in a furnace that is already standing, with a fuel you name. |
| `mc_attack` | Swing at the nearest entity of a kind, within melee reach. |
| `mc_eat` | Eat a carried food item, then put back what was held. |
| `mc_disconnect` | Leave, and finish the recording. |

Given one sentence — *obtain an iron pickaxe* — an agent works out planks,
sticks, a crafting table, a wooden pickaxe, cobblestone, a stone pickaxe, iron
ore, a furnace and the smelt, in about twelve minutes. None of that sequence is
in the plugin.

Each exposes **one game action**. None of them plans, and none of them repairs
a mistake. `mc_craft` fails if no crafting table is in range and says so — it
does not quietly place one. It reports which ingredients are short — it does
not go and get them. There is no `mc_get_diamond`, and there will not be one.

That is not purity. A board measures whatever the entrant was *not* handed. If
the recipe chain lives in the plugin, the board stops measuring whether an
agent can play and starts measuring how good this plugin is — and every
entrant that installs it scores the same.

## It is not allowed to see through walls

This is the part worth stealing if you are building your own.

Mineflayer reads the client's copy of the world, so **every block query is
x-ray by default**. `findBlocks` walks raw chunk-section data with no line of
sight test whatsoever. Near spawn, radius 32:

```
coal_ore  303 hits        iron_ore  30 hits
```

Every one of them buried under solid rock. The entire difficulty of obtaining
diamond is *not knowing where it is* — dig to Y-59, strip mine, get lucky. A
tool that answers that with a query does not make the agent a better player.
It deletes the task.

So a block is reported only if it has at least one uncovered face, which is
roughly what a player walking past an opening can see. Measured against the
live world, filtered versus unfiltered:

```
coal_ore     303 -> 0      grass_block  400 -> 400
iron_ore      30 -> 0      stone        400 -> 99
```

Buried ore gone; surface perception untouched. The same filter applies to
`mc_observe`'s block census, which had the identical hole.

**This is a floor on the deception, not a model of vision.** An exposed seam
in a cave nobody has visited is still reported. A real line-of-sight test would
be stricter — and would also stop the agent remembering what it walked past,
which is not obviously right.

### `mc_observe` reports what you missed

An agent is only awake while a tool is running, and the world keeps moving in
between. So observation drains a small journal of events — damage taken, a
death, a kick — that accumulated since the previous look:

```
at 6, 64, -8 on grass_block -- health 14, food 20, overworld
inventory: spruce_log x3
blocks within reach: dirt x165, grass_block x80, spruce_leaves x31
entities: zombie 6.2m
since you last looked: health 14, food 20
```

Without that line the agent walks for a minute, arrives on 14 health, and has
no idea why.

## Watching it play

This is on by default. Connect, and the bot reports a link:

```
watch live at http://localhost:3017
```

Open it and you are looking through the bot's eyes while it plays. No
configuration, no file, no ffmpeg. `MC_VIEW=off` turns it off; the port moves up
from 3017 if something else has it.

### It builds its own native module

prismarine-viewer needs `canvas`, and **a DSH profile installs plugin
dependencies without running install scripts** — so the package arrives complete
except for the one binary that matters:

```
Cannot find module '../build/Release/canvas.node'
```

Earlier versions printed that, told you to run `npm rebuild canvas`, and gave
up. Telling someone to run a command the code could run itself, for a feature
they asked for, is a bug with instructions attached — so it runs it. Takes about
three seconds, once, and says `(built the canvas module first)` when it does.

## Recording an mp4

Watching is enough for a person. The evaluation board wants a file, and scores
a run with no video at **0.0** however far it got.

```
MC_RECORD_DIR=/somewhere  dsh --profile <name> "...play..."
```

Frames are screencast from the same live view through headless Chrome and muxed
by ffmpeg at `mc_disconnect`. `outcome.json` is written **continuously**, so a
run killed at its time limit still leaves both a frames directory and a report —
which is what happens to most timed runs.

| Variable | Effect |
|---|---|
| `MC_RECORD_DIR` | Where to write `frames/`, `run.mp4` and `outcome.json`. Unset means live-view only. |
| `MC_SEED` | Recorded into `outcome.json`; the plugin cannot read the server's seed. |
| `CHROME_PATH` | Defaults to the macOS Google Chrome path. |
| `MC_VIEW` | `off` disables the live view. |

Recording is **not a tool**: being filmed is not one of the agent's decisions.

## Requirements

A Minecraft **Java 1.20.4** server the bot can reach, in offline mode.

Java is not bundled and is often not on `PATH` even when installed —
`brew install openjdk@21` leaves it at
`/opt/homebrew/opt/openjdk@21/bin/java` unless linked. Paper 1.20.4 wants
Java 17–21; a newer JDK on the same machine is not a safe default.

## Bugs worth knowing about, because every one looked like gameplay

**Pathfinding silently did nothing.** `mineflayer-pathfinder` is CJS, and
Node's named-export detection exposes `Movements` and `pathfinder` at the top
level but **not `goals`** — that one only exists on `default`. Destructuring
the top level throws no error; it yields `undefined`, and every move returns:

```
did not arrive (Cannot read properties of undefined (reading 'GoalNear'))
```

which reads like a pathfinding failure. Import it as:

```js
const pf = await import('mineflayer-pathfinder')
const { goals, Movements } = pf.default ?? pf
```

**Digging collected nothing.** Breaking a block leaves the drop on the ground;
it is only picked up by walking over it. The agent saw `dug spruce_log, gained
0 item(s)` and could not tell a broken tool from a log lying half a metre away.

The first fix walked to the *block* coordinate — and was wrong in a way that
only showed up later. An agent mining a trunk from halfway up sent the bot to a
point in mid-air while the logs lay on the ground below; it spent the rest of
its run reasoning that the server was withholding drops. `mc_dig` now walks to
the **item entity**, and when it still cannot reach it, says where it is lying
instead of offering one vague sentence for three different causes.

**Crafting reported success over an unchanged inventory.** `bot.craft` can
resolve having done nothing — the window transaction is occasionally dropped
and no error is raised. The tool said `crafted wooden_pickaxe -- gained
nothing` while the materials sat untouched. It now waits for the inventory to
actually change and reports what the world says, not what the promise did.

None of these surfaced from calling the tools and checking they returned. Every
one took giving an agent a real goal and watching it fail while every call
looked fine.

**Walking silently unequipped the bot.** Pathfinder bridges gaps by placing
blocks, which puts that block in hand. Equip a pickaxe, walk, dig — and the bot
is swinging dirt while the stone drops nothing. Walking is not a statement about
what to hold, so it now restores. The same defect was later found in `mc_place`,
which equipped what it placed and left it there.

**`items_gained` counted the wrong thing.** It measured total inventory change,
not whether *this block's* drop arrived. With clutter on the floor — pathfinder
digs dirt to reach a spot, the bot steps on a stray item — the total rose by one
and a cobblestone left lying on the ground was recorded as collected. It now
reads `block.drops` and reports `1 x cobblestone` instead of a bare number. The
defect was there from the first version and stayed invisible while the ground
happened to be clean.

**`mc_goto` could hang forever.** `pathfinder.goto` takes no timeout —
`thinkTimeout` bounds the search, not the walking — so an agent stood on one
coordinate for ten minutes with no error and no log line until its run was
killed. Bounded now at 60s. Adding the ceiling then exposed a worse one:
`pathfinder.stop()` leaves an internal flag set that nulls the *next* goal, so a
single timeout used to disable movement for the rest of the run.

**Damage was reported after it mattered.** An agent is blind between tool calls,
so hits only surfaced on the next `mc_observe`. On difficulty easy a run reached
an iron pickaxe in twelve minutes, then died four times to the same skeleton —
health went 9, 6.5, 4, 1.5, 0 inside one window of repeated digging. `mc_dig`
now reports damage taken while digging and `mc_goto` aborts a walk the moment
the bot starts taking hits. It reports; it does not react. Fighting back and
running away are still the agent's problem, and there is no tool for either.

## License

MIT
