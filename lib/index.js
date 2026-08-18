// DSH binding. The tools are deliberately few and blunt: an agent playing a
// survival game needs to see, walk, and dig, and every extra tool is one more
// thing to choose wrongly under a thirty-minute clock.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { connect, disconnect, dig, find, goto, observe, state } from './bot.js'

export const name = 'minecraft'
export const inject = ['tools']

const asText = (t) => [{ type: 'text', text: t }]

function renderObserve(v) {
  if (v?.error) return v.error
  const p = v.position
  const inv = v.inventory.length ? v.inventory.map(i => `${i.name} x${i.count}`).join(', ') : 'empty'
  const near = v.blocks_nearby.map(b => `${b.name} x${b.count}`).join(', ')
  const mobs = v.entities_nearby.length ? v.entities_nearby.map(e => `${e.name} ${e.distance}m`).join(', ') : 'none in sight'
  const lines = [
    `at ${p.x}, ${p.y}, ${p.z} on ${v.standing_on} -- health ${v.health}, food ${v.food}, ${v.dimension}`,
    `inventory: ${inv}`,
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
    async execute(args) { return await connect(args ?? {}) },
  }))

  ctx.tools.register(defineTool({
    name: 'mc_observe',
    description: 'Look around: position, health, food, inventory, nearby blocks and entities, plus anything that happened since you last looked. Call this before deciding what to do.',
    parameters: { radius: { type: 'integer', description: 'How far to scan for blocks. Default 5.' } },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(renderObserve(v)) },
    async execute(args) {
      try { return observe(args ?? {}) } catch (e) { return { error: e.message } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mc_find',
    description: 'Find the nearest blocks of a kind and report their coordinates, so you can walk to them instead of digging blindly.',
    parameters: {
      name: { type: 'string', description: 'Block name or fragment, e.g. "diamond_ore", "log", "water".', required: true },
      radius: { type: 'integer', description: 'Search radius. Default 32.' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(
      v?.error ? v.error
      : v.found.length === 0 ? v.note
      : v.found.map(f => `${f.name} at ${f.position.x}, ${f.position.y}, ${f.position.z} (${f.distance}m)`).join('\n')) },
    async execute(args) {
      try { return find(args ?? {}) } catch (e) { return { error: e.message } }
    },
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
      : v.reached ? `arrived at ${v.position.x}, ${v.position.y}, ${v.position.z}`
      : `did not arrive (${v.reason}) -- now at ${v.position.x}, ${v.position.y}, ${v.position.z}`) },
    async execute(args) {
      try { return await goto(args ?? {}) } catch (e) { return { error: e.message } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mc_dig',
    description: 'Break the block at exact coordinates and collect what it drops. The block must be within reach -- walk to it first.',
    parameters: { x: { type: 'number', required: true }, y: { type: 'number', required: true }, z: { type: 'number', required: true } },
    output: { schema: { type: 'json' }, render: (_a, v) => asText(
      v?.error ? v.error
      : `dug ${v.dug}, gained ${v.items_gained} item(s)\ninventory: ${v.inventory.map(i => `${i.name} x${i.count}`).join(', ') || 'empty'}`) },
    async execute(args) {
      try { return await dig(args ?? {}) } catch (e) { return { error: e.message } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mc_disconnect',
    description: 'Leave the server and drop the connection.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => asText(v?.error ?? 'disconnected') },
    async execute() { return disconnect() },
  }))

  ctx.inject(['systemPrompt'], child => {
    child.systemPrompt.section({
      name: 'tool:minecraft',
      order: 117,
      text:
        'The mc_ tools drive a real Minecraft bot on a live server. mc_connect first, then mc_observe before every decision -- ' +
        'the world changes while you are not looking, and mc_observe reports what happened since your last look. ' +
        'Use mc_find to locate a block and mc_goto to walk to it before mc_dig; digging without looking wastes the clock. ' +
        'Nothing here is simulated: a death, a lost tool or a wasted hour is real and cannot be undone.',
    })
  })
}

export default { name, inject, apply }
