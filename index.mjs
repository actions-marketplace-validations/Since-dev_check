// Since.dev check: a GitHub Action with no dependencies. It sends the matched
// manifests, each with the lockfiles beside it, together as sets of files to
// POST /v1/check (50 files at a time), writes a summary
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
/** The manifest a lockfile resolves, in its own folder: what says which of its packages the project declares itself. */
const MANIFESTS_OF = {
  "package-lock.json": ["package.json"], "npm-shrinkwrap.json": ["package.json"], "pnpm-lock.yaml": ["package.json"], "yarn.lock": ["package.json"],
  "bun.lock": ["package.json"], "poetry.lock": ["pyproject.toml"], "uv.lock": ["pyproject.toml"], "Pipfile.lock": ["Pipfile"], "Cargo.lock": ["Cargo.toml"],
  "Gemfile.lock": ["Gemfile"], "composer.lock": ["composer.json"], "gradle.lockfile": ["build.gradle", "build.gradle.kts"],
}
const SKIP = new Set([".git", "node_modules", "vendor", "dist", "build", ".venv", "venv", "target", ".next", "__pycache__"])
const MAX_CHARACTERS = 500_000
/** The most files one set holds: the API's own limit on `files`. */
const MAX_SET_FILES = 50
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

/** What to move to, and the exact line to write or the command to run when Since read one back and checked it. */
function moveTo(finding) {
  const edit = finding.edit
  if (edit && typeof edit.command === "string" && edit.command) return `${cell(finding.replacement)}: run \`${cell(edit.command)}\``
  if (edit && typeof edit.to === "string" && edit.to.trim()) return `${cell(finding.replacement)}: write \`${cell(edit.to.trim())}\` at line ${cell(edit.line)}`
  return cell(finding.replacement)
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

/**
 * What a run sends, in order: each matched file, followed by the lockfiles in its own folder, so the versions read are the installed
 * ones. Each file once.
 */
export function withLockfiles(root, files) {
  const out = []
  const seen = new Set()
  const add = (file) => {
    if (!seen.has(file)) {
      seen.add(file)
      out.push(file)
    }
  }
  for (const file of files) {
    add(file)
    const folder = path.posix.dirname(file)
    let names = []
    try {
      names = readdirSync(path.join(root, folder), { withFileTypes: true }).filter((entry) => entry.isFile() && LOCKFILES.has(entry.name)).map((entry) => entry.name).sort()
    } catch {}
    for (const name of names) add(folder === "." ? name : `${folder}/${name}`)
  }
  return out
}

/** The files in sets the API takes, in order: up to 50 files and 500,000 characters each; a file that would overflow a set starts the next. */
export function fileSets(files) {
  const sets = []
  let current = []
  let size = 0
  for (const file of files) {
    if (current.length && (current.length >= MAX_SET_FILES || size + file.content.length > MAX_CHARACTERS)) {
      sets.push(current)
      current = []
      size = 0
    }
    current.push(file)
    size += file.content.length
  }
  if (current.length) sets.push(current)
  return sets
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

const MANIFEST_NAME = /^(?:package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.csproj)$/
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|cs|php|rs|swift|scala|ex|exs|dart)$/i

/**
 * The manifests beside a pull request's changed lockfiles that it leaves as they are (`poetry.lock` changed, `pyproject.toml` not): the same
 * at the base and the head, and what tells a package the project declares from one only the lockfile holds.
 */
export function manifestsBeside(root, changed) {
  const paths = new Set(changed)
  const out = []
  for (const file of changed) {
    const folder = path.posix.dirname(file)
    for (const name of MANIFESTS_OF[path.posix.basename(file)] ?? []) {
      const manifest = folder === "." ? name : `${folder}/${name}`
      if (paths.has(manifest) || out.some((other) => other.path === manifest)) continue
      try {
        out.push({ path: manifest, content: readFileSync(path.join(root, manifest), "utf8") })
      } catch {}
    }
  }
  return out
}

/** Whether a path is a manifest or a lockfile, by its name. */
export const dependencyFile = (file) => MANIFEST_NAME.test(path.posix.basename(file)) || LOCKFILES.has(path.posix.basename(file))

/** The code files under root that import a package (a quoted module name, or Python's import), nearest the top first, up to `limit`. */
export function importingFiles(root, name, ecosystem, limit = MAX_SET_FILES) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = ecosystem === "pypi"
    ? new RegExp(`^\\s*(?:import|from)\\s+${escape(name.toLowerCase().replace(/[-.]+/g, "_"))}\\b`, "im")
    : new RegExp(`["'\`]${escape(name)}(?:/[^"'\`]*)?["'\`]`)
  const found = []
  let seen = 0
  const walk = (folder) => {
    for (const entry of readdirSync(path.join(root, folder), { withFileTypes: true })) {
      if (++seen > 20_000 || found.length >= limit) return
      const relative = folder ? `${folder}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) walk(relative)
      } else if (entry.isFile() && CODE_FILE.test(entry.name)) {
        const content = readFileSync(path.join(root, relative), "utf8")
        if (content.length <= MAX_CHARACTERS && pattern.test(content)) found.push({ path: relative, content })
      }
    }
  }
  walk("")
  return found.sort((a, b) => a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * The upgrade receipt on a pull request that changes only manifests and lockfiles (Features plan step 33): the files as the base has them
 * (read through GitHub's API) and as the pull request leaves them (the checkout) go to POST /v1/check with `upgrade`, then again with the
 * code files that import each moved package, and each move's receipt goes in the summary. Null when the run is not such a pull request.
 */
export async function upgradeReceipts({ root, api, key, fetchImpl, block }) {
  if (!["pull_request", "pull_request_target"].includes(process.env.GITHUB_EVENT_NAME ?? "") || !process.env.GITHUB_EVENT_PATH) return null
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
  const pull = event.pull_request
  const repository = process.env.GITHUB_REPOSITORY
  const token = input("github-token")
  if (!pull?.number || !pull.base?.sha || !repository || !token) return null
  const github = async (route) => {
    const response = await fetchImpl(`${(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "")}/repos/${repository}${route}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "since-dev-check-action" }, signal: AbortSignal.timeout(30_000) })
    return response.ok ? response.json() : null
  }
  const changed = await github(`/pulls/${pull.number}/files?per_page=100`)
  if (!Array.isArray(changed) || !changed.length || changed.length > MAX_SET_FILES || changed.some((file) => file.status === "removed" || !dependencyFile(file.filename))) return null
  const base = []
  const head = []
  for (const file of changed) {
    const now = path.join(root, file.filename)
    try {
      head.push({ path: file.filename, content: readFileSync(now, "utf8") })
    } catch {}
    const at = await github(`/contents/${file.filename.split("/").map(encodeURIComponent).join("/")}?ref=${pull.base.sha}`)
    let content = at && typeof at.content === "string" && at.encoding === "base64" && at.content ? Buffer.from(at.content, "base64").toString("utf8") : null
    if (at && content === null && typeof at.sha === "string") {
      const blob = await github(`/git/blobs/${at.sha}`)
      content = blob && typeof blob.content === "string" ? Buffer.from(blob.content, "base64").toString("utf8") : null
    }
    if (content !== null) base.push({ path: file.filename, content })
  }
  if (!base.length || !head.length) return null
  // A manifest the pull request leaves as it is reads the same at both ends: without it, every package of a lockfile that does not say what
  // the project declares (poetry.lock, Cargo.lock) would read as an indirect dependency, checked against its dependents' calls, not the code's.
  for (const manifest of manifestsBeside(root, changed.map((file) => file.filename))) {
    base.push(manifest)
    head.push(manifest)
  }
  const ask = async (files) => {
    const response = await fetchImpl(`${api}/v1/check`, { method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "since-dev-check-action" },
      body: JSON.stringify({ files, upgrade: head, detail: "summary" }), signal: AbortSignal.timeout(120_000) })
    const body = await response.json().catch(() => null)
    return response.ok && Array.isArray(body?.receipts) ? body.receipts : null
  }
  const first = await ask(base)
  if (!first) return { receipts: [], failed: true }
  if (!first.length) return { receipts: [] }
  // The code that calls each moved package, so what the move breaks in it is read: the receipt never clears a move no code was read for.
  const files = [...base]
  for (const receipt of first) {
    for (const file of importingFiles(root, receipt.package?.name ?? "", receipt.package?.ecosystem)) {
      if (files.length < MAX_SET_FILES && !files.some((other) => other.path === file.path)) files.push(file)
    }
  }
  const receipts = files.length > base.length ? (await ask(files)) ?? first : first
  const notClear = receipts.filter((receipt) => receipt.verdict === "not_clear")
  return { receipts, notClear: notClear.length, blocks: block && notClear.length > 0 }
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
  const maxFiles = Math.max(1, Number.parseInt(input("max-files", "50"), 10) || 50)
  const patterns = input("files").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const matched = withLockfiles(root, matchFiles(root, patterns))
  const files = matched.slice(0, maxFiles)
  if (matched.length > files.length)
    annotate("warning", `${matched.length} files matched; checked the first ${files.length}. Raise max-files to check more.`)
  if (files.length === 0) {
    annotate("notice", "No file matched, so nothing was checked.")
    output("findings", 0)
    output("failing", 0)
    return 0
  }

  const rows = []
  const notes = []
  let annotations = 0
  let asOf = null
  const entries = []
  for (const file of files) {
    // go.sum is checksums, not the versions a build uses: go.mod says those, and checking go.sum would only spend credits.
    if (path.posix.basename(file) === "go.sum") {
      notes.push(`${file}: not checked. go.mod holds the versions; go.sum is only checksums.`)
      continue
    }
    const content = readFileSync(path.join(root, file), "utf8")
    if (content.length > MAX_CHARACTERS) {
      notes.push(`${file}: over ${MAX_CHARACTERS.toLocaleString("en-US")} characters, not checked${LOCKFILES.has(path.posix.basename(file)) ? "; its manifest was read as a fresh install would land" : ""}.`)
      continue
    }
    entries.push({ path: file, content })
  }
  let sent = 0
  for (const set of fileSets(entries)) {
    const names = set.map((file) => file.path).join(", ")
    let response
    try {
      response = await fetchImpl(`${api}/v1/check`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "since-dev-check-action" },
        body: JSON.stringify({ files: set, detail: "summary" }),
        signal: AbortSignal.timeout(120_000),
      })
    } catch (error) {
      notes.push(`${names}: the API could not be reached (${error?.name ?? "error"}), so ${set.length === 1 ? "it was" : "they were"} not checked.`)
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
      notes.push(`${names}: ${message}`)
      continue
    }
    sent += set.length
    // An answer still being read is not the whole answer: say so, so a clean run is not read as a clean bill.
    if (body?.reading) {
      const releases = Number(body.reading.releases) || 0
      notes.push(`Since is still reading ${releases ? `${releases.toLocaleString("en-US")} newer release${releases === 1 ? "" : "s"}` : "newer releases"} of the dependencies. A later run includes what they changed.`)
    }
    // What the sources behind the answer had been read up to: the run is current as of the oldest of them.
    if (typeof body?.coverage?.asOf === "string" && (asOf === null || body.coverage.asOf < asOf)) asOf = body.coverage.asOf
    for (const finding of body?.findings ?? []) {
      const where = finding.where?.find((place) => place.file) ?? { file: set[0].path, line: null }
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

  // An upgrade-only pull request also gets each move's receipt: clear, not clear (the release and the line) or not settled.
  const upgrade = await upgradeReceipts({ root, api, key, fetchImpl, block: input("block-upgrades", "false").toLowerCase() === "true" }).catch(() => null)
  if (upgrade?.receipts?.length) {
    summary("## Upgrade receipt")
    summary("")
    for (const receipt of upgrade.receipts) {
      summary(`- **${cell(receipt.package?.name)} ${cell(receipt.from ?? "?")} to ${cell(receipt.to)}:** ${cell(receipt.sentence)}`)
      const place = (receipt.reaching ?? []).find((entry) => entry.state !== "needs_review")?.where?.find((where) => where.file)
      if (receipt.verdict === "not_clear") annotate(upgrade.blocks ? "error" : "warning", receipt.sentence, place ? { file: place.file, line: place.line, title: `Upgrade receipt: ${receipt.package?.name}` } : {})
    }
    summary("")
    summary("Clear means every release of the move was read in full and nothing in them reaches the code: nothing found in what was read.")
    summary("")
  } else if (upgrade?.failed) notes.push("The upgrade receipt could not be read: Since did not answer.")
  output("receipts", upgrade?.receipts?.length ?? 0)
  output("not-clear", upgrade?.notClear ?? 0)

  const failing = rows.filter((row) => row.failing).length
  summary("## Since.dev check")
  summary("")
  summary(rows.length === 0
    ? `No findings in ${sent === 1 ? "the 1 file" : `the ${sent} files`} checked.`
    : `${rows.length} finding${rows.length === 1 ? "" : "s"} in ${sent} file${sent === 1 ? "" : "s"}${failOn === "none" ? "." : `, ${failing} at ${failOn} or above and proven.`}`)
  if (asOf) summary(`\nCurrent as of ${asOf.replace("T", " ").replace(/:\d{2}(\.\d+)?Z$/, " UTC")}.`)
  output("as-of", asOf ?? "")
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
      summary(`| ${cell(finding.severity)}${state} | ${cell(subject)}: ${cell(finding.reason)} | \`${cell(place)}\` | ${cell(when(finding))} | ${moveTo(finding)} |`)
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
  // A not clear move fails the run only where the repository asked it to (block-upgrades); otherwise it warns.
  if (upgrade?.blocks) {
    annotate("error", `${upgrade.notClear} move${upgrade.notClear === 1 ? "" : "s"} of this pull request ${upgrade.notClear === 1 ? "is" : "are"} not clear.`)
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
