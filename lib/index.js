// DSH binding. The tools are deliberately few and blunt: an agent playing a
// survival game needs to see, walk, dig, craft and build, and every extra tool
// is one more thing to choose wrongly under a thirty-minute clock.
//
// Each one exposes a single game action. None of them plans, and none of them
// repairs a mistake the agent made -- docs/next-steps.md has the reasoning.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { attack, connect, craft, disconnect, dig, eat, equip, find, goto, jsonSafe, observe, place, smelt, state } from './bot.js'

export const name = 'minecraft'
export const inject = ['tools']

const asText = (t) => [{ type: 'text', text: t }]
const listInv = (inv) => inv?.map(i => `${i.name} x${i.count}`).join(', ') || 'empty'

// Every tool result crosses into DSH, which rejects `undefined` anywhere
// inside it -- and JSON.stringify hides that, so a self-check will not catch
// it. One guard on the boundary rather than vigilance in ten places.
const run = (fn) => async (args) => {
  try {
    return jsonSafe(await fn(args ?? {}))
  } catch (e) {
    return { error: e.message }
  }
}

function renderObserve(v) {
  if (v?.error) return v.error
  const p = v.position
  const near = v.blocks_nearby.map(b => `${b.name} x${b.count}`).join(', ')
  const mobs = v.entities_nearby.length ? v.entities_nearby.map(e => `${e.name} ${e.distance}m`).join(', ') : 'none in sight'
  const lines = [
    `at ${p.x}, ${p.y}, ${p.z} on ${v.standing_on} -- health ${v.health}, food ${v.food}, ${v.dimension}`,
    `inventory: ${listInv(v.inventory)}`,
    `blocks within reach: ${near}`,
    `entities: ${mobs}`,
  ]
  // Things that happened while the agent was not looking. Empty most of the
  // time, and the only way it learns it took damage during a long walk.
  if (v.since_last_look?.length) lines.push(`since you last looked: ${v.since_last_look.join('; ')}`)
  return lines.join('\n')
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'mc_connect',
    description: 'Join a Minecraft server as a bot. Call once at the start; every other mc_ tool needs it. Defaults to 127.0.0.1:25565.',
    parameters: {
      host: { type: 'string', description: 'Server host. Default 127.0.0.1.' },
      port: { type: 'integer', description: 'Server port. Default 25565.' },
      username: { type: 'string', description: 'Bot name. Default dsh_agent.' },
      version: { type: 'string', description: 'Minecraft version, e.g. 1.20.4.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(v?.error ? v.error : `Joined.\n${renderObserve(v)}`) },
    execute: run(connect),
  }))

  ctx.tools.register(defineTool({
    name: 'mc_observe',
    description: 'Look around: position, health, food, inventory, nearby blocks and entities, plus anything that happened since you last looked. Only blocks with an uncovered face are listed -- buried ones are not visible. Call this before deciding what to do.',
    parameters: { radius: { type: 'integer', description: 'How far to scan for blocks. Default 5.' } },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(renderObserve(v)) },
    execute: run(observe),
  }))

  ctx.tools.register(defineTool({
    name: 'mc_find',
    description: 'Find the nearest blocks of a kind that have an uncovered face, and report their coordinates. Blocks still buried behind solid rock are NOT found -- an empty result means none is exposed nearby, not that none exists.',
    parameters: {
      name: { type: 'string', description: 'Block name or fragment, e.g. "diamond_ore", "log", "water".', required: true },
      radius: { type: 'integer', description: 'Search radius. Default 32.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(
      v?.error ? v.error
      : v.found.length === 0 ? v.note
      : v.found.map(f => `${f.name} at ${f.position.x}, ${f.position.y}, ${f.position.z} (${f.distance}m)`).join('\n')) },
    execute: run(find),
  }))

  ctx.tools.register(defineTool({
    name: 'mc_goto',
    description: 'Walk to coordinates, pathfinding around obstacles. Returns where the bot ended up, which may not be where you asked if the way was blocked.',
    parameters: {
      x: { type: 'number', required: true }, y: { type: 'number', required: true }, z: { type: 'number', required: true },
      range: { type: 'integer', description: 'How close is close enough. Default 1.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(
      v?.error ? v.error
      : v.reached ? `arrived at ${v.position.x}, ${v.position.y}, ${v.position.z}` + (v.spent?.length ? ` (used ${v.spent.map(x => `${x.name} x${x.count}`).join(', ')} to get across)` : '')
      : `did not arrive (${v.reason}) -- now at ${v.position.x}, ${v.position.y}, ${v.position.z}`) },
    execute: run(goto),
  }))

  ctx.tools.register(defineTool({
    name: 'mc_dig',
    description: 'Break the block at exact coordinates and collect what it drops. The block must be within reach -- walk to it first.',
    parameters: { x: { type: 'number', required: true }, y: { type: 'number', required: true }, z: { type: 'number', required: true } },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(
      v?.error ? v.error
      : `dug ${v.dug}, collected ${v.collected}${v.took_damage ? ` -- TOOK ${v.took_damage} DAMAGE, health ${v.health}` : ''}${v.note ? `\n${v.note}` : ''}\ninventory: ${listInv(v.inventory)}`) },
    execute: run(dig),
  }))

  ctx.tools.register(defineTool({
    name: 'mc_craft',
    description:
      'Craft an item from materials already in the inventory. It does not gather anything and does not place anything for you: ' +
      'if materials are short it reports which and how many, and if the recipe needs a crafting table within reach it says so.',
    parameters: {
      item: { type: 'string', description: 'Exact item name to craft, e.g. "stick", "wooden_pickaxe".', required: true },
      times: {
        type: 'integer',
        // Naming this "count" would be a lie: bot.craft repeats the whole
        // recipe, and one run of a recipe can produce several items.
        description: 'How many times to run the recipe -- not how many items you receive. A recipe yielding several items per run gives that many times this number. Default 1.',
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(
      v?.error
        ? (v.missing?.length ? `${v.error}: need ${v.missing.map(m => `${m.item} x${m.need} (have ${m.have})`).join(', ')}` : v.error)
        : `crafted ${v.crafted} -- gained ${v.gained.map(g => `${g.name} x${g.count}`).join(', ') || 'nothing'}\ninventory: ${listInv(v.inventory)}`) },
    execute: run(craft),
  }))

  ctx.tools.register(defineTool({
    name: 'mc_equip',
    description:
      'Hold an item from the inventory, or wear it. Digging and placing use whatever is in hand, so an item sitting in the inventory has no effect until it is equipped. It equips exactly what you name and never chooses for you.',
    parameters: {
      item: { type: 'string', description: 'Exact item name, e.g. "wooden_pickaxe".', required: true },
      destination: { type: 'string', description: 'hand, off-hand, head, torso, legs or feet. Default hand.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(
      v?.error ? v.error : `holding ${v.holding ?? 'nothing'}${v.destination === 'hand' ? '' : ` (${v.destination})`}`) },
    execute: run(equip),
  }))

  ctx.tools.register(defineTool({
    name: 'mc_place',
    description:
      'Put a block from the inventory into the world at exact coordinates. The spot must be empty, within about 4 blocks, and touching something solid to rest against.',
    parameters: {
      item: { type: 'string', description: 'Exact item name to place, e.g. "crafting_table".', required: true },
      x: { type: 'number', required: true }, y: { type: 'number', required: true }, z: { type: 'number', required: true },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(
      v?.error ? v.error
      : v.placed ? `placed at ${v.position.x}, ${v.position.y}, ${v.position.z}`
      : `nothing was placed -- ${v.block_at_target} is at ${v.position.x}, ${v.position.y}, ${v.position.z}${v.reason ? ` (${v.reason})` : ''}`) },
    execute: run(place),
  }))

  ctx.tools.register(defineTool({
    name: 'mc_smelt',
    description:
      'Smelt items in a furnace that is already standing within about 3 blocks. You choose the fuel: different fuels burn for very different lengths of time. It will not build a furnace and will not pick a fuel for you.',
    parameters: {
      input: { type: 'string', description: 'Exact item name to smelt, e.g. "raw_iron".', required: true },
      fuel: { type: 'string', description: 'Exact item name to burn, e.g. "coal", "spruce_planks".', required: true },
      count: { type: 'integer', description: 'How many items to smelt. Default 1.' },
      fuel_count: { type: 'integer', description: 'How many fuel items to load. Default 1. Too little and the batch stops part-way.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(
      v?.error ? v.error
      : `smelted ${v.smelted} -- gained ${v.gained.map(g => `${g.name} x${g.count}`).join(', ')}${v.note ? `\n${v.note}` : ''}\ninventory: ${listInv(v.inventory)}`) },
    execute: run(smelt),
  }))

  ctx.tools.register(defineTool({
    name: 'mc_attack',
    description:
      'Swing at the nearest entity of a given kind. Melee reach is about 3 blocks -- further than that and nothing lands. It does not choose the target and does not choose a weapon; what is in your hand decides the damage.',
    parameters: {
      target: { type: 'string', description: 'Entity name, e.g. "skeleton", "zombie", "cow".', required: true },
      swings: { type: 'integer', description: 'How many swings, up to 10, paced by the attack cooldown. Default 1.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(
      v?.error ? v.error
      : (v.killed ? 'killed the ' + v.target : 'hit the ' + v.target + ' ' + v.swings + ' time(s), still there at ' + v.distance + 'm')
        + (v.took_damage ? ' -- TOOK ' + v.took_damage + ' DAMAGE' : '') + ', health ' + v.health) },
    execute: run(attack),
  }))

  ctx.tools.register(defineTool({
    name: 'mc_eat',
    description:
      'Eat a food item from the inventory. Low food stops health from regenerating, which is what turns a survivable fight into a fatal one. Puts back whatever you were holding afterwards.',
    parameters: { item: { type: 'string', description: 'Exact food item name, e.g. "bread", "cooked_beef".', required: true } },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(
      v?.error ? v.error : 'ate ' + v.ate + ' -- food ' + v.food_before + ' -> ' + v.food + ', health ' + v.health) },
    execute: run(eat),
  }))

  ctx.tools.register(defineTool({
    name: 'mc_disconnect',
    description: 'Leave the server and drop the connection.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => asText(
      v?.error ? v.error
      : v.recording?.recorded ? 'disconnected -- recorded ' + v.recording.seconds + 's to ' + v.recording.video
      : v.recording ? 'disconnected -- no video: ' + v.recording.reason
      : 'disconnected') },
    execute: run(disconnect),
  }))

  ctx.inject(['systemPrompt'], child => {
    child.systemPrompt.section({
      name: 'tool:minecraft',
      order: 117,
      // Interface only. What a tool needs in order to work is fair to state;
      // which tool to reach for, and in what order, is the thing being
      // measured and must not appear here.
      text:
        'The mc_ tools drive a real Minecraft bot on a live server. mc_connect first, then mc_observe before every decision -- ' +
        'the world changes while you are not looking, and mc_observe reports what happened since your last look. ' +
        'Use mc_find to locate a block and mc_goto to walk to it before mc_dig; digging without looking wastes the clock. ' +
        // Without this the agent reads an empty mc_find as "there is none here"
        // and stops -- measuring the tool's blind spot instead of the agent.
        'You can only see blocks that have an uncovered face, the same as standing there and looking: something buried inside solid rock is invisible until it is uncovered, so an empty mc_find means none is exposed nearby, not that none exists. ' +
        'mc_craft only ever uses what is already in the inventory, and mc_place only ever puts down a block you already hold; ' +
        // A tool in the inventory does nothing until it is held. Stating that is
        // interface -- a player can see their own hand; which tool to hold is not.
        'mc_dig breaks blocks with whatever is in your hand, so a tool sitting in the inventory changes nothing until mc_equip puts it there. ' +
        'mc_smelt needs a furnace already standing within reach and a fuel you name; it builds nothing and chooses nothing. ' +
        // Stating that hostiles exist and that darkness and hunger matter is
        // the same knowledge a player has from looking at the screen. What to
        // do about any of it is not stated anywhere.
        'On any difficulty above peaceful, hostile mobs spawn in the dark and will kill an unprepared bot underground; mc_dig and mc_goto report damage as it happens, and mc_attack and mc_eat are the only responses available. ' +
        'neither will fetch or build anything on your behalf, so read what they report back and decide what to do about it. ' +
        'Nothing here is simulated: a death, a lost tool or a wasted hour is real and cannot be undone.',
    })
  })
}

export default { name, inject, apply }
