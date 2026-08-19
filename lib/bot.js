// The live bot, and everything that needs to know Mineflayer exists.
//
// A Mineflayer bot is a TCP connection, a packet stream and an event emitter
// that must keep receiving while nothing is calling us. That it survives
// between tool calls is not an assumption: a probe measured 277 physics ticks
// arriving during a pause when no tool was running.

import { writeFileSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
import * as recorder from './record.js'

let bot = null
let connectedAt = null
// Events that happen while the agent is not looking. Without this the agent
// asks "what happened?" and the honest answer is lost -- it only ever sees a
// snapshot taken at the moment it asked.
const journal = []
// The judge credits a rung if its item appears in the reported inventory, but
// a wooden pickaxe can be worn out or a raw_iron smelted away long before the
// run ends. So record what was actually held at any point: that is a fact
// about the run, not a claim about it.
const everHeld = new Set()
let startTicks = null

const note = (text) => {
  journal.push({ t: Date.now(), text })
  if (journal.length > 200) journal.shift()
}

export function state() {
  return { connected: bot !== null, connectedAt }
}

export async function connect({ host = '127.0.0.1', port = 25565, username = 'dsh_agent', version = '1.20.4' } = {}) {
  if (bot) return { error: 'already connected' }
  const mineflayer = (await import('mineflayer')).default
  const { pathfinder } = await import('mineflayer-pathfinder')
  const b = mineflayer.createBot({ host, port, username, version, auth: 'offline' })
  b.loadPlugin(pathfinder)

  b.on('death', () => note('died and respawned'))
  b.on('health', () => note(`health ${b.health}, food ${b.food}`))
  b.on('kicked', r => note(`kicked: ${String(r).slice(0, 120)}`))
  b.on('error', e => note(`error: ${e.message}`))

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('spawn timed out after 40s')), 40000)
      b.once('spawn', () => { clearTimeout(timer); resolve() })
      b.once('kicked', r => { clearTimeout(timer); reject(new Error(`kicked: ${r}`)) })
      b.once('error', e => { clearTimeout(timer); reject(e) })
    })
  } catch (e) {
    try { b.quit() } catch {}
    return { error: e.message }
  }
  bot = b
  connectedAt = Date.now()
  note('spawned')

  // The board scores a run with no video at 0.0 however far it got, so this is
  // switched on by the harness rather than by the agent -- being filmed is not
  // one of the agent's decisions. Failing to film never blocks the run: the
  // reason is noted and play continues.
  startTicks = typeof b.time?.age === 'number' ? b.time.age : null
  const dir = recorder.wanted()
  if (dir !== null) {
    const started = await recorder.start(b, dir)
    note(started.started ? `recording to ${dir}` : `not recording: ${started.reason}`)
  }
  return observe()
}

export async function disconnect() {
  if (!bot) return { error: 'not connected' }
  // Mux before dropping the connection: the frames are already on disk, but
  // this is the only moment we know the run is over.
  for (const i of bot.inventory.items()) everHeld.add(i.name)
  const recording = recorder.status().recording ? await recorder.stop() : null
  const outcome = recorder.wanted() === null ? null : writeOutcome(bot, recording)
  try { bot.quit() } catch {}
  bot = null
  connectedAt = null
  journal.length = 0
  everHeld.clear()
  startTicks = null
  return { disconnected: true, ...(recording === null ? {} : { recording }), ...(outcome === null ? {} : { outcome }) }
}

// The judge reads a single JSON object from the LAST line of the run's stdout,
// which a DSH plugin does not control -- the agent's stdout belongs to the
// harness. So this writes the file and the submission's run.sh prints it.
//
// `video` is written as the local mp4 path. It has to be replaced with a public
// URL before submitting: the judge only checks the field is non-empty, so a
// local path would pass while being no use to anyone reviewing the run.
function writeOutcome(b, recording) {
  const inventory = b.inventory.items().map(i => `${i.name} x${i.count}`)
  const diamonds = b.inventory.items().filter(i => i.name === 'diamond').reduce((n, i) => n + i.count, 0)
  const ticks = typeof b.time?.age === 'number' && startTicks !== null ? b.time.age - startTicks : null
  const outcome = {
    obtained: diamonds > 0,
    item: 'diamond',
    count: diamonds,
    ticks,
    wall_time_s: connectedAt === null ? null : Math.round((Date.now() - connectedAt) / 1000),
    inventory,
    // Held at some point during the run, whether or not it survived to the end.
    milestones: [...everHeld].sort(),
    video: recording?.video ?? '',
    seed: process.env.MC_SEED ?? '',
    mc_version: b.version ?? '',
  }
  try {
    const dir = recorder.wanted()
    writeFileSync(pathJoin(dir, 'outcome.json'), JSON.stringify(outcome, null, 2))
  } catch (e) {
    return { ...outcome, write_error: e.message }
  }
  return outcome
}

function requireBot() {
  if (!bot) throw new Error('not connected -- call mc_connect first')
  return bot
}

const round = (v) => Math.round(v * 10) / 10

const FACES = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]

// Mineflayer reads the client's copy of the world, so every block query is
// x-ray by default: findBlocks walks raw chunk-section data with no line of
// sight test, and blockAt answers just as happily through thirty metres of
// stone.
//
// Handing that to an agent does not make it a better player, it makes the
// board stop measuring one. The whole difficulty of finding ore is not knowing
// where it is; a query that answers through rock deletes the task rather than
// solving it -- the same way `debug_vendor_payout_pipeline` saturated at 1.0
// because it gave too much away.
//
// So a block counts as seen only if it has an uncovered face, which is roughly
// what a player walking past an opening can see. This is still more generous
// than a human eye: an exposed seam in an unvisited cave is reported without
// anyone having gone there. It is a floor on the deception, not a simulation
// of vision.
function occludes(block) {
  if (block === null || block === undefined) return true       // unloaded: do not claim visibility
  return block.boundingBox === 'block' && block.transparent !== true
}

function isExposed(b, pos) {
  for (const [dx, dy, dz] of FACES) {
    if (!occludes(b.blockAt(pos.offset(dx, dy, dz)))) return true
  }
  return false
}

export function observe({ radius = 5 } = {}) {
  const b = requireBot()
  const p = b.entity.position
  const blocks = {}
  for (let dx = -radius; dx <= radius; dx++)
    for (let dy = -radius; dy <= radius; dy++)
      for (let dz = -radius; dz <= radius; dz++) {
        const block = b.blockAt(p.offset(dx, dy, dz))
        // Buried blocks are not reported: see isExposed above.
        if (block && block.name !== 'air' && isExposed(b, block.position)) {
          blocks[block.name] = (blocks[block.name] || 0) + 1
        }
      }
  const mobs = Object.values(b.entities)
    .filter(e => e !== b.entity && e.position.distanceTo(p) < 24 && (e.type === 'mob' || e.type === 'player'))
    .map(e => ({ name: e.name ?? e.username ?? e.type, distance: round(e.position.distanceTo(p)) }))
    .sort((a, c) => a.distance - c.distance)
    .slice(0, 8)

  for (const i of b.inventory.items()) everHeld.add(i.name)
  const since = journal.splice(0, journal.length).map(j => j.text)
  return {
    position: { x: round(p.x), y: round(p.y), z: round(p.z) },
    standing_on: b.blockAt(p.offset(0, -1, 0))?.name ?? 'unknown',
    health: b.health, food: b.food,
    dimension: b.game?.dimension, time_of_day: b.time?.timeOfDay,
    inventory: inventoryOf(b),
    blocks_nearby: Object.entries(blocks).sort((a, c) => c[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })),
    entities_nearby: mobs,
    // Drained on read: these are things that happened since the agent last
    // looked, not a running total.
    since_last_look: since,
  }
}

// Finds the nearest block of a kind and reports where it is. Digging blind is
// how an agent wastes a thirty-minute run.
export function find({ name, radius = 32 }) {
  const b = requireBot()
  const ids = b.registry.blocksArray.filter(x => x.name === name || x.name.includes(name)).map(x => x.id)
  if (ids.length === 0) return { error: `no block type matches "${name}"` }
  // useExtraInfo as a *function* filters each candidate while keeping the
  // palette fast path, so `count` counts exposed hits rather than needing a
  // wider search trimmed afterwards.
  const found = b.findBlocks({
    matching: ids,
    maxDistance: radius,
    count: 8,
    useExtraInfo: (block) => block !== null && isExposed(b, block.position),
  })
  if (found.length === 0) {
    // Saying "there is none" would be a lie: buried blocks are deliberately
    // invisible here, and an agent told the wrong thing will stop digging.
    return { found: [], note: `no exposed ${name} within ${radius} blocks -- any that is still buried will not show up until something uncovers it` }
  }
  const p = b.entity.position
  return {
    found: found.map(v => ({
      position: { x: v.x, y: v.y, z: v.z },
      distance: round(p.distanceTo(v)),
      name: b.blockAt(v)?.name,
    })),
  }
}

// pathfinder.goto takes no timeout: thinkTimeout bounds the A* search, not the
// walking. A bot that cannot quite reach its goal will keep trying forever,
// and a tool call that never returns is worse than one that fails -- it eats
// the whole run silently while the agent waits, unable to react.
//
// Measured: an agent walking to a crafting table three blocks above it stopped
// moving entirely and burned the rest of its budget standing still.
// pathfinder.stop() alone leaves the plugin poisoned. It sets an internal
// stopPathing flag that is only cleared once the bot reaches the next node of
// a path -- and a bot that has just been stopped has no path, so the flag
// stays set. The next setGoal then runs resetPath, which sees the flag and
// nulls the goal that was just assigned: the following walk is silently
// swallowed and the bot never moves.
//
// Measured: after one timed-out walk, a four-block walk in the same session
// covered 0.2m in sixty seconds. Setting the goal to null first burns the
// flag against a goal nobody wanted.
function clearPathing(b) {
  try { b.pathfinder.stop() } catch {}
  try { b.pathfinder.setGoal(null) } catch {}
}

const WALK_TIMEOUT_MS = 60000

// What the walk consumed. Blocks placed as scaffolding are gone from the
// inventory with nothing in the result to explain it.
function spentWalking(b, before) {
  const after = countsOf(b)
  const out = []
  for (const [name, n] of before) {
    const left = after.get(name) ?? 0
    if (left < n) out.push({ name, count: n - left })
  }
  return out
}

async function walkTo(b, x, y, z, range, ms = WALK_TIMEOUT_MS) {
  const { Vec3: Vec3ish } = await import('vec3')
  const pf = await import('mineflayer-pathfinder')
  // CJS/ESM interop varies: the module may expose named exports directly or
  // only under `default`. Resolve both so `goals` and `Movements` are found.
  const goals = pf.goals ?? pf.default?.goals
  const Movements = pf.Movements ?? pf.default?.Movements
  if (!goals?.GoalNear || !Movements) return { reached: false, reason: 'pathfinder exports unavailable' }

  b.pathfinder.setMovements(new Movements(b))
  // Pathfinder bridges gaps by placing blocks, which equips whatever it uses.
  // Measured: equip a wooden pickaxe, walk, dig -- and the bot is holding dirt,
  // so the stone drops nothing. Walking is not a statement about what to hold,
  // so it must not silently undo one.
  const heldBefore = b.heldItem
  // Pathfinder also *spends* blocks bridging gaps, and the agent has no way to
  // see it: an agent in a real run noticed its cobblestone drop from 5 to 3 and
  // its dirt vanish, and could only guess why. Walking that quietly eats
  // materials is something to report, not something to hide.
  const carriedBefore = countsOf(b)
  const distanceLeft = () => round(b.entity.position.distanceTo(new Vec3ish(x, y, z)))
  const startedAt = distanceLeft()

  const walk = b.pathfinder.goto(new goals.GoalNear(x, y, z, range))
  // stop() below makes this promise reject; swallow it so it cannot surface as
  // an unhandled rejection after the result has already been reported.
  walk.catch(() => {})

  const TIMED_OUT = Symbol('timed out')
  let timer
  try {
    const outcome = await Promise.race([
      walk.then(() => 'arrived'),
      new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms) }),
    ])
    if (outcome !== TIMED_OUT) return { reached: true, spent: spentWalking(b, carriedBefore) }
    // Cut short by the ceiling, which is a different thing from being unable
    // to get there -- one means call again, the other means pick another
    // target. Collapsing them into one "did not arrive" is the same defect
    // that made an agent spend ten minutes theorising about the server.
    clearPathing(b)
    const remaining = distanceLeft()
    return {
      reached: false,
      timed_out: true,
      spent: spentWalking(b, carriedBefore),
      reason: `stopped after ${Math.round(ms / 1000)}s without arriving -- cut short by a time limit, not blocked. ` +
        (remaining < startedAt
          ? `Closed from ${startedAt}m to ${remaining}m, so the route works; walking again continues from here.`
          : `Still ${remaining}m away and no closer than at the start, so this route may not go through.`),
    }
  } catch (e) {
    // pathfinder itself gave up: unreachable, no route, or the world changed
    // mid-walk. Walking again will fail the same way.
    clearPathing(b)
    return { reached: false, timed_out: false, spent: spentWalking(b, carriedBefore), reason: `could not path there: ${e.message}` }
  } finally {
    clearTimeout(timer)
    if (heldBefore && b.heldItem?.type !== heldBefore.type) {
      // Only if it is still there: scaffolding may have consumed it.
      const again = b.inventory.items().find(i => i.type === heldBefore.type)
      if (again) { try { await b.equip(again, 'hand') } catch {} }
    }
  }
}

export async function goto({ x, y, z, range = 1 }) {
  const b = requireBot()
  const result = await walkTo(b, x, y, z, range)
  return { ...result, ...positionOf(b) }
}

function positionOf(b) {
  const p = b.entity.position
  return { position: { x: round(p.x), y: round(p.y), z: round(p.z) } }
}

export async function dig({ x, y, z }) {
  const b = requireBot()
  const { Vec3 } = await import('vec3')
  const target = b.blockAt(new Vec3(x, y, z))
  if (!target || target.name === 'air') return { error: `nothing to dig at ${x}, ${y}, ${z}` }
  // canDigBlock is purely reach and diggability -- read from digging.js, which
  // checks distance <= 5.1 from the eyes and nothing about tools. Mentioning
  // tools here would send the agent to fix the wrong thing.
  if (!b.canDigBlock(target)) {
    return { error: `${target.name} is out of reach from here -- the block has to be within about 5 blocks, so walk closer first` }
  }
  // Recorded before the block is gone. A block with harvestTools drops nothing
  // unless one of them is in hand -- and breaking it bare-handed still destroys
  // it, exactly as in the game. So this does not refuse: refusing would change
  // the rules and cover for a decision that is the agent's to make. It only
  // makes sure the reason is not guessed at afterwards.
  const held = b.heldItem
  const needsTool = target.harvestTools !== undefined && target.harvestTools !== null
  const toolWorks = !needsTool || (held !== null && held !== undefined && target.harvestTools[held.type] === true)
  const acceptedTools = needsTool
    ? Object.keys(target.harvestTools).map(id => b.registry.items[id]?.name).filter(Boolean)
    : []

  // What this block is supposed to drop, so the check is about THIS dig rather
  // than about the inventory getting bigger. Counting the total was wrong in a
  // way that only shows up with clutter on the floor: pathfinder digs dirt to
  // reach a spot, the bot steps on a stray dirt item, the total goes up by one,
  // and a cobblestone left lying on the ground is recorded as collected.
  const expected = (target.drops ?? [])
    .map(d => b.registry.items[typeof d === 'object' ? d.drop : d]?.name)
    .filter(Boolean)
  const before = countsOf(b)
  try {
    await b.dig(target)
  } catch (e) {
    return { error: `dig failed: ${e.message}` }
  }
  // The drop is a physics entity: it falls, and it is only picked up by being
  // walked over. Walking to the *block* coordinate is wrong and was measured
  // being wrong -- an agent mining a tree trunk from halfway up sent the bot
  // to a point in mid-air while the logs lay on the ground below, and spent
  // the rest of its run concluding the server was withholding drops.
  //
  // So walk to the item entity itself. This is not help: "collect what it
  // drops" is what the tool already claims to do, and what a player gets for
  // free by stepping on it.
  await new Promise(r => setTimeout(r, 500))
  // Only the expected drop counts as having collected this block. A block with
  // no listed drop has nothing specific to wait for, so any gain is taken at
  // face value and the result says which kind of number it is.
  const gainedOf = (names) => {
    const after = countsOf(b)
    let n = 0
    for (const [name, c] of after) {
      if (names !== null && !names.includes(name)) continue
      n += c - (before.get(name) ?? 0)
    }
    return n
  }
  const track = expected.length > 0 ? expected : null
  let collected = gainedOf(track)
  let leftBehind = null
  if (collected === 0) {
    const drop = Object.values(b.entities)
      // Measured on a live drop: name="item", displayName="Item", type="other".
      // entity.objectType would also match but is deprecated and prints a
      // stack trace on every read.
      .filter(e => (e.name === 'item' || e.displayName === 'Item') &&
                   e.position.distanceTo(target.position) < 12)
      .sort((p1, p2) => p1.position.distanceTo(b.entity.position) - p2.position.distanceTo(b.entity.position))[0]
    if (drop) {
      const d = drop.position
      // Bounded well below a full walk: fetching a drop a few metres away
      // should never be what consumes the run.
      await walkTo(b, d.x, d.y, d.z, 0, 15000)
      await new Promise(r => setTimeout(r, 900))
      collected = gainedOf(track)
      if (collected === 0) {
        const d = drop.position
        leftBehind = { x: Math.round(d.x), y: Math.round(d.y), z: Math.round(d.z) }
      }
    }
  }
  return {
    dug: target.name,
    // Named rather than counted: "gained 1" was true and meaningless when the
    // 1 was an unrelated item picked up off the floor.
    collected: expected.length > 0 ? collected + ' x ' + expected.join('/') : collected + ' item(s)',
    items_gained: collected,
    // Three different causes used to share one vague sentence. They need
    // different responses, so they get different sentences.
    // Three causes that used to share one vague sentence, and that need
    // different responses.
    ...(collected > 0 ? {} : !toolWorks
      ? { note: `${target.name} dropped nothing because you were holding ${held?.name ?? 'nothing'}. It only drops for: ${acceptedTools.join(', ')}. The block is gone either way.` }
      : leftBehind
      ? { note: `the drop is lying at ${leftBehind.x}, ${leftBehind.y}, ${leftBehind.z} and could not be walked to -- it may be through a wall or over a drop` }
      : { note: `${target.name} broke but dropped nothing that could be found` }),
    inventory: inventoryOf(b),
  }
}

// DSH rejects a tool result containing `undefined`, and JSON.stringify drops
// those silently -- so a round-trip self-check does not catch it. Registry
// misses and absent blocks are exactly where they come from.
export function jsonSafe(value) {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' && !Number.isFinite(value) ? null : value
  }
  if (Array.isArray(value)) return value.map(jsonSafe)
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]))
}

// Every result that reports an inventory also records it. Doing this only in
// observe() lost anything crafted and consumed between two looks -- a raw_iron
// smelted straight after mining it would never appear in `milestones`, and the
// judge credits a rung on that list.
const inventoryOf = (b) => b.inventory.items().map(i => {
  everHeld.add(i.name)
  return { name: i.name, count: i.count }
})

function countsOf(b) {
  const m = new Map()
  for (const i of b.inventory.items()) m.set(i.name, (m.get(i.name) ?? 0) + i.count)
  return m
}

function gainedBetween(before, after) {
  const out = []
  for (const [name, n] of after) {
    const delta = n - (before.get(name) ?? 0)
    if (delta > 0) out.push({ name, count: delta })
  }
  return out
}

// What the closest recipe is short of. Reporting the missing *ingredients* is
// interface -- an empty recipe list is otherwise indistinguishable from "no
// such item". Reporting how to obtain them would be the answer.
function shortfall(b, recipes) {
  let best = null
  for (const recipe of recipes) {
    const need = []
    for (const d of recipe.delta) {
      if (d.count >= 0) continue                       // positive entries are the output
      const have = b.inventory.count(d.id, d.metadata)
      const short = -d.count - have
      if (short > 0) need.push({ item: b.registry.items[d.id]?.name ?? `item_${d.id}`, need: -d.count, have })
    }
    const total = need.reduce((n, x) => n + (x.need - x.have), 0)
    if (best === null || total < best.total) best = { total, need }
  }
  return best?.need ?? []
}

// One recipe, once (or `times` times). It will not place a crafting table, and
// it will not gather what is missing -- see docs/next-steps.md for why that
// line is where it is.
export async function craft({ item, times = 1 }) {
  const b = requireBot()
  const spec = b.registry.itemsByName?.[item]
  if (!spec) return { error: `no item is called "${item}"` }
  const tableId = b.registry.blocksByName?.crafting_table?.id
  // Only a table the bot could actually click counts as being "in range".
  const table = tableId === undefined ? null : b.findBlock({ matching: tableId, maxDistance: 3.5 })

  const usable = b.recipesFor(spec.id, null, 1, table)
  if (usable.length === 0) {
    // Three failures that demand opposite responses from the agent, and which
    // an empty recipe list cannot tell apart. recipesAll only filters on
    // `!requiresTable || craftingTable`, so a truthy placeholder yields every
    // recipe and separates them.
    const anyRecipe = b.recipesAll(spec.id, null, true)
    if (anyRecipe.length === 0) {
      return { error: `${item} has no crafting recipe -- it has to be found, mined or smelted instead` }
    }
    if (b.recipesAll(spec.id, null, null).length === 0 && !table) {
      return { error: `${item} needs a crafting table within about 3 blocks, and there is none in range` }
    }
    return { error: `not enough materials to craft ${item}`, missing: shortfall(b, anyRecipe) }
  }

  const recipe = usable[0]
  const before = countsOf(b)
  try {
    await b.craft(recipe, times, recipe.requiresTable ? table : null)
  } catch (e) {
    return { error: `craft failed: ${e.message}`, inventory: inventoryOf(b) }
  }

  // bot.craft can resolve having done nothing: the window transaction is
  // occasionally dropped, and it reports no error when that happens. Measured
  // once on a 3x3 table recipe -- the call returned, the materials were still
  // there, and the identical call a moment later worked.
  //
  // So wait for the inventory to actually change rather than for the promise,
  // and report what the world says. Announcing "crafted" over an unchanged
  // inventory is the plausible-but-wrong state this plugin exists to avoid.
  let gained = []
  for (let waited = 0; waited < 2500 && gained.length === 0; waited += 250) {
    await new Promise(r => setTimeout(r, 250))
    gained = gainedBetween(before, countsOf(b))
  }
  if (gained.length === 0) {
    // Deliberately not retried here: a retry would hide a real failure, and
    // would craft twice if the update were merely slow.
    return {
      error: `the ${item} recipe ran but nothing changed -- no materials were used and no ${item} appeared. The craft did not take effect; check the inventory and try again.`,
      inventory: inventoryOf(b),
    }
  }
  return {
    crafted: item,
    // `times` is recipe runs, not items: bot.craft loops craftOnce that many
    // times, and one run of a recipe can yield several items. So report what
    // the inventory actually gained rather than echoing the request.
    times,
    gained,
    used_table: recipe.requiresTable,
    inventory: inventoryOf(b),
  }
}

// Holds a named item. It does not pick one: choosing the right tool for a job
// is the decision the board exists to measure, so there is deliberately no
// "equip the best pickaxe" here, and mc_dig does not equip anything either.
export async function equip({ item, destination = 'hand' }) {
  const b = requireBot()
  const found = b.inventory.items().find(i => i.name === item)
  if (!found) {
    return { error: `there is no ${item} in the inventory`, inventory: inventoryOf(b) }
  }
  try {
    await b.equip(found, destination)
  } catch (e) {
    return { error: `could not equip ${item} to ${destination}: ${e.message}` }
  }
  // Believe the world: bot.equip resolving is not proof the slot changed.
  const holding = b.heldItem?.name ?? null
  if (destination === 'hand' && holding !== item) {
    return { error: `${item} was not equipped -- still holding ${holding ?? 'nothing'}` }
  }
  return { equipped: item, destination, holding, inventory: inventoryOf(b) }
}

// One trip to a furnace. It will not build one, and it will not decide what to
// burn: naming the fuel is the agent's call, exactly as naming the tool is in
// mc_equip. Coal, planks and logs all work and last very different amounts of
// time, which is part of what the board measures.
export async function smelt({ input, fuel, count = 1, fuel_count = 1 }) {
  const b = requireBot()
  const inSpec = b.registry.itemsByName?.[input]
  if (!inSpec) return { error: `no item is called "${input}"` }
  const fuelSpec = b.registry.itemsByName?.[fuel]
  if (!fuelSpec) return { error: `no item is called "${fuel}"` }

  const held = countsOf(b)
  if ((held.get(input) ?? 0) < count) {
    return { error: `only ${held.get(input) ?? 0} ${input} in the inventory, and ${count} was asked for` }
  }
  if ((held.get(fuel) ?? 0) < fuel_count) {
    return { error: `only ${held.get(fuel) ?? 0} ${fuel} in the inventory, and ${fuel_count} was asked for as fuel` }
  }

  const furnaceId = b.registry.blocksByName?.furnace?.id
  const block = furnaceId === undefined ? null : b.findBlock({ matching: furnaceId, maxDistance: 3.5 })
  if (!block) return { error: 'no furnace within about 3 blocks, and this will not put one down for you' }

  let furnace
  try {
    furnace = await b.openFurnace(block)
  } catch (e) {
    return { error: `could not open the furnace: ${e.message}` }
  }

  try {
    await furnace.putFuel(fuelSpec.id, null, fuel_count)
    await furnace.putInput(inSpec.id, null, count)
  } catch (e) {
    try { furnace.close() } catch {}
    return { error: `could not load the furnace: ${e.message}` }
  }

  // Smelting takes about ten seconds an item and the bot has to stand there.
  // Bounded, like every other wait here: a tool that never returns eats the
  // run silently.
  const deadline = Date.now() + 15000 + count * 15000
  let ready = 0
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000))
    ready = furnace.outputItem()?.count ?? 0
    if (ready >= count) break
    // Out of fuel with nothing left burning: waiting longer changes nothing.
    if (furnace.fuelItem() === null && (furnace.fuel ?? 0) <= 0 && ready > 0) break
  }

  let taken = null
  if (ready > 0) {
    try { taken = await furnace.takeOutput() } catch (e) { taken = null }
  }
  // Reclaim whatever did not get used, rather than leaving it in a block the
  // agent may never come back to.
  for (const reclaim of [() => furnace.takeInput(), () => furnace.takeFuel()]) {
    try { await reclaim() } catch { /* that slot was empty */ }
  }
  try { furnace.close() } catch {}

  const gained = gainedBetween(held, countsOf(b))
  if (taken === null || gained.length === 0) {
    return {
      error: `nothing came out of the furnace within the wait. ${ready === 0 ? 'It never started -- ' + fuel + ' may not burn, or may not have been enough.' : 'It was still going when the wait ran out.'}`,
      inventory: inventoryOf(b),
    }
  }
  return {
    smelted: input,
    asked_for: count,
    gained,
    ...(ready < count ? { note: `only ${ready} of ${count} finished before the fuel or the wait ran out` } : {}),
    inventory: inventoryOf(b),
  }
}

export async function place({ item, x, y, z }) {
  const b = requireBot()
  const { Vec3 } = await import('vec3')
  const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  const held = b.inventory.items().find(i => i.name === item)
  if (!held) return { error: `there is no ${item} in the inventory to place` }

  const at = b.blockAt(target)
  if (!at) return { error: `${target.x}, ${target.y}, ${target.z} is outside the loaded world` }
  if (at.boundingBox !== 'empty') return { error: `${at.name} is already there -- dig it out first` }

  const feet = b.entity.position.floored()
  if (target.equals(feet) || target.equals(feet.offset(0, 1, 0))) {
    return { error: 'that is the space the bot is standing in -- move somewhere else first' }
  }
  const reach = round(b.entity.position.distanceTo(target))
  if (reach > 4.5) return { error: `${reach}m away, too far to place -- walk within about 4 blocks first` }

  // A block is always placed against the face of an existing one, so an empty
  // spot floating in air cannot be built on.
  const ref = [[0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]]
    .map(([dx, dy, dz]) => ({ block: b.blockAt(target.offset(dx, dy, dz)), face: new Vec3(-dx, -dy, -dz) }))
    .find(({ block }) => block && block.boundingBox === 'block')
  if (!ref) return { error: `nothing solid borders ${target.x}, ${target.y}, ${target.z} -- a block has to rest against another one` }

  // placeBlock needs the item in hand. Holding a block the agent named is part
  // of placing it, not a decision made on the agent's behalf.
  // Same trap as walking: equipping to place is necessary, leaving it equipped
  // afterwards is not. An agent that places dirt and then digs stone would be
  // swinging a dirt block, which is the bug already found once in walkTo.
  const heldBefore = b.heldItem
  try {
    await b.equip(held, 'hand')
  } catch (e) {
    return { error: `could not hold ${item}: ${e.message}` }
  }
  let thrown = null
  try {
    await b.placeBlock(ref.block, ref.face)
  } catch (e) {
    // placeBlock waits 5s for a blockUpdate and throws when none arrives --
    // which happens routinely on placements the server accepted. Believe the
    // world below, not this exception.
    thrown = e.message
  }
  await new Promise(r => setTimeout(r, 250))
  if (heldBefore && b.heldItem?.type !== heldBefore.type) {
    // Only if it survived: the placed stack may have been the last one.
    const again = b.inventory.items().find(i => i.type === heldBefore.type)
    if (again) { try { await b.equip(again, 'hand') } catch {} }
  }
  const now = b.blockAt(target)
  const placed = now?.name === item
  return {
    placed,
    block_at_target: now?.name ?? 'unknown',
    position: { x: target.x, y: target.y, z: target.z },
    ...(placed || thrown === null ? {} : { reason: thrown }),
    inventory: inventoryOf(b),
  }
}
