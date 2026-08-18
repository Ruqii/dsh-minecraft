// The live bot, and everything that needs to know Mineflayer exists.
//
// A Mineflayer bot is a TCP connection, a packet stream and an event emitter
// that must keep receiving while nothing is calling us. That it survives
// between tool calls is not an assumption: a probe measured 277 physics ticks
// arriving during a pause when no tool was running.

let bot = null
let connectedAt = null
// Events that happen while the agent is not looking. Without this the agent
// asks "what happened?" and the honest answer is lost -- it only ever sees a
// snapshot taken at the moment it asked.
const journal = []

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
  return observe()
}

export function disconnect() {
  if (!bot) return { error: 'not connected' }
  try { bot.quit() } catch {}
  bot = null
  connectedAt = null
  journal.length = 0
  return { disconnected: true }
}

function requireBot() {
  if (!bot) throw new Error('not connected -- call mc_connect first')
  return bot
}

const round = (v) => Math.round(v * 10) / 10

export function observe({ radius = 5 } = {}) {
  const b = requireBot()
  const p = b.entity.position
  const blocks = {}
  for (let dx = -radius; dx <= radius; dx++)
    for (let dy = -radius; dy <= radius; dy++)
      for (let dz = -radius; dz <= radius; dz++) {
        const block = b.blockAt(p.offset(dx, dy, dz))
        if (block && block.name !== 'air') blocks[block.name] = (blocks[block.name] || 0) + 1
      }
  const mobs = Object.values(b.entities)
    .filter(e => e !== b.entity && e.position.distanceTo(p) < 24 && (e.type === 'mob' || e.type === 'player'))
    .map(e => ({ name: e.name ?? e.username ?? e.type, distance: round(e.position.distanceTo(p)) }))
    .sort((a, c) => a.distance - c.distance)
    .slice(0, 8)

  const since = journal.splice(0, journal.length).map(j => j.text)
  return {
    position: { x: round(p.x), y: round(p.y), z: round(p.z) },
    standing_on: b.blockAt(p.offset(0, -1, 0))?.name ?? 'unknown',
    health: b.health, food: b.food,
    dimension: b.game?.dimension, time_of_day: b.time?.timeOfDay,
    inventory: b.inventory.items().map(i => ({ name: i.name, count: i.count })),
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
  const found = b.findBlocks({ matching: ids, maxDistance: radius, count: 8 })
  if (found.length === 0) return { found: [], note: `no ${name} within ${radius} blocks` }
  const p = b.entity.position
  return {
    found: found.map(v => ({
      position: { x: v.x, y: v.y, z: v.z },
      distance: round(p.distanceTo(v)),
      name: b.blockAt(v)?.name,
    })),
  }
}

export async function goto({ x, y, z, range = 1 }) {
  const b = requireBot()
  const pf = await import('mineflayer-pathfinder')
  // CJS/ESM interop varies: the module may expose named exports directly or
  // only under `default`. Resolve both so `goals` and `Movements` are found.
  const goals = pf.goals ?? pf.default?.goals
  const Movements = pf.Movements ?? pf.default?.Movements
  if (!goals || !Movements || !goals.GoalNear) {
    return { reached: false, reason: 'pathfinder exports unavailable', ...positionOf(b) }
  }
  b.pathfinder.setMovements(new Movements(b))
  try {
    await b.pathfinder.goto(new goals.GoalNear(x, y, z, range))
  } catch (e) {
    // Pathfinding failure is ordinary -- unreachable, or the world changed
    // mid-walk. Report where it ended up rather than throwing.
    return { reached: false, reason: e.message, ...positionOf(b) }
  }
  return { reached: true, ...positionOf(b) }
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
  if (!b.canDigBlock(target)) {
    return { error: `cannot dig ${target.name} from here -- move closer, or you may need a better tool` }
  }
  const count = () => b.inventory.items().reduce((n, i) => n + i.count, 0)
  const before = count()
  try {
    await b.dig(target)
  } catch (e) {
    return { error: `dig failed: ${e.message}` }
  }
  // The drop lands on the ground and is only collected by standing on it.
  // Without this step the agent sees "dug X, gained 0" and cannot tell a
  // broken tool from a log lying half a metre away.
  await new Promise(r => setTimeout(r, 400))
  let collected = count() - before
  if (collected === 0) {
    try {
      const pf = await import('mineflayer-pathfinder')
      const { goals, Movements } = pf.default ?? pf
      b.pathfinder.setMovements(new Movements(b))
      await b.pathfinder.goto(new goals.GoalNear(x, y, z, 0))
      await new Promise(r => setTimeout(r, 900))
      collected = count() - before
    } catch {
      // Unreachable drop: report the dig honestly rather than pretending.
    }
  }
  return {
    dug: target.name,
    items_gained: collected,
    ...(collected === 0 ? { note: 'the block broke but nothing was collected -- the drop may be out of reach' } : {}),
    inventory: b.inventory.items().map(i => ({ name: i.name, count: i.count })),
  }
}
