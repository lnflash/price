const readline = require("node:readline")

let summary

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

rl.on("line", (line) => {
  if (!line.trim()) return

  try {
    const event = JSON.parse(line)
    if (event.type === "auditSummary") {
      summary = event.data.vulnerabilities
    }
  } catch (error) {
    console.error(`Unable to parse yarn audit output: ${line}`)
    process.exitCode = 1
  }
})

rl.on("close", () => {
  if (!summary) {
    console.error("Unable to find yarn audit summary")
    process.exit(1)
  }

  const critical = summary.critical || 0
  const high = summary.high || 0

  console.log(
    `Production dependency audit: ${critical} critical, ${high} high, ` +
      `${summary.moderate || 0} moderate, ${summary.low || 0} low`,
  )

  if (critical > 0 || high > 0) {
    process.exit(1)
  }
})
