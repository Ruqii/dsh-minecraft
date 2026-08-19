// Recording the run, which the board requires and scores harshly: a run with
// no video is 0.0 however far it got.
//
// This is deliberately NOT a tool. The agent does not choose whether to be
// filmed -- that is the harness's business -- so it is switched on by
// MC_RECORD_DIR at connect time and finalised at disconnect. Adding
// mc_record_start would hand the agent a decision that is not part of playing.
//
// The pipeline is the one already proven in the reference solution repo:
// prismarine-viewer serves a third-person view of this bot, headless Chrome
// renders it with software WebGL (SwiftShader, which is what works on arm64),
// CDP screencasts frames to disk, and ffmpeg muxes them at the end.
//
// Every dependency here is optional and imported lazily. A machine without
// Chrome or prismarine-viewer still gets a fully working plugin -- it just
// cannot film, and says so instead of failing to connect.

import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const FPS = Number.parseInt(process.env.MC_RECORD_FPS ?? '10', 10)
const PORT = Number.parseInt(process.env.MC_RECORD_PORT ?? '3017', 10)
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

let session = null
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export function wanted() {
  const dir = process.env.MC_RECORD_DIR
  if (typeof dir !== 'string' || dir.length === 0) return null
  // Absolute, always: the path is handed to a person who has to go and find
  // the file, and a relative one resolves against wherever the harness happened
  // to be started.
  return path.resolve(dir)
}

export function status() {
  if (session === null) return { recording: false }
  return { recording: true, dir: session.dir, frames: session.frameCount() }
}

export async function start(bot, dir) {
  if (session !== null) return { started: false, reason: 'already recording' }
  const frames = path.join(dir, 'frames')
  try {
    rmSync(frames, { recursive: true, force: true })
    mkdirSync(frames, { recursive: true })
  } catch (e) {
    return { started: false, reason: `could not prepare ${frames}: ${e.message}` }
  }
  if (!existsSync(CHROME)) {
    return { started: false, reason: `no Chrome at ${CHROME} -- set CHROME_PATH` }
  }

  let mineflayerViewer, puppeteer
  try {
    ;({ mineflayer: mineflayerViewer } = await import('prismarine-viewer'))
    puppeteer = (await import('puppeteer-core')).default
  } catch (e) {
    // prismarine-viewer pulls in `canvas`, a native module. A DSH profile
    // installs plugin dependencies without running install scripts, so the
    // package arrives complete except for the one file that matters and the
    // failure reads as "missing dependency" when everything is present.
    //
    // Worth being exact about: recording is the difference between a scored
    // run and a 0.0, and this is the state where it silently does not happen.
    if (/canvas\.node|Cannot find module '\.\.\/build/.test(e.message)) {
      return {
        started: false,
        reason: 'the native canvas module was installed but never built, which is what a plugin install without scripts leaves behind. ' +
          'Run `npm rebuild canvas` inside <DSH_HOME>/profiles/<name>/node_modules/canvas and recording will work on the next run.',
      }
    }
    return { started: false, reason: `recording needs prismarine-viewer and puppeteer-core: ${e.message}` }
  }

  let browser
  try {
    // First person, not the third-person default the reference solution used.
    // A third-person camera sits behind and above the bot, which is fine on the
    // surface and useless underground -- the 1.0 run spent its second half at
    // y=-35 mining deepslate and the video showed the spawn forest the whole
    // time. The video exists to make the run checkable; the eyes are where the
    // evidence is.
    mineflayerViewer(bot, { port: PORT, firstPerson: true, viewDistance: 6 })
    await sleep(2500)
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      // SwiftShader rather than a real GPU: headless Chrome on arm64 has no
      // usable hardware WebGL, and without these the page renders black.
      args: ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--no-sandbox', '--window-size=1280,720'],
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 720 })
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle2', timeout: 30000 })
    await sleep(4000)   // let the scene actually draw before capturing black frames

    const client = await page.target().createCDPSession()
    let n = 0
    client.on('Page.screencastFrame', async ({ data, sessionId }) => {
      try {
        writeFileSync(path.join(frames, `f${String(n).padStart(6, '0')}.jpg`), Buffer.from(data, 'base64'))
        n++
      } catch { /* disk hiccup: drop the frame rather than the run */ }
      try { await client.send('Page.screencastFrameAck', { sessionId }) } catch {}
    })
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 })
    session = { dir, frames, browser, client, startedAt: Date.now(), frameCount: () => n }
    return { started: true, dir }
  } catch (e) {
    try { await browser?.close() } catch {}
    return { started: false, reason: `could not start the capture: ${e.message}` }
  }
}

// Frames are written continuously, so even a run that dies without reaching
// this leaves something a harness can mux by hand.
export async function stop() {
  if (session === null) return { recorded: false, reason: 'was not recording' }
  const { dir, frames, browser, client, startedAt } = session
  session = null
  try { await client.send('Page.stopScreencast') } catch {}
  await sleep(300)
  let n = 0
  try { n = readdirSync(frames).filter(f => f.endsWith('.jpg')).length } catch {}
  try { await browser.close() } catch {}

  if (n < 5) return { recorded: false, reason: `only ${n} frames captured`, frames_dir: frames }
  const mp4 = path.join(dir, 'run.mp4')
  const r = spawnSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(frames, 'f%06d.jpg'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:720', mp4], { encoding: 'utf8' })
  if (r.status !== 0) {
    return { recorded: false, reason: `ffmpeg failed: ${(r.stderr ?? '').slice(-300)}`, frames_dir: frames }
  }
  let bytes = 0
  try { bytes = statSync(mp4).size } catch {}
  const outcome = {
    video: mp4,
    frames: n,
    seconds: Math.round(n / FPS),
    wall_time_s: Math.round((Date.now() - startedAt) / 1000),
  }
  try { writeFileSync(path.join(dir, 'recording.json'), JSON.stringify(outcome, null, 2)) } catch {}
  return { recorded: true, ...outcome, bytes }
}
