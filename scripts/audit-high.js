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
 * @param advisories advisories deduped by (advisory id, module) — see advisoryKey
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
  // Waivers are matched on (advisory id, module) — the same identity
  // collectAdvisory keys on — so a waiver can only ever accept the exact
  // package it names. A waiver whose module is wrong simply matches nothing,
  // and is reported below as an orphan rather than quietly covering whichever
  // package yarn emitted first.
  const waiverByKey = new Map(waivers.map((w) => [advisoryKey(w.id, w.module), w]))
  const expiredKeys = new Set(
    waivers.filter((w) => w.reviewBy < today).map((w) => advisoryKey(w.id, w.module)),
  )

  for (const w of waivers) {
    const key = advisoryKey(w.id, w.module)
    // A waiver that is both expired and orphaned gets only the orphan message
    // below: "extend the review date" is the wrong instruction once the
    // advisory it covers is gone, and two contradictory failures for one
    // waiver is worse guidance than none.
    if (expiredKeys.has(key) && advisories.has(key)) {
      failures.push(
        `Waiver for ${w.id} (${w.module}) expired on ${w.reviewBy}. Re-check the ` +
          `advisory: apply the fix if one now exists, or extend the waiver with a ` +
          `fresh review date and a reason that still holds.`,
      )
    }
  }

  for (const w of waivers) {
    if (advisories.has(advisoryKey(w.id, w.module))) continue
    // Name the likelier mistake when the id is real but the module is not:
    // otherwise "no longer matches any advisory" sends someone hunting for a
    // dependency that is still very much present.
    const sameId = [...advisories.values()].filter((a) => a.id === w.id)
    if (sameId.length > 0) {
      failures.push(
        `Waiver for ${w.id} claims module ${w.module}, but that advisory is ` +
          `against ${sameId.map((a) => a.module).join(", ")} — fix the waiver's ` +
          `module. A waiver only covers the package it names.`,
      )
      continue
    }
    failures.push(
      `Waiver for ${w.id} (${w.module}) no longer matches any advisory — the ` +
        `dependency or the advisory is gone. Delete the waiver.`,
    )
  }

  for (const a of blocking) {
    if (waiverByKey.has(advisoryKey(a.id, a.module))) continue
    const paths = [...a.paths]
    // Every path, not just the first: one advisory can be reached by many
    // dependency edges, and reporting one leaves the reader thinking a single
    // edge needs fixing.
    const shown = paths.slice(0, 3)
    const more = paths.length - shown.length
    failures.push(
      `${a.severity.toUpperCase()} ${a.module} (${a.id}): ${a.title}\n` +
        `    patched: ${a.patched}\n` +
        `    ${paths.length} path(s):\n` +
        shown.map((p) => `      ${p}`).join("\n") +
        (more > 0 ? `\n      ... and ${more} more` : ""),
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
  const waived = blocking.filter((a) => {
    const key = advisoryKey(a.id, a.module)
    return waiverByKey.has(key) && !expiredKeys.has(key)
  })
  if (waived.length > 0) {
    lines.push(`\nWaived (${waived.length}), each re-checked by its review date:`)
    for (const a of waived) {
      lines.push(
        `  - ${a.severity} ${a.module} ${a.id} — review by ${
          waiverByKey.get(advisoryKey(a.id, a.module)).reviewBy
        }`,
      )
    }
  }

  return { failures, waived, lines }
}

/**
 * Advisory ids are NOT unique per package: one upstream fix can be published
 * against several packages, and yarn then emits the same id under different
 * `module_name`s. Verified in this repo — GHSA-968p-4wvh-cqc8 arrives for both
 * `@babel/helpers` and `@babel/runtime`. Keying on the id alone collapses them
 * into one entry whose `module` is whichever path yarn happened to emit first,
 * which makes a waiver order-dependent and lets one package's waiver silently
 * accept another package's advisory. The package is part of the identity.
 */
// U+0000 as the separator: it cannot occur in a package name or an
// advisory id, so no pair of values can collide on the joined key.
const advisoryKey = (id, module) => `${id}\u0000${module}`

/** Collapse yarn's one-event-per-dependency-path stream into unique advisories. */
const collectAdvisory = (advisories, { advisory, resolution }) => {
  const id = advisory.github_advisory_id || String(advisory.id)
  const key = advisoryKey(id, advisory.module_name)
  const existing = advisories.get(key) || {
    id,
    module: advisory.module_name,
    severity: advisory.severity,
    title: advisory.title,
    patched: advisory.patched_versions,
    paths: new Set(),
  }
  existing.paths.add(resolution && resolution.path)
  advisories.set(key, existing)
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
