# Where this is, and the one rule that matters next

*2026-08-18. Written to be picked up cold.*

## What exists

Six tools, all verified working against a live Paper 1.20.4 server:
`mc_connect`, `mc_observe`, `mc_find`, `mc_goto`, `mc_dig`, `mc_disconnect`.

An agent given one sentence — *collect at least one wood log* — connected,
looked around, located a spruce log at (6, 66, -14), walked there, dug it, and
finished holding `spruce_log x2`. Nothing was scripted.

## What is missing, and why it is a chain

The board this plugin exists for (`Ruqii/minecraft-obtain-diamond`) cannot be
attempted yet. Diamond ore in 1.20.4 requires an iron pickaxe, iron ore
requires a stone pickaxe, stone requires a wooden pickaxe:

```
wood → planks → sticks + crafting table → wooden pickaxe
     → stone → stone pickaxe
     → iron ore → furnace → iron ingots → iron pickaxe
     → diamond
```

Every step needs crafting. Missing tools: `mc_craft`, `mc_place`, `mc_smelt`,
`mc_equip`. The task additionally requires an mp4 recording of the run.

## The other rule: no perception a player does not have

Found on 2026-08-19, and it was the more dangerous of the two.

Mineflayer reads the client's copy of the world, so **every block query is
x-ray by default**. `findBlocks` walks raw chunk-section data with no line of
sight test at all — confirmed by reading `blocks.js`, not inferred — and
`blockAt` answers just as readily through thirty metres of stone.

Measured near spawn, radius 32, before the fix:

```
coal_ore    303 hits    iron_ore    30 hits
```

Every one of them buried. The whole difficulty of obtaining diamond is *not
knowing where it is*: dig to Y-59, strip mine, get lucky. `mc_find` answered
that with a query. That does not make the agent a better player — it deletes
the task, exactly the way `debug_vendor_payout_pipeline` saturated at 1.0.

The fix: a block is reported only if it has at least one uncovered face.
Verified against the live world by comparing filtered and unfiltered searches
and independently re-checking both sides:

```
coal_ore     303 -> 0     iron_ore     30 -> 0
grass_block  400 -> 400   stone       400 -> 99
survivors_all_exposed=true   excluded_all_buried=true
```

Surface perception is untouched; buried ore is gone. **This is a floor on the
deception, not a model of vision** — an exposed seam in a cave nobody has
visited is still reported. Tightening further means a real line of sight test
(`bot.canSeeBlock`), which would also make the agent unable to recall what it
walked past. Not obviously correct, so not done.

The same filter is applied to `mc_observe`'s block census, which had the
identical hole. Fixing one and not the other would have left the door open.

## The rule: thin primitives, never solutions

This is the part that is easy to get wrong and expensive to undo.

A tool may expose **one game action**. It may not plan, and it may not repair
the agent's mistakes.

| Allowed | Not allowed |
|---|---|
| `mc_craft(item)` — fails if no crafting table is in range, and says so | `mc_craft` that quietly places a table first |
| `mc_craft` reports which ingredients are missing | `mc_craft` that goes and gathers them |
| `mc_place(block, x, y, z)` | `mc_setup_base()` |
| `mc_place` equips the block the agent named | `mc_dig` equipping the best pickaxe it can find |
| — | `mc_get_diamond()`, or anything encoding the chain above |

The reason is not purity. A board measures whatever the entrant did *not* have
handed to it. If the recipe sequence lives in the plugin, the board stops
measuring whether an agent can play and starts measuring how good this plugin
is — and every entrant that installs it scores the same. That is the
saturation failure `debug_vendor_payout_pipeline` already died of: bare dsh
scored 1.0 on all four cases because the task gave away too much.

The agent must still work out that it needs a pickaxe, that wood cannot mine
iron, what order to do things in, which Y level to dig at, and how to survive.
Handing it the crafting *interface* is what a human player has. Handing it the
crafting *plan* is the answer.

The equip row is the narrowest line in the table and the easiest to cross.
Holding a block in order to place it is the placement mechanic — the agent
already named the block, so nothing is being chosen for it. Selecting *which*
pickaxe to dig with is a decision, and one the task exists to measure. When
`mc_equip` is added, `mc_dig` must keep not choosing.

The same line governs failure messages. `mc_craft` reporting `oak_planks x2
(have 0)` is interface: without it, an empty recipe list is indistinguishable
from "no such item" and from "needs a table", which demand opposite responses.
Reporting the sub-recipe — *"craft planks from logs first"* — would be the
answer.

## How to know a tool actually works

Calling a tool and checking it returned is not a test. Both bugs found so far
returned plausible values and looked like ordinary gameplay:

- `did not arrive (Cannot read properties of undefined ...)` read as a
  pathfinding failure; the bot had in fact never moved once, because
  `mineflayer-pathfinder` is CJS and `goals` exists only on `default`.
- `dug spruce_log, gained 0 item(s)` read as a tree that dropped nothing; the
  drop was on the ground and nobody walked onto it. This bug was **hidden by
  the first one** and only appeared once movement worked.

The method that found both: **give an agent a real goal and check for a real
result in the world.** For the next batch that means one run ending in
`wooden_pickaxe x1` in the inventory — not four green tool responses.

## Mineflayer API facts, read from source rather than guessed

Three of these would each have produced a plausible-but-wrong tool. All were
settled by reading `node_modules/mineflayer/lib/plugins/`, not by trying them.

| | |
|---|---|
| `bot.craft(recipe, count, table)` | `count` is **recipe runs, not items**: `craft.js` loops `craftOnce` that many times. `times:4` on planks yields 16. The parameter is named `times` for that reason, and the result reports the measured inventory delta instead of echoing the request. |
| `bot.recipesAll(id, meta, table)` | Filters only on `!recipe.requiresTable \|\| craftingTable`, so passing a **truthy placeholder** returns every recipe. That is the discriminator separating "no such recipe" / "needs a table" / "short of materials" — three states that look identical from an empty `recipesFor`. |
| `bot.placeBlock` | Waits 5s for a `blockUpdate` and **throws even when the server placed the block**. Propagating that exception tells the agent the table is missing while it stands next to it — the same plausible-but-wrong class as the `run_id` bug. `mc_place` catches it and re-reads `bot.blockAt(target)`. |

## The world has to be reset between runs, not just the inventory

Found while verifying, and it is a **board** requirement rather than a plugin
one.

Clearing `world/playerdata/<uuid>.dat` gives a fresh spawn with an empty
inventory — and leaves everything the previous run built. A verification run
started clean, needed a crafting table, and found two of them 12 metres away:

```
crafting_table at -4, 68, -6 (12.2m)    crafting_table at -6, 67, -6 (13.7m)
```

Both placed by the previous run's agent. On a live board that means entrant N
inherits entrant N-1's crafting tables, felled trees and mine shafts — and the
later an entrant runs, the easier the task gets. Scores would not be
comparable and the drift would be invisible in the results.

A scoring run needs a **fresh world directory** (the seed is fixed, so it
regenerates identically), not a cleared player file.

## Environment facts that cost time to rediscover

| | |
|---|---|
| Java is not on `PATH` | Use `/opt/homebrew/opt/openjdk@21/bin/java`. Both 21 and 24 are installed; Paper 1.20.4 wants 17–21, so 24 is not a safe default. |
| Server | `Projects/mindcraft-forMC/server/paper.jar`, seed `diamondrun`, offline mode, port 25565. Starts in ~12s. |
| **`difficulty=peaceful`** | **The task specifies `easy`.** Peaceful spawns no hostile mobs, so any score from this server is not comparable to the board. Fine for testing tools; must be changed before a real run. |
| Session logs | `$DSH_HOME/sessions/**/session.jsonl.zstd` — zstd-compressed JSONL, and the only way to see what the agent actually called and what came back. |

## Naming and placement, decided deliberately

Published as unscoped `dsh-minecraft` under `Ruqii/`, **not** under the
`trapstreet` org, because this is a contestant on a public board rather than
platform infrastructure — and a platform should not own an entrant it also
grades. `dsh-trapstreet` sits under the org for the opposite reason: it is a
client of the platform, not a competitor on it.

npm name `dsh-minecraft` is unclaimed and not yet published.

## A tool that never returns is worse than one that fails

`pathfinder.goto` takes no timeout. `thinkTimeout` bounds the A* search, not
the walking, so a bot that cannot quite reach its goal keeps trying forever.

Measured: an agent walked toward a crafting table three blocks above it, stopped
moving entirely, and stood on the same coordinate for **ten minutes** until the
run was killed. No error, no log line, nothing for the agent to react to — the
tool call simply never came back and the run budget drained.

`walkTo` now races the walk against a 60s ceiling and calls `pathfinder.stop()`
on expiry, reporting where the bot actually ended up. Drop collection inside
`mc_dig` uses the same helper at 15s: fetching an item four metres away should
never be what consumes a run.

Verified both directions, because a broken race would never fire and would look
exactly like the bug:

```
unreachable target -> reached:false, timed_out:true, after 60s
short walk         -> reached:true  after 1s
```

Two further defects came out of writing that ceiling, and neither would have
been visible without probing it:

**Cut short is not the same as cannot get there.** The first version returned
`reached:false` for both, which are opposite situations — one means walk again,
the other means pick another target. `walkTo` now returns `timed_out` and
measures whether the distance actually closed.

**`pathfinder.stop()` poisons the next walk.** It sets an internal
`stopPathing` flag cleared only when the bot reaches the next node of a path —
and a bot that was just stopped has no path, so the flag stays set. The
following `setGoal` runs `resetPath`, sees the flag, and nulls the goal that
was just assigned. Measured: after one timed-out walk, a four-block walk in the
same session covered **0.2m in sixty seconds**. So a single timeout would have
disabled movement for the rest of the run — worse than the hang it replaced.
`clearPathing` burns the flag against a null goal first; verified by walking
successfully twice in a row immediately after a timeout.

## Known next defect: `mc_dig` mis-diagnoses a missing tool

Stone mined bare-handed drops nothing. `mc_dig` then walks onto the block,
still gains nothing, and reports *"the drop may be out of reach"* — the wrong
cause, and it is the first thing an agent hits on the stone-pickaxe step.

The fix is to check `target.harvestTools` against the held item and say so.

It was originally deferred on the grounds that `mc_dig` was a passing control
and should not be changed while new variables were being added. **That reason
has expired** — `mc_dig`'s tail has since been rewritten twice, for drop
collection and for the walk ceiling. There is no control left to protect, so
this is simply the next thing to fix.
