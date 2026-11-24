// node --test distribution/action/test.mjs
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { checkBody, fails, manifestsBeside, matchFiles, patternRegExp, run, sentence } from "./index.mjs"

const DEFAULT_FILES = readFileSync(new URL("./action.yml", import.meta.url), "utf8")
  .split("default: |")[1]
  .split("  max-files:")[0]

function repo(files) {
  const root = mkdtempSync(path.join(tmpdir(), "since-action-"))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }
  return root
}

function withInputs(inputs, body) {
  const saved = { ...process.env }
  const out = mkdtempSync(path.join(tmpdir(), "since-action-out-"))
  process.env.GITHUB_OUTPUT = path.join(out, "output")
  process.env.GITHUB_STEP_SUMMARY = path.join(out, "summary")
  writeFileSync(process.env.GITHUB_OUTPUT, "")
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, "")
  for (const [name, value] of Object.entries(inputs)) process.env[`INPUT_${name.toUpperCase()}`] = value
  const lines = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => (lines.push(String(chunk)), true)
  return body().finally(() => {
    process.stdout.write = write
    process.env = saved
  }).then((code) => ({
    code,
    log: lines.join(""),
    output: readFileSync(path.join(out, "output"), "utf8"),
    summary: readFileSync(path.join(out, "summary"), "utf8"),
  }))
}

test("patterns match any folder with **/ and one name with *", () => {
  assert.ok(patternRegExp("**/package.json").test("package.json"))
  assert.ok(patternRegExp("**/package.json").test("apps/web/package.json"))
  assert.ok(!patternRegExp("**/package.json").test("apps/web/package.json.bak"))
  assert.ok(patternRegExp(".github/workflows/*.yml").test(".github/workflows/ci.yml"))
  assert.ok(!patternRegExp(".github/workflows/*.yml").test(".github/workflows/sub/ci.yml"))
  assert.ok(patternRegExp("**/*.csproj").test("src/Api/Api.csproj"))
})

test("the default patterns find manifests, never node_modules or a workflow", () => {
  const root = repo({
    "package.json": "{}",
    "apps/api/pyproject.toml": "",
    "node_modules/x/package.json": "{}",
    ".github/workflows/ci.yml": "",
    "package-lock.json": "{}",
    "README.md": "",
  })
  const patterns = DEFAULT_FILES.split("\n").map((line) => line.trim()).filter(Boolean)
  assert.deepEqual(matchFiles(root, patterns), ["apps/api/pyproject.toml", "package.json"])
})

test("a lockfile goes as lockfile, anything else as manifest, both in summary", () => {
  assert.deepEqual(checkBody("web/package-lock.json", "{}"), { lockfile: { path: "web/package-lock.json", content: "{}" }, detail: "summary" })
  assert.deepEqual(checkBody("go.mod", "module x"), { manifest: { path: "go.mod", content: "module x" }, detail: "summary" })
})

test("a reason reads as one sentence, naming the replacement once", () => {
  assert.equal(sentence({ reason: ".NET 6: end of life 2024-11-12; move to 10", replacement: "10" }), ".NET 6: end of life 2024-11-12; move to 10.")
  assert.equal(sentence({ reason: "openai 3.3.0 calls a removed endpoint.", replacement: "4.0.0" }), "openai 3.3.0 calls a removed endpoint. Move to 4.0.0.")
  assert.equal(sentence({ reason: "Deprecated", replacement: null }), "Deprecated.")
})

test("only a proven finding at or above the threshold fails", () => {
  assert.equal(fails({ state: "affected", severity: "high" }, "high"), true)
  assert.equal(fails({ state: "affected", severity: "critical" }, "high"), true)
  assert.equal(fails({ state: "affected", severity: "medium" }, "high"), false)
  assert.equal(fails({ state: "needs_review", severity: "critical" }, "high"), false)
  assert.equal(fails({ state: "affected", severity: "critical" }, "none"), false)
})

const FINDING = {
  surface: { name: "openai", kind: "package" }, version: "3.3.0", state: "affected", severity: "high",
  reason: "openai 3.3.0 calls an endpoint OpenAI removed.", replacement: "4.0.0", daysLeft: -10,
  where: [{ file: "src/llm.ts", line: 14 }],
}

test("a run checks the files together, annotates findings, writes the summary and fails on a proven high", async () => {
  const root = repo({ "package.json": '{"dependencies":{"openai":"3.3.0"}}', "go.mod": "module x" })
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const findings = init.body.includes("openai") ? [FINDING, { ...FINDING, state: "needs_review", severity: "critical" }] : []
    return Response.json({ findings })
  }
  const result = await withInputs({ "api-key": "sc_test", files: "**/package.json\n**/go.mod", "fail-on": "high" }, () => run({ root, fetchImpl }))
  assert.equal(result.code, 1)
  // One set of files: both are read together, so an import is checked at the version the same files pin.
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].body.files.map((file) => file.path), ["go.mod", "package.json"])
  assert.equal(calls[0].url, "https://api.since.dev/v1/check")
  assert.equal(calls[0].init.headers.Authorization, "Bearer sc_test")
  assert.match(result.log, /::error file=src\/llm.ts,line=14,title=high%3A openai 3.3.0::openai 3.3.0 calls an endpoint OpenAI removed. Move to 4.0.0./)
  assert.match(result.log, /::warning file=src\/llm.ts,line=14,title=critical%3A openai 3.3.0::/)
  assert.match(result.summary, /2 findings in 2 files, 1 at high or above and proven\./)
  assert.match(result.summary, /\| critical \(not settled\) \|/)
  assert.ok(result.summary.indexOf("| high |") < result.summary.indexOf("| critical (not settled) |"), "the failing finding comes first")
  assert.match(result.summary, /`src\/llm.ts:14` \| 10 days ago \| 4.0.0 \|/)
  assert.match(result.output, /findings=2\nfailing=1/)
})

test("go.sum is never sent, and an answer still being read says so", async () => {
  const root = repo({ "go.mod": "module x", "go.sum": "example.com/a v1.0.0 h1:abc=" })
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body))
    return Response.json({ findings: [], reading: { retryAfterSec: 60, releases: 12 } })
  }
  const result = await withInputs({ "api-key": "sc_test", files: "**/go.mod\n**/go.sum" }, () => run({ root, fetchImpl }))
  assert.equal(result.code, 0)
  // One call, for go.mod: the checksums file spends nothing.
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].files.map((file) => file.path), ["go.mod"])
  assert.match(result.summary, /go\.sum: not checked\. go\.mod holds the versions; go\.sum is only checksums\./)
  assert.match(result.summary, /Since is still reading 12 newer releases of the dependencies\. A later run includes what they changed\./)
})

test("sends each manifest with the lockfiles beside it, and leaves out a lockfile over the size, naming it", async () => {
  const root = repo({ "web/package.json": '{"dependencies":{"lodash":"^4.17.0"}}', "web/package-lock.json": "{}", "api/package.json": "{}", "api/yarn.lock": "x".repeat(500_001) })
  const calls = []
  const result = await withInputs({ "api-key": "k", files: "**/package.json" }, () =>
    run({ root, fetchImpl: async (_url, init) => (calls.push(JSON.parse(init.body)), Response.json({ findings: [] })) }))
  assert.equal(result.code, 0)
  assert.deepEqual(calls[0].files.map((file) => file.path), ["api/package.json", "web/package.json", "web/package-lock.json"])
  assert.match(result.summary, /api\/yarn\.lock: over 500,000 characters, not checked; its manifest was read as a fresh install would land\./)
  assert.match(result.summary, /No findings in the 3 files checked\./)
})

test("no key: a notice and a pass, the way a fork's pull request runs", async () => {
  const result = await withInputs({ files: "**/package.json" }, () => run({ root: repo({ "package.json": "{}" }), fetchImpl: () => assert.fail("no call") }))
  assert.equal(result.code, 0)
  assert.match(result.log, /::notice::No Since.dev API key/)
})

test("out of credits stops the run with a warning and passes; an unreachable API passes too", async () => {
  const root = repo({ "a/package.json": "{}", "b/package.json": "{}" })
  let calls = 0
  const broke = await withInputs({ "api-key": "k", files: "**/package.json" }, () =>
    run({ root, fetchImpl: async () => (calls++, Response.json({ error: "credits_exhausted", message: "The workspace has no credits left." }, { status: 402 })) }))
  assert.equal(broke.code, 0)
  assert.equal(calls, 1)
  assert.match(broke.log, /::warning::Since.dev: The workspace has no credits left./)
  const down = await withInputs({ "api-key": "k", files: "**/package.json" }, () =>
    run({ root, fetchImpl: async () => { throw new TypeError("fetch failed") } }))
  assert.equal(down.code, 0)
  assert.match(down.summary, /could not be reached/)
})

test("max-files caps what one run checks, and says so", async () => {
  const root = repo({ "a/package.json": "{}", "b/package.json": "{}", "c/package.json": "{}" })
  let calls = 0
  const result = await withInputs({ "api-key": "k", files: "**/package.json", "max-files": "2" }, () =>
    run({ root, fetchImpl: async () => (calls++, Response.json({ findings: [] })) }))
  assert.equal(calls, 1)
  assert.equal(result.code, 0)
  assert.match(result.log, /3 files matched; checked the first 2/)
  assert.match(result.summary, /No findings in the 2 files checked\./)
})

test("sends 50 files a set, and says what the run is current as of: the oldest of the answers' sources", async () => {
  // 51 manifests: two sets, 50 and 1.
  const root = repo(Object.fromEntries(Array.from({ length: 51 }, (_, at) => [`p${String(at).padStart(2, "0")}/package.json`, "{}"])))
  const asOf = ["2026-11-21T09:10:00.000Z", "2026-11-21T08:58:42.000Z"]
  let at = 0
  const sizes = []
  const result = await withInputs({ "api-key": "k", files: "**/package.json", "max-files": "60" }, () =>
    run({ root, fetchImpl: async (_url, init) => (sizes.push(JSON.parse(init.body).files.length), Response.json({ findings: [], coverage: { sources: [], missing: [], asOf: asOf[at++] } })) }))
  assert.equal(result.code, 0)
  assert.deepEqual(sizes, [50, 1])
  assert.match(result.summary, /Current as of 2026-11-21 08:58 UTC\./)
  assert.match(result.output, /as-of=2026-11-21T08:58:42.000Z\n/)
})

test("says the exact line to write in the summary when the answer has one", async () => {
  const root = repo({ "package.json": "{}" })
  const finding = { state: "affected", severity: "high", reason: "GHSA-x: lodash prototype pollution.", replacement: "4.18.1", surface: { name: "lodash" }, version: "4.17.20",
    where: [{ file: "package.json", line: 6 }], edit: { file: "package.json", line: 6, from: '    "lodash": "4.17.20"', to: '    "lodash": "4.18.1"', note: "Pins lodash to 4.18.1." } }
  const result = await withInputs({ "api-key": "k", files: "package.json", "fail-on": "none" }, () => run({ root, fetchImpl: async () => Response.json({ findings: [finding] }) }))
  assert.match(result.summary, /4\.18\.1: write `"lodash": "4\.18\.1"` at line 6/)
})

test("an upgrade-only pull request gets each move's receipt: the base read through GitHub, then again with the code that imports it", async () => {
  const root = repo({
    "package.json": JSON.stringify({ dependencies: { express: "4.21.2" } }),
    "src/app.ts": 'import express from "express";\nconst app = express();\napp.get("/", (req, res) => res.redirect(req.query.next));\n',
    "src/util.ts": "export const add = (a, b) => a + b;\n",
  })
  const events = mkdtempSync(path.join(tmpdir(), "since-action-event-"))
  const eventPath = path.join(events, "event.json")
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7, base: { sha: "b".repeat(40) }, head: { sha: "h".repeat(40) } } }))
  const base = JSON.stringify({ dependencies: { express: "4.19.2" } })
  const sent = []
  const receipt = { package: { ecosystem: "npm", name: "express" }, from: "4.19.2", to: "4.21.2", verdict: "not_clear",
    sentence: "Not clear: 4.21.0 res.redirect no longer takes an untrusted URL, at src/app.ts:3.", releases: { releases: 3, full: 3, list: [] },
    reaching: [{ changeId: "c", release: "4.21.0", title: "res.redirect changed", state: "upgrade_blocker", where: [{ file: "src/app.ts", line: 3 }] }] }
  const fetchImpl = async (url, options = {}) => {
    const address = String(url)
    if (address.endsWith("/repos/acme/app/pulls/7/files?per_page=100")) return Response.json([{ filename: "package.json", status: "modified" }])
    if (address.includes("/repos/acme/app/contents/package.json?ref=")) return Response.json({ type: "file", encoding: "base64", content: Buffer.from(base).toString("base64"), sha: "s" })
    if (address.endsWith("/v1/check")) {
      const body = JSON.parse(options.body)
      sent.push(body)
      if (body.upgrade) return Response.json({ findings: [], receipts: [body.files.length > 1 ? receipt : { ...receipt, verdict: "not_settled", reaching: [], sentence: "No code read imports express." }] })
      return Response.json({ findings: [] })
    }
    return new Response("not found", { status: 404 })
  }
  const result = await withInputs({ "api-key": "k", "github-token": "t", files: DEFAULT_FILES }, () => {
    Object.assign(process.env, { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: "acme/app", GITHUB_API_URL: "https://api.github.com" })
    return run({ root, fetchImpl })
  })
  const upgrades = sent.filter((body) => body.upgrade)
  assert.equal(upgrades.length, 2)
  assert.deepEqual(upgrades[0].files.map((file) => file.path), ["package.json"])
  assert.equal(upgrades[0].files[0].content, base)
  assert.deepEqual(upgrades[1].files.map((file) => file.path), ["package.json", "src/app.ts"])
  assert.deepEqual(upgrades[1].upgrade.map((file) => file.path), ["package.json"])
  assert.match(result.summary, /## Upgrade receipt/)
  assert.match(result.summary, /\*\*express 4\.19\.2 to 4\.21\.2:\*\* Not clear: 4\.21\.0 res\.redirect/)
  assert.match(result.log, /::warning file=src\/app\.ts,line=3,title=Upgrade receipt%3A express::Not clear/)
  assert.match(result.output, /not-clear=1/)
  assert.equal(result.code, 0)
})

test("a pull request that changes only a lockfile sends the manifest beside it at both ends, so a declared package reads as direct", async () => {
  const pyproject = '[tool.poetry.dependencies]\npython = "^3.11"\ntyper = ">=0.9"\n'
  const root = repo({ "pyproject.toml": pyproject, "poetry.lock": "[[package]]\nname = \"typer\"\nversion = \"0.26.8\"\n", "app/main.py": "import typer\n" })
  assert.deepEqual(manifestsBeside(root, ["poetry.lock"]), [{ path: "pyproject.toml", content: pyproject }])
  // A manifest the pull request changed is already sent as changed, never twice.
  assert.deepEqual(manifestsBeside(root, ["poetry.lock", "pyproject.toml"]), [])
  const events = mkdtempSync(path.join(tmpdir(), "since-action-event-"))
  const eventPath = path.join(events, "event.json")
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 9, base: { sha: "b".repeat(40) }, head: { sha: "h".repeat(40) } } }))
  const baseLock = "[[package]]\nname = \"typer\"\nversion = \"0.26.7\"\n"
  const sent = []
  const fetchImpl = async (url, options = {}) => {
    const address = String(url)
    if (address.endsWith("/repos/acme/app/pulls/9/files?per_page=100")) return Response.json([{ filename: "poetry.lock", status: "modified" }])
    if (address.includes("/repos/acme/app/contents/poetry.lock?ref=")) return Response.json({ type: "file", encoding: "base64", content: Buffer.from(baseLock).toString("base64"), sha: "s" })
    if (address.endsWith("/v1/check")) {
      const body = JSON.parse(options.body)
      sent.push(body)
      return Response.json({ findings: [], receipts: body.upgrade ? [] : undefined })
    }
    return new Response("not found", { status: 404 })
  }
  await withInputs({ "api-key": "k", "github-token": "t", files: DEFAULT_FILES }, () => {
    Object.assign(process.env, { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: "acme/app", GITHUB_API_URL: "https://api.github.com" })
    return run({ root, fetchImpl })
  })
  const upgrade = sent.find((body) => body.upgrade)
  assert.deepEqual(upgrade.files.map((file) => file.path), ["poetry.lock", "pyproject.toml"])
  assert.equal(upgrade.files[0].content, baseLock)
  assert.deepEqual(upgrade.upgrade.map((file) => file.path), ["poetry.lock", "pyproject.toml"])
})

