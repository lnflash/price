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

/**
 * One yarn `auditAdvisory` payload. `numericId` populates yarn's own numeric
 * `id` field, which is what collectAdvisory keys on when an advisory carries no
 * GHSA slug.
 */
const advisoryData = ({
  id,
  numericId,
  module: mod = "some-pkg",
  severity = "high",
  path = `realtime>${mod}`,
}) => ({
  advisory: {
    github_advisory_id: id,
    id: numericId,
    module_name: mod,
    severity,
    title: `${severity} issue in ${mod}`,
    patched_versions: ">=1.0.0",
  },
  resolution: { path },
})

const advisory = (over) => collectAdvisory(new Map(), advisoryData(over))

/** The advisory map the shipped WAIVERS are written against: one path each. */
const waivedAdvisories = () =>
  WAIVERS.reduce(
    (advisories, w) =>
      collectAdvisory(advisories, advisoryData({ id: w.id, module: w.module })),
    new Map(),
  )

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

const advisoryEvent = (over) =>
  JSON.stringify({ type: "auditAdvisory", data: advisoryData(over) })

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

test("a summary reporting more blocking paths than were parsed fails, not passes", () => {
  // Partial blindness, which a zero/non-zero test cannot see: the two shipped
  // waivers parse fine while the rest of the output vanishes. Every parsed
  // advisory is legitimately waived, so nothing else here fails — without the
  // path-count comparison this is a green gate with 15 unaccounted-for high
  // paths behind it.
  const { failures } = evaluate({
    advisories: waivedAdvisories(),
    summary: { critical: 0, high: 17, moderate: 0, low: 0 },
    waivers: WAIVERS,
    today: TODAY,
  })
  assert.strictEqual(failures.length, 1)
  assert.match(failures[0], /yarn reported 17 critical\/high path\(s\) but only 2/)
})

/** One advisory yarn reached by two dependency paths — two auditAdvisory events. */
const multiPathAdvisory = () =>
  collectAdvisory(
    advisory({ id: "GHSA-waived-0001" }),
    advisoryData({ id: "GHSA-waived-0001", path: "history>some-pkg" }),
  )

test("one advisory reached by several paths reconciles against the path count", () => {
  // The reconciliation counts paths, not advisories, because that is the unit
  // yarn's summary counts in: two paths into one package are two summary paths
  // and one deduped advisory. Comparing advisory counts would turn this — an
  // entirely normal audit — red.
  const { failures } = evaluate({
    advisories: multiPathAdvisory(),
    summary: { critical: 0, high: 2, moderate: 0, low: 0 },
    waivers: [waiver()],
    today: TODAY,
  })
  assert.deepStrictEqual(failures, [])
})

test("more parsed paths than the summary reports does not fail", () => {
  // The comparison is one-directional on purpose: an over-count is not the
  // silent green this check exists for, and must never turn the gate red on
  // its own.
  const { failures } = evaluate({
    advisories: multiPathAdvisory(),
    summary: { critical: 0, high: 1, moderate: 0, low: 0 },
    waivers: [waiver()],
    today: TODAY,
  })
  assert.deepStrictEqual(failures, [])
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

test("an advisory with no GHSA slug is keyed by yarn's numeric advisory id", () => {
  // The fallback in collectAdvisory. Keying on anything package-shaped instead
  // — the module name being the obvious slip — would silently turn every
  // waiver into a blanket waiver for its package, which is the property the
  // case below defends.
  const advisories = advisory({ numericId: 1234 })
  assert.deepStrictEqual([...advisories.keys()], ["1234"])
})

test("a numeric-keyed advisory cannot be waived by its module name", () => {
  const { failures, waived } = evaluate({
    advisories: advisory({ numericId: 1234 }),
    summary,
    waivers: [waiver({ id: "some-pkg" })],
    today: TODAY,
  })
  assert.strictEqual(waived.length, 0)
  assert.ok(
    failures.some((f) => /HIGH some-pkg \(1234\)/.test(f)),
    `expected the advisory to still block, got: ${JSON.stringify(failures)}`,
  )
})

test("a waiver whose module does not match the advisory fails", () => {
  // Copy a waiver to cover a new advisory, change the id, forget the module:
  // the gate must not accept a risk while describing it as something else.
  const { failures, waived } = evaluate({
    advisories: advisory({ id: "GHSA-waived-0001", module: "other-pkg" }),
    summary,
    waivers: [waiver()], // claims module "some-pkg"
    today: TODAY,
  })
  assert.strictEqual(waived.length, 0)
  assert.strictEqual(failures.length, 1)
  assert.match(
    failures[0],
    /Waiver GHSA-waived-0001 claims module some-pkg but the advisory is against other-pkg/,
  )
})

test("an expired waiver's failure names the advisory's module, not the waiver's claim", () => {
  const { failures } = evaluate({
    advisories: advisory({ id: "GHSA-waived-0001", module: "other-pkg" }),
    summary,
    waivers: [waiver({ reviewBy: "2026-08-15" })], // claims module "some-pkg"
    today: TODAY,
  })
  const expiry = failures.find((f) => /expired on/.test(f))
  assert.ok(expiry, `expected an expiry failure, got: ${JSON.stringify(failures)}`)
  assert.match(expiry, /Waiver for GHSA-waived-0001 \(other-pkg\)/)
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

test("e2e: a summary with only some advisories parsed exits 1, not 0", () => {
  // The partial version of the same regression, and the one that gets past a
  // zero/non-zero check: the shipped waivers parse, the other 15 high paths
  // do not, and everything that did parse is legitimately waived.
  const { status, stderr } = runGate(
    [...waivedAdvisoryEvents(), summaryEvent({ high: 17 })].join("\n"),
  )
  assert.strictEqual(status, 1, `expected exit 1, got ${status}\n${stderr}`)
  assert.match(stderr, /but only 2 were parsed into advisories/)
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
