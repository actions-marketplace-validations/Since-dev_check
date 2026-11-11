// node --test distribution/action/test.mjs
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { checkBody, fails, matchFiles, patternRegExp, run, sentence } from "./index.mjs"

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

test("a run checks each file, annotates findings, writes the summary and fails on a proven high", async () => {
  const root = repo({ "package.json": '{"dependencies":{"openai":"3.3.0"}}', "go.mod": "module x" })
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const findings = init.body.includes("openai") ? [FINDING, { ...FINDING, state: "needs_review", severity: "critical" }] : []
    return Response.json({ findings })
  }
  const result = await withInputs({ "api-key": "sc_test", files: "**/package.json\n**/go.mod", "fail-on": "high" }, () => run({ root, fetchImpl }))
  assert.equal(result.code, 1)
  assert.equal(calls.length, 2)
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
  assert.equal(calls[0].manifest.path, "go.mod")
  assert.match(result.summary, /go\.sum: not checked\. go\.mod holds the versions; go\.sum is only checksums\./)
  assert.match(result.summary, /go\.mod: Since is still reading 12 newer releases of its dependencies\. A later run includes what they changed\./)
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
  assert.equal(calls, 2)
  assert.equal(result.code, 0)
  assert.match(result.log, /3 files matched; checked the first 2/)
  assert.match(result.summary, /No findings in the 2 files checked\./)
})
