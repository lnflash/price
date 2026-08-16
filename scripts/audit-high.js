const readline = require("node:readline")

/**
 * Gate on critical/high advisories in PRODUCTION dependencies.
 *
 * Reads `yarn audit --groups dependencies --level high --json` on stdin.
 *
 * Waivers exist because `yarn audit` reports advisories that have no fix to
 * apply: an upstream package with no patched release leaves the choice between
 * a permanently red gate — which trains everyone to ignore it, the worst
 * outcome for a security check — and a waiver that says out loud what is being
 * accepted and when it must be looked at again.
 *
 * A waiver is NOT "this doesn't matter". It is a dated claim, and this script
 * enforces both halves of it:
 *   - past `reviewBy`, the waiver stops working and the gate goes red;
 *   - a waiver that no longer matches anything also fails, so entries cannot
 *     quietly outlive the dependency that needed them.
 *
 * The gate also reconciles the two independent halves of yarn's output: the
 * summary counts it prints against the advisories it decides on. yarn emits one
 * `auditAdvisory` event per dependency path, so the blocking paths we parsed
 * must account for every critical/high path the summary reports. Coming up
 * short — whether by one path or by all of them — means the parser has gone
 * blind to part of the output, and that fails rather than reporting clean.
 *
 * A waiver's `module` is checked against the advisory it waives, so the claim
 * the security record makes about what is being accepted is the real one.
 *
 * The decision logic is exported so scripts/audit-high.selftest.js can prove
 * every one of those failure modes in CI. A gate nobody has watched fail is
 * indistinguishable from no gate.
 */
const WAIVERS = [
  {
    id: "GHSA-5p2g-fcmc-qvqq",
    module: "image-size",
    reviewBy: "2026-11-16",
    reason:
      "DoS parsing a malicious ICNS image. No patched release exists (vulnerable <=2.0.2, latest published 2.0.2). Reached only via ibex-client>api>datauri, the readme-generated SDK's file-upload helper: neither price service parses images — realtime calls GET /rates and the oauth token endpoint, history reads its own postgres — so no attacker-supplied bytes reach this parser. Re-check for a patched release, or for an ibex-client that no longer bundles the `api` SDK.",
  },
  {
    id: "GHSA-w3rx-r6r6-pgpr",
    module: "image-size",
    reviewBy: "2026-11-16",
    reason:
      "Same package and same reachability argument as GHSA-5p2g-fcmc-qvqq (JXL/HEIF parsers rather than ICNS). No patched release exists.",
  },
]

const BLOCKING_SEVERITIES = new Set(["critical", "high"])

/**
 * @param advisories deduped advisories, keyed by advisory id
 * @param summary yarn's auditSummary vulnerability counts (path counts)
 * @param waivers the waiver list to apply
 * @param today ISO date (YYYY-MM-DD) the waiver expiries are measured against
 */
const evaluate = ({ advisories, summary, waivers = WAIVERS, today }) => {
  const lines = []
  const failures = []

  if (!summary) {
    return { failures: ["Unable to find yarn audit summary"], waived: [], lines }
  }

  lines.push(
    `Production dependency audit: ${summary.critical || 0} critical, ` +
      `${summary.high || 0} high, ${summary.moderate || 0} moderate, ` +
      `${summary.low || 0} low (path counts)`,
  )

  const blocking = [...advisories.values()].filter((a) =>
    BLOCKING_SEVERITIES.has(a.severity),
  )
  const waiverById = new Map(waivers.map((w) => [w.id, w]))

  const expired = new Set(waivers.filter((w) => w.reviewBy < today).map((w) => w.id))
  for (const w of waivers) {
    // A waiver that is both expired and orphaned gets only the orphan message
    // below: "extend the review date" is the wrong instruction once the
    // advisory it covers is gone, and two contradictory failures for one
    // waiver is worse guidance than none.
    if (expired.has(w.id) && advisories.has(w.id)) {
      // The advisory is present in this branch, so name the module it is
      // actually against rather than the waiver's unverified claim about it.
      failures.push(
        `Waiver for ${w.id} (${advisories.get(w.id).module}) expired on ` +
          `${w.reviewBy}. Re-check the advisory: apply the fix if one now exists, ` +
          `or extend the waiver with a fresh review date and a reason that still ` +
          `holds.`,
      )
    }
  }

  for (const w of waivers) {
    if (!advisories.has(w.id)) {
      failures.push(
        `Waiver for ${w.id} (${w.module}) no longer matches any advisory — the ` +
          `dependency or the advisory is gone. Delete the waiver.`,
      )
    }
  }

  const mismatched = new Set()
  for (const a of blocking) {
    const w = waiverById.get(a.id)
    if (w) {
      // The waiver's `module` is the human-readable half of the claim — it is
      // what every message here and in the security record says is being
      // accepted. Copy a waiver, change the id and forget the module and that
      // claim becomes a lie, so verify it against the advisory rather than
      // trusting it.
      if (w.module !== a.module) {
        mismatched.add(a.id)
        failures.push(
          `Waiver ${w.id} claims module ${w.module} but the advisory is against ` +
            `${a.module} — fix the waiver.`,
        )
      }
      continue
    }
    failures.push(
      `${a.severity.toUpperCase()} ${a.module} (${a.id}): ${a.title}\n` +
        `    patched: ${a.patched}\n` +
        `    path:    ${[...a.paths][0]}`,
    )
  }

  // The counts we print and the advisories we gate on come from two different
  // yarn events. yarn emits one `auditAdvisory` per dependency path, so the
  // blocking paths we parsed must cover every critical/high path the summary
  // reports. Counting advisories instead of paths would only catch total
  // blindness: a parser that drops all but one advisory still leaves the rest
  // invisible to the gate, which is the same silent green in a smaller
  // package. Compared with `<` rather than `!==`: parsing more paths than the
  // summary reports is not the silent green this check exists for, and an
  // audit gate that cries wolf gets ignored, so an over-count never false-reds.
  const reportedBlocking = (summary.critical || 0) + (summary.high || 0)
  const parsedBlockingPaths = blocking.reduce((n, a) => n + a.paths.size, 0)
  if (parsedBlockingPaths < reportedBlocking) {
    failures.push(
      `yarn reported ${reportedBlocking} critical/high path(s) but only ` +
        `${parsedBlockingPaths} were parsed into advisories — the audit output ` +
        `format or the parser changed. Refusing to report this as clean.`,
    )
  }

  // A waiver only counts as waived once it has survived every check on it:
  // in date, and honest about the module it covers. Otherwise the report would
  // list an accepted risk on the same run that refuses to accept it.
  const waived = blocking.filter(
    (a) => waiverById.has(a.id) && !expired.has(a.id) && !mismatched.has(a.id),
  )
  if (waived.length > 0) {
    lines.push(`\nWaived (${waived.length}), each re-checked by its review date:`)
    for (const a of waived) {
      lines.push(
        `  - ${a.severity} ${a.module} ${a.id} — review by ${
          waiverById.get(a.id).reviewBy
        }`,
      )
    }
  }

  return { failures, waived, lines }
}

/** Collapse yarn's one-event-per-dependency-path stream into unique advisories. */
const collectAdvisory = (advisories, { advisory, resolution }) => {
  const id = advisory.github_advisory_id || String(advisory.id)
  const existing = advisories.get(id) || {
    id,
    module: advisory.module_name,
    severity: advisory.severity,
    title: advisory.title,
    patched: advisory.patched_versions,
    paths: new Set(),
  }
  existing.paths.add(resolution && resolution.path)
  advisories.set(id, existing)
  return advisories
}

const run = () => {
  const advisories = new Map()
  let summary
  let parseFailed = false

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

  rl.on("line", (line) => {
    if (!line.trim()) return
    try {
      const event = JSON.parse(line)
      if (event.type === "auditSummary") summary = event.data.vulnerabilities
      if (event.type === "auditAdvisory") collectAdvisory(advisories, event.data)
    } catch (error) {
      console.error(`Unable to parse yarn audit output: ${line}`)
      parseFailed = true
    }
  })

  rl.on("close", () => {
    const { failures, lines } = evaluate({
      advisories,
      summary,
      today: new Date().toISOString().slice(0, 10),
    })

    for (const l of lines) console.log(l)

    if (failures.length > 0) {
      console.error(`\n${failures.length} blocking finding(s):\n`)
      for (const f of failures) console.error(`  ${f}\n`)
      process.exit(1)
    }
    if (parseFailed) process.exit(1)

    console.log("\nNo unwaived critical/high advisories in production dependencies.")
  })
}

if (require.main === module) run()

module.exports = { evaluate, collectAdvisory, WAIVERS }
