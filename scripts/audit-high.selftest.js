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
 * Plain node, no test framework: this runs in the Security workflow next to
 * the audit itself, where jest is not otherwise needed.
 */
const assert = require("node:assert")

const { evaluate, collectAdvisory, WAIVERS } = require("./audit-high")

const TODAY = "2026-08-16"
const summary = { critical: 0, high: 1, moderate: 0, low: 0 }

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
    summary,
    waivers: [waiver()],
    today: TODAY,
  })
  assert.strictEqual(failures.length, 1)
  assert.match(failures[0], /no longer matches any advisory/)
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
    assert.match(w.id, /^GHSA-/, `waiver ${w.id} must reference a GHSA id`)
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
