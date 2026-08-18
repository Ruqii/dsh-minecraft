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

## The rule: thin primitives, never solutions

This is the part that is easy to get wrong and expensive to undo.

A tool may expose **one game action**. It may not plan, and it may not repair
the agent's mistakes.

| Allowed | Not allowed |
|---|---|
| `mc_craft(item)` — fails if no crafting table is in range, and says so | `mc_craft` that quietly places a table first |
| `mc_craft` reports which ingredients are missing | `mc_craft` that goes and gathers them |
| `mc_place(block, x, y, z)` | `mc_setup_base()` |
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
