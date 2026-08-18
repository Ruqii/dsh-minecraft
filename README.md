# dsh-minecraft

Play Minecraft from DeepSeek Harness. The agent joins a real server through a
live [Mineflayer](https://github.com/PrismarineJS/mineflayer) bot and looks,
walks, and mines through tools.

```
dsh plugin --profile <name> add dsh-minecraft
```

## Six tools

| Tool | What it does |
|---|---|
| `mc_connect` | Join a server. Defaults to `127.0.0.1:25565`. |
| `mc_observe` | Position, health, food, inventory, nearby blocks and entities — **plus what happened since the last look**. |
| `mc_find` | Nearest blocks of a kind, with coordinates. |
| `mc_goto` | Walk somewhere, pathfinding around obstacles. |
| `mc_dig` | Break a block and collect the drop. |
| `mc_disconnect` | Leave. |

There is deliberately no `attack`, `craft` or `place` yet. An agent under a
thirty-minute clock pays for every extra tool with one more chance to pick the
wrong one; these six are the ones a wood-to-diamond run cannot do without.

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

## Requirements

A Minecraft **Java 1.20.4** server the bot can reach, in offline mode.

Java is not bundled and is often not on `PATH` even when installed —
`brew install openjdk@21` leaves it at
`/opt/homebrew/opt/openjdk@21/bin/java` unless linked. Paper 1.20.4 wants
Java 17–21; a newer JDK on the same machine is not a safe default.

## Two bugs worth knowing about, because both looked like gameplay

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
it is only picked up by standing on it. The agent saw `dug spruce_log, gained
0 item(s)` and could not tell a broken tool from a log lying half a metre
away. `mc_dig` now walks onto the drop, and says so plainly when it still
cannot reach it.

Neither surfaced from calling the tools and checking they returned. Both took
giving an agent a real goal — *collect one log* — and watching it fail to
achieve it while every call looked fine.

## License

MIT
