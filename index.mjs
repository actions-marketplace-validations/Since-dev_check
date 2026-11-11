// Since.dev check: a GitHub Action with no dependencies. It sends each matched
// manifest (and any lockfile you list) to POST /v1/check, writes a summary
// table and file annotations, and fails the run on a proven finding at or
// above `fail-on`. A pull request from a fork gets no secrets, so without a
// key the run skips with a notice instead of failing. An API outage never
// blocks a pull request: the run says so and passes.
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const SEVERITIES = ["low", "medium", "high", "critical"]
const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock",
  "poetry.lock", "Pipfile.lock", "uv.lock", "Cargo.lock", "Gemfile.lock", "composer.lock",
  "packages.lock.json", "gradle.lockfile",
])
const SKIP = new Set([".git", "node_modules", "vendor", "dist", "build", ".venv", "venv", "target", ".next", "__pycache__"])
const MAX_CHARACTERS = 500_000
const MAX_ANNOTATIONS = 20
const MAX_ROWS = 100

/** A finding's reason as one sentence, with what to move to unless it already says so. */
export function sentence(finding) {
  const reason = String(finding.reason ?? "").trim().replace(/\.?$/, ".")
  const replacement = finding.replacement
  return replacement && !reason.toLowerCase().includes(`move to ${String(replacement).toLowerCase()}`)
    ? `${reason} Move to ${replacement}.`
    : reason
}

export function input(name, fallback = "") {
  const value = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`]
  return value === undefined || value.trim() === "" ? fallback : value.trim()
}

const log = (line) => process.stdout.write(`${line}\n`)
const escapeData = (value) => String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
const escapeProperty = (value) => escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C")

function annotate(level, message, where = {}) {
  const properties = [
    where.file ? `file=${escapeProperty(where.file)}` : null,
    where.line ? `line=${where.line}` : null,
    where.title ? `title=${escapeProperty(where.title)}` : null,
  ].filter(Boolean)
  log(`::${level}${properties.length ? ` ${properties.join(",")}` : ""}::${escapeData(message)}`)
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  else log(markdown)
}

/** A pattern as a regular expression over a path relative to the root: `**\/` is any folders, `*` any characters in a name. */
export function patternRegExp(pattern) {
  const source = pattern
    .replace(/^\.\//, "")
    .split(/(\*\*\/|\*)/)
    .map((part) => (part === "**/" ? "(?:.*/)?" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("")
  return new RegExp(`^${source}$`)
}

/** The files under `root` that match a pattern, in path order. */
export function matchFiles(root, patterns) {
  const tests = patterns.map(patternRegExp)
  const found = []
  const walk = (dir) => {
    for (const name of readdirSync(path.join(root, dir)).sort()) {
      const relative = dir ? `${dir}/${name}` : name
      let stat
      try {
        stat = statSync(path.join(root, relative))
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (!SKIP.has(name)) walk(relative)
      } else if (tests.some((test) => test.test(relative))) found.push(relative)
    }
  }
  walk("")
  return found
}

/** The check body for one file: a lockfile as `lockfile`, anything else as `manifest`. */
export function checkBody(file, content) {
  const field = LOCKFILES.has(path.posix.basename(file)) ? "lockfile" : "manifest"
  return { [field]: { path: file, content }, detail: "summary" }
}

/** Whether a finding fails the run: proven, and at or above the threshold. */
export function fails(finding, failOn) {
  const threshold = SEVERITIES.indexOf(failOn)
  if (threshold < 0) return false
  return finding.state !== "needs_review" && SEVERITIES.indexOf(finding.severity) >= threshold
}

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")

function when(finding) {
  if (finding.daysLeft === null || finding.daysLeft === undefined) return ""
  if (finding.daysLeft < 0) return `${-finding.daysLeft} days ago`
  return finding.daysLeft === 0 ? "today" : `in ${finding.daysLeft} days`
}

export async function run({ root = process.env.GITHUB_WORKSPACE || process.cwd(), fetchImpl = fetch } = {}) {
  const key = input("api-key")
  if (!key) {
    annotate("notice", "No Since.dev API key, so nothing was checked. Pull requests from forks get no secrets; add SINCE_DEV_KEY to the repository's secrets for the rest.")
    output("findings", 0)
    output("failing", 0)
    return 0
  }
  const api = input("api-url", "https://api.since.dev").replace(/\/+$/, "")
  const failOn = input("fail-on", "high").toLowerCase()
  const maxFiles = Math.max(1, Number.parseInt(input("max-files", "10"), 10) || 10)
  const patterns = input("files").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const matched = matchFiles(root, patterns)
  const files = matched.slice(0, maxFiles)
  if (matched.length > files.length)
    annotate("warning", `${matched.length} files matched; checked the first ${files.length}. Raise max-files to check more (each file costs credits).`)
  if (files.length === 0) {
    annotate("notice", "No file matched, so nothing was checked.")
    output("findings", 0)
    output("failing", 0)
    return 0
  }

  const rows = []
  const notes = []
  let annotations = 0
  for (const file of files) {
    // go.sum is checksums, not the versions a build uses: go.mod says those, and checking go.sum would only spend credits.
    if (path.posix.basename(file) === "go.sum") {
      notes.push(`${file}: not checked. go.mod holds the versions; go.sum is only checksums.`)
      continue
    }
    const content = readFileSync(path.join(root, file), "utf8")
    if (content.length > MAX_CHARACTERS) {
      notes.push(`${file}: over ${MAX_CHARACTERS.toLocaleString("en-US")} characters, not checked.`)
      continue
    }
    let response
    try {
      response = await fetchImpl(`${api}/v1/check`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "since-dev-check-action" },
        body: JSON.stringify(checkBody(file, content)),
        signal: AbortSignal.timeout(120_000),
      })
    } catch (error) {
      notes.push(`${file}: the API could not be reached (${error?.name ?? "error"}), so it was not checked.`)
      continue
    }
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      const message = body?.message ?? `HTTP ${response.status}`
      if (response.status === 401 || response.status === 402) {
        annotate("warning", `Since.dev: ${message}`)
        notes.push(message)
        break
      }
      notes.push(`${file}: ${message}`)
      continue
    }
    // An answer still being read is not the whole answer: say so, so a clean run is not read as a clean bill.
    if (body?.reading) {
      const releases = Number(body.reading.releases) || 0
      notes.push(`${file}: Since is still reading ${releases ? `${releases.toLocaleString("en-US")} newer release${releases === 1 ? "" : "s"}` : "newer releases"} of its dependencies. A later run includes what they changed.`)
    }
    for (const finding of body?.findings ?? []) {
      const where = finding.where?.find((place) => place.file) ?? { file, line: null }
      const failing = fails(finding, failOn)
      rows.push({ finding, where, failing })
      if (annotations < MAX_ANNOTATIONS) {
        annotations++
        const subject = [finding.surface?.name, finding.version].filter(Boolean).join(" ")
        annotate(failing ? "error" : "warning", sentence(finding), {
          file: where.file,
          line: where.line,
          title: `${finding.severity}: ${subject}`,
        })
      }
    }
  }

  const failing = rows.filter((row) => row.failing).length
  summary("## Since.dev check")
  summary("")
  summary(rows.length === 0
    ? `No findings in ${files.length === 1 ? "the 1 file" : `the ${files.length} files`} checked.`
    : `${rows.length} finding${rows.length === 1 ? "" : "s"} in ${files.length} file${files.length === 1 ? "" : "s"}${failOn === "none" ? "." : `, ${failing} at ${failOn} or above and proven.`}`)
  if (rows.length > 0) {
    summary("")
    summary("| Severity | What | Where | When | Move to |")
    summary("| --- | --- | --- | --- | --- |")
    // Failing first, then by severity, proven before not settled.
    const order = (row) =>
      (row.failing ? 0 : 10) - SEVERITIES.indexOf(row.finding.severity) + (row.finding.state === "needs_review" ? 0.5 : 0)
    const sorted = [...rows].sort((a, b) => order(a) - order(b))
    for (const { finding, where } of sorted.slice(0, MAX_ROWS)) {
      const subject = [finding.surface?.name, finding.version].filter(Boolean).join(" ")
      const place = where.line ? `${where.file}:${where.line}` : where.file
      const state = finding.state === "needs_review" ? " (not settled)" : ""
      summary(`| ${cell(finding.severity)}${state} | ${cell(subject)}: ${cell(finding.reason)} | \`${cell(place)}\` | ${cell(when(finding))} | ${cell(finding.replacement)} |`)
    }
    if (sorted.length > MAX_ROWS) summary(`\nAnd ${sorted.length - MAX_ROWS} more, less severe.`)
  }
  if (notes.length > 0) {
    summary("")
    for (const note of notes) summary(`- ${cell(note)}`)
  }
  output("findings", rows.length)
  output("failing", failing)
  if (failing > 0) {
    annotate("error", `${failing} proven finding${failing === 1 ? "" : "s"} at ${failOn} or above.`)
    return 1
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(
    (code) => process.exit(code),
    (error) => {
      annotate("error", `Since.dev check could not run: ${error?.message ?? error}`)
      process.exit(1)
    },
  )
}
