// The OhMyBug uptime probe. A scheduled workflow runs it every 5 minutes (GitHub adds 5-15 minutes of jitter).
//   node probe.mjs              take one sample, update samples.json and history.json
//   node probe.mjs --self-test  check the roll-up on synthetic samples; writes nothing
// No dependencies: Node 20+ (fetch, AbortSignal.timeout).
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const BASE = 'https://mcp.ohmybug.ai'
const TIMEOUT_MS = 10_000
const DAY_MS = 86_400_000
const DAYS = 90

async function hit(path) {
  const t = Date.now()
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'cache-control': 'no-cache' } })
    const body = await r.json().catch(() => null)
    return { status: r.status, body, ms: Date.now() - t }
  } catch {
    return { status: 0, body: null, ms: Date.now() - t }
  }
}

/** One sample from the two reads. /site/status may be absent (404): then /healthz alone decides. */
export function sample(health, status, t) {
  const ok = health.status === 200 && health.body?.ok === true && status.body?.ok !== false
  const hunting = typeof status.body?.hunting === 'boolean' ? status.body.hunting : health.body?.hunting !== false
  return { t, ok, hunting: ok && hunting, ms: health.ms }
}

const dayOf = ms => new Date(ms).toISOString().slice(0, 10)

/**
 * The page's history.json: { updated, days: [{ day, samples, ok, degraded }] }, at most 90 days, oldest first.
 * ok = operational samples, degraded = up but not taking new hunts; the rest of `samples` were down.
 * Days the raw samples still cover are recounted from them; older days are carried over from the previous file.
 */
export function rollup(samples, previous, now) {
  const first = dayOf(now - (DAYS - 1) * DAY_MS)
  const counted = new Map()
  for (const s of samples) {
    const day = dayOf(s.t)
    const d = counted.get(day) ?? { day, samples: 0, ok: 0, degraded: 0 }
    d.samples++
    if (s.ok && s.hunting) d.ok++
    else if (s.ok) d.degraded++
    counted.set(day, d)
  }
  const days = new Map((Array.isArray(previous?.days) ? previous.days : []).map(d => [d.day, d]))
  for (const [day, d] of counted) days.set(day, d)
  return {
    updated: new Date(now).toISOString(),
    days: [...days.values()].filter(d => d.day >= first && d.day <= dayOf(now)).sort((a, b) => (a.day < b.day ? -1 : 1)),
  }
}

/** Raw samples kept: today and yesterday (UTC) in full, so both days are always recounted whole. */
export function keep(samples, now) {
  const from = Date.parse(dayOf(now - DAY_MS))
  return samples.filter(s => s.t >= from)
}

function read(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

function selfTest() {
  const now = Date.parse('2026-11-06T12:00:00Z')
  const at = (day, hh) => Date.parse(`${day}T${hh}:00:00Z`)
  const samples = [
    { t: at('2026-11-04', '10'), ok: true, hunting: true, ms: 100 }, // older than yesterday: dropped from the raw file
    { t: at('2026-11-05', '01'), ok: true, hunting: true, ms: 100 },
    { t: at('2026-11-05', '02'), ok: true, hunting: false, ms: 100 },
    { t: at('2026-11-05', '03'), ok: false, hunting: false, ms: 10_000 },
    { t: at('2026-11-06', '11'), ok: true, hunting: true, ms: 100 },
  ]
  const kept = keep(samples, now)
  assert.equal(kept.length, 4, 'the sample from two days ago is dropped')
  const previous = { days: [
    { day: '2026-08-01', samples: 9, ok: 9, degraded: 0 }, // older than 90 days
    { day: '2026-11-04', samples: 288, ok: 280, degraded: 6 },
    { day: '2026-11-05', samples: 1, ok: 1, degraded: 0 }, // recounted from the raw samples
  ] }
  const h = rollup(kept, previous, now)
  assert.deepEqual(Object.keys(h), ['updated', 'days'])
  assert.deepEqual(h.days, [
    { day: '2026-11-04', samples: 288, ok: 280, degraded: 6 },
    { day: '2026-11-05', samples: 3, ok: 1, degraded: 1 },
    { day: '2026-11-06', samples: 1, ok: 1, degraded: 0 },
  ])
  for (const d of h.days) {
    assert.deepEqual(Object.keys(d), ['day', 'samples', 'ok', 'degraded'])
    assert.ok(d.ok + d.degraded <= d.samples)
  }
  assert.deepEqual(sample({ status: 200, body: { ok: true }, ms: 5 }, { status: 404, body: { error: 'x' } }, 1), { t: 1, ok: true, hunting: true, ms: 5 })
  assert.deepEqual(sample({ status: 200, body: { ok: true, hunting: false }, ms: 5 }, { status: 0, body: null }, 1), { t: 1, ok: true, hunting: false, ms: 5 })
  assert.deepEqual(sample({ status: 200, body: { ok: true }, ms: 5 }, { status: 200, body: { ok: false, hunting: true } }, 1), { t: 1, ok: false, hunting: false, ms: 5 })
  assert.deepEqual(sample({ status: 0, body: null, ms: 10_000 }, { status: 0, body: null }, 1), { t: 1, ok: false, hunting: false, ms: 10_000 })
  console.log('self-test ok')
}

async function main() {
  const now = Date.now()
  const [health, status] = await Promise.all([hit('/healthz'), hit('/site/status')])
  const s = sample(health, status, now)
  const old = read('samples.json', [])
  const samples = keep([...(Array.isArray(old) ? old : []), s], now)
  writeFileSync('samples.json', JSON.stringify(samples) + '\n')
  writeFileSync('history.json', JSON.stringify(rollup(samples, read('history.json', null), now)) + '\n')
  console.log(JSON.stringify(s))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-test')) selfTest()
  else await main()
}
