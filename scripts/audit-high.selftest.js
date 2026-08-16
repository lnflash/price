#!/usr/bin/env node
/**
 * Proves the dependency-audit gate can actually fail.
 *
 * A security gate is only worth its slot in CI if every path that should stop
 * a merge has been watched doing it. These cases run against the real decision
 * function in ./audit-high.js — including the two waivers it ships — so a
 * change that silently disarms the gate (dropping the expiry check, waiving by
 * module name instead of advisory id, treating a missing summary as clean)
 * fails here rather than the next time something high lands in production
 * dependencies.
 *
 * Two layers, because the decision function is only half the gate:
 *   - unit cases call `evaluate` directly, for the failure modes that are
 *     awkward to stage through real audit output;
 *   - end-to-end cases pipe yarn-shaped JSON into the real script as a child
 *     process and assert on its exit status, so stdin parsing, the event-type
 *     dispatch and the exit codes are covered the same way CI invokes them. A
 *     typo in the `auditAdvisory` dispatch disarms the gate completely and is
 *     invisible to `evaluate`.
 *
 * Plain node, no test framework: this runs in the Security workflow next to
 * the audit itself, where jest is not otherwise needed.
 */
const assert = require("node:assert")
const { spawnSync } = require("node:child_process")

const { evaluate, collectAdvisory, WAIVERS } = require("./audit-high")

const TODAY = "2026-08-16"
const summary = { critical: 0, high: 1, moderate: 0, low: 0 }
const cleanSummary = { critical: 0, high: 0, moderate: 0, low: 0 }

const advisory = ({ id, module: mod = "some-pkg", severity = "high" }) => {
  const advisories = new Map()
  collectAdvisory(advisories, {
    advisory: {
      github_advisory_id: id,
      module_name: mod,
      severity,
      title: `${severity} issue in ${mod}`,
      patched_versions: ">=1.0.0",
    },
    resolution: { path: `realtime>${mod}` },
  })
  return advisories
}

const waiver = (over = {}) => ({
  id: "GHSA-waived-0001",
  module: "some-pkg",
  reviewBy: "2026-12-31",
  reason: "test",
  ...over,
})

// --- end-to-end helpers: the real script, real stdin, real exit codes -------

const runGate = (input) =>
  spawnSync(process.execPath, [require.resolve("./audit-high.js")], {
    input,
    encoding: "utf8",
  })

const advisoryEvent = ({ id, module: mod = "some-pkg", severity = "high" }) =>
  JSON.stringify({
    type: "auditAdvisory",
    data: {
      advisory: {
        github_advisory_id: id,
        module_name: mod,
        severity,
        title: `${severity} issue in ${mod}`,
        patched_versions: ">=1.0.0",
      },
      resolution: { path: `realtime>${mod}` },
    },
  })

const summaryEvent = (counts = {}) =>
  JSON.stringify({
    type: "auditSummary",
    data: { vulnerabilities: { ...cleanSummary, ...counts } },
  })

/** The advisory stream that the shipped WAIVERS are written against. */
const waivedAdvisoryEvents = () =>
  WAIVERS.map((w) => advisoryEvent({ id: w.id, module: w.module }))

const cases = []
const test = (name, fn) => cases.push([name, fn])

test("an unwaived high fails the gate", () => {
  const { failures } = evaluate({
    advisories: advisory({ id: "GHSA-unwaived-0001" }),
    summary,
    waivers: [],
    today: TODAY,
  })
  assert.strictEqual(failures.length, 1)
  assert.match(failures[0], /HIGH some-pkg \(GHSA-unwaived-0001\)/)
})

test("an unwaived critical fails the gate", () => {
  const { failures } = evaluate({
    advisories: advisory({ id: "GHSA-unwaived-0002", severity: "critical" }),
    summary,
    waivers: [],
    today: TODAY,
  })
  assert.strictEqual(failures.length, 1)
  assert.match(failures[0], /CRITICAL/)
})

test("a waived high inside its review window passes", () => {
  const { failures, waived } = evaluate({
    advisories: advisory({ id: "GHSA-waived-0001" }),
    summary,
    waivers: [waiver()],
    today: TODAY,
  })
  assert.deepStrictEqual(failures, [])
  assert.strictEqual(waived.length, 1)
})

test("a waiver past its review date fails, and stops counting as waived", () => {
  const { failures, waived } = evaluate({
    advisories: advisory({ id: "GHSA-waived-0001" }),
    summary,
    waivers: [waiver({ reviewBy: "2026-08-15" })],
    today: TODAY,
  })
  assert.strictEqual(waived.length, 0)
  assert.strictEqual(failures.length, 1)
  assert.match(failures[0], /expired on 2026-08-15/)
})

test("a waiver that matches nothing fails so it cannot outlive its dependency", () => {
  const { failures } = evaluate({
    advisories: new Map(),
    summary: cleanSummary,
    waivers: [waiver()],
    today: TODAY,
  })
  assert.strictEqual(failures.length, 1)
  assert.match(failures[0], /no longer matches any advisory/)
})

test("a waiver that is both expired and orphaned gives one instruction, not two", () => {
  // "extend the review date" is the wrong advice once the advisory is gone.
  const { failures } = evaluate({
    advisories: new Map(),
    summary: cleanSummary,
    waivers: [waiver({ reviewBy: "2026-08-15" })],
    today: TODAY,
  })
  assert.strictEqual(failures.length, 1)
  assert.match(failures[0], /no longer matches any advisory/)
  assert.doesNotMatch(failures[0], /expired on/)
})

test("a summary with critical paths but no advisories parsed fails, not passes", () => {
  // The counts we print and the advisories we gate on come from two different
  // yarn events. If advisory collection ever breaks, the gate must go red
  // rather than quietly reporting clean while yarn is reporting critical paths.
  const { failures } = evaluate({
    advisories: new Map(),
    summary: { critical: 3, high: 17, moderate: 0, low: 0 },
    waivers: [],
    today: TODAY,
  })
  assert.strictEqual(failures.length, 1)
  assert.match(failures[0], /yarn reported 20 critical\/high path\(s\)/)
})

test("waivers are keyed by advisory id, not module name", () => {
  // A second advisory against an already-waived package must still block.
  const advisories = advisory({ id: "GHSA-waived-0001" })
  collectAdvisory(advisories, {
    advisory: {
      github_advisory_id: "GHSA-new-0002",
      module_name: "some-pkg",
      severity: "high",
      title: "a different issue in the same package",
      patched_versions: ">=2.0.0",
    },
    resolution: { path: "realtime>some-pkg" },
  })

  const { failures } = evaluate({
    advisories,
    summary,
    waivers: [waiver()],
    today: TODAY,
  })
  assert.strictEqual(failures.length, 1)
  assert.match(failures[0], /GHSA-new-0002/)
})

test("moderate and low advisories do not block", () => {
  const { failures } = evaluate({
    advisories: advisory({ id: "GHSA-moderate-0001", severity: "moderate" }),
    summary: { critical: 0, high: 0, moderate: 1, low: 0 },
    waivers: [],
    today: TODAY,
  })
  assert.deepStrictEqual(failures, [])
})

test("a missing summary fails rather than reading as clean", () => {
  // yarn erroring out (network, registry) must never look like a green audit.
  const { failures } = evaluate({
    advisories: new Map(),
    summary: undefined,
    waivers: [],
    today: TODAY,
  })
  assert.strictEqual(failures.length, 1)
  assert.match(failures[0], /Unable to find yarn audit summary/)
})

test("the shipped waivers are complete, dated and unexpired", () => {
  const today = new Date().toISOString().slice(0, 10)
  for (const w of WAIVERS) {
    // collectAdvisory keys on `github_advisory_id || String(advisory.id)`, so a
    // waiver id is a GHSA slug or yarn's numeric advisory id — both are real
    // keys and both must be accepted here.
    assert.match(
      w.id,
      /^(GHSA-[\w-]+|\d+)$/,
      `waiver ${w.id} must be an advisory id (GHSA slug or numeric)`,
    )
    assert.match(w.reviewBy, /^\d{4}-\d{2}-\d{2}$/, `waiver ${w.id} needs a review date`)
    assert.ok(
      w.reason && w.reason.length > 80,
      `waiver ${w.id} needs a reason explaining why it is not exploitable here`,
    )
    assert.ok(
      w.reviewBy >= today,
      `waiver ${w.id} expired on ${w.reviewBy} — re-check the advisory`,
    )
  }
})

// --- end-to-end: stdin in, exit status out ---------------------------------

test("e2e: an unwaived high exits 1 through the real script", () => {
  const { status, stderr } = runGate(
    [
      ...waivedAdvisoryEvents(),
      advisoryEvent({ id: "GHSA-unwaived-0003" }),
      summaryEvent({ high: WAIVERS.length + 1 }),
    ].join("\n"),
  )
  assert.strictEqual(status, 1, `expected exit 1, got ${status}\n${stderr}`)
  assert.match(stderr, /HIGH some-pkg \(GHSA-unwaived-0003\)/)
})

test("e2e: the shipped waivers alone exit 0 through the real script", () => {
  const { status, stdout, stderr } = runGate(
    [...waivedAdvisoryEvents(), summaryEvent({ high: WAIVERS.length })].join("\n"),
  )
  assert.strictEqual(status, 0, `expected exit 0, got ${status}\n${stderr}`)
  assert.match(stdout, /No unwaived critical\/high advisories/)
})

test("e2e: unparsable audit output exits 1 even when nothing else fails", () => {
  // Everything here would pass on its own; only the malformed line must fail
  // it, so a broken audit stream can never read as a green gate.
  const { status, stderr } = runGate(
    [...waivedAdvisoryEvents(), "{not json", summaryEvent({ high: WAIVERS.length })].join(
      "\n",
    ),
  )
  assert.strictEqual(status, 1, `expected exit 1, got ${status}\n${stderr}`)
  assert.match(stderr, /Unable to parse yarn audit output/)
})

test("e2e: a summary with no advisories parsed exits 1, not 0", () => {
  // The regression this catches: advisory collection stops working (renamed
  // event type, changed payload shape) while yarn still reports critical paths.
  const { status, stderr } = runGate(summaryEvent({ critical: 3, high: 17 }))
  assert.strictEqual(status, 1, `expected exit 1, got ${status}\n${stderr}`)
  assert.match(stderr, /Refusing to report this as clean/)
})

let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error.message}`)
  }
}

console.log(`\n${cases.length - failed}/${cases.length} audit-gate self-tests passed`)
if (failed > 0) process.exit(1)
