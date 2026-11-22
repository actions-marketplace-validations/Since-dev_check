# Since.dev check

A GitHub Action that checks your pull request's dependencies against everything that changed upstream: breaking releases, deprecations, security advisories, AI model retirements, removed APIs and runtimes past end of life. Findings show up as annotations on the files they hit and as a table in the run summary, and the run fails on a proven finding at the severity you pick.

Nothing merges or deploys. It only reads the files you point it at and reports.

## Use it

1. Create a workspace API key at [app.since.dev](https://app.since.dev) and add it to the repository's secrets as `SINCE_DEV_KEY`.
2. Add `.github/workflows/since.yml`:

```yaml
name: Since.dev
on:
  pull_request:
    paths:
      - "**/package.json"
      - "**/requirements*.txt"
      - "**/pyproject.toml"
      - "**/go.mod"
      - "**/Cargo.toml"
      - "**/Gemfile"
      - "**/composer.json"
      - "**/pom.xml"
      - "**/build.gradle*"
      - "**/*.csproj"
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: since-dev/check@v1
        with:
          api-key: ${{ secrets.SINCE_DEV_KEY }}
          fail-on: high
```

The `paths` filter runs it only when a manifest changes, which keeps runs to the pull requests that need them.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `api-key` | none | A workspace API key. Without one the run skips with a notice. |
| `files` | the common manifests | Which files to check, one pattern per line. `**/` matches any folder, `*` matches inside a name. Each manifest is sent with the lockfiles in its folder, so the versions checked are the ones you install. `go.sum` is never sent: it holds checksums, and `go.mod` holds the versions. |
| `max-files` | `50` | The most files one run sends, manifests and the lockfiles beside them. They are checked together, 50 at a time. |
| `fail-on` | `high` | Fail on a proven finding of this severity or higher: `low`, `medium`, `high`, `critical`, or `none`. A finding Since could not settle never fails the run. |
| `api-url` | `https://api.since.dev` | The API to call. |

## Outputs

| Output | What it is |
| --- | --- |
| `findings` | How many findings the checked files have. |
| `failing` | How many of them are proven and at or above `fail-on`. |
| `as-of` | What the answer is current as of, an ISO time: the oldest point its sources had been read up to. Empty when no source says. |

## What it costs

The files go together as one set of files, 50 at a time, so each import is checked at the version the same files pin. A set costs credits for each file that names a package or runtime, never more than checking the files one by one. Prices change, so see [since.dev/#pricing](https://since.dev/#pricing) for the current cost and what each plan includes. A call that fails costs nothing.

## Pull requests from forks

GitHub gives a fork's pull request no secrets, so the run has no key. It says so in a notice and passes instead of failing.

## When the API is out of reach

The run notes which files it could not check and passes. A Since.dev outage never blocks your pull requests. Out of credits stops the run with a warning, also without failing.

## More

- Scan any public repository at [since.dev/scan](https://since.dev/scan), no sign-in.
- Coding agents can use the same checks over MCP: [since.dev/docs#mcp](https://since.dev/docs#mcp).
- The full API reference: [since.dev/docs](https://since.dev/docs).

MIT licensed.
