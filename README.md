# eta status

The public status page for eta: are the API, the app, the app's live updates, the MCP server,
the live stream and the docs up right now, and how have they done over the last 90 days.

It needs no outside service, account or token. A scheduled GitHub Actions workflow runs the
checks and writes the results to the `data` branch. GitHub Pages serves the page from `main`,
and the page reads the results from the `data` branch in the visitor's browser.

```
GitHub Actions, every 5 min           data branch                 GitHub Pages (main)
scripts/check.mjs  ── force-push ──>  history.json  <── fetch ──  index.html + app.js
  curl + Node WebSocket                (one commit)    raw.githubusercontent.com
```

## What it checks

| Service | Request | Up when |
|---|---|---|
| API | `GET https://api.eta.cash/health` | 200 and the body has `"ok": true` |
| App | `GET https://www.eta.cash/` | 200 |
| App live updates | websocket to `wss://api.eta.cash/ws`, no auth | it opens and its first frame is JSON with `"t":"marks"`, within 10 seconds |
| MCP server | `POST https://api.eta.cash/mcp` with no key | 401 (it answers, so it is up) |
| Live stream | websocket to `wss://api.eta.cash/stream`, sends `{"type":"auth","key":"eta_000000000000_AAAA…"}` (a throwaway placeholder key) | a frame that says `bad key`, then close code 4001 |
| Docs | `GET https://eta-cash.gitbook.io/api` | 200 |

Each check records one of four states, the HTTP status and the time taken:

- **up**: the answer is what a healthy service gives.
- **slow** (`degraded` in the data): the right answer, but slower than the service's `slowMs`
  in `services.json`. 3 seconds for the API, app, live updates, MCP and stream; 5 seconds for
  the docs, which GitBook hosts.
- **down**: a wrong answer, an error, or no answer in 15 seconds (10 for the two websockets).
  For live updates, a socket that does not open is always down.
- **not yet live**: only the stream (`notLiveUntilUp` in `services.json`), and only until it has
  worked once. While it has never been seen working, a websocket that does not open counts as
  not yet live, whatever the reason (today a plain `GET /stream` is 404; the status of that GET
  is recorded). As soon as one check sees it working, the time is saved in `liveSince` and from
  then on the same failure counts as down. Nothing to flip by hand. A socket that opens but
  answers wrong is always down.

A check that comes back down or slow is tried once more after 5 seconds, and the second answer is
the one recorded. This keeps one dropped packet from painting a red mark.

The checks are defined in `services.json`. The page reads the same file for the names and order.

## How often

The workflow is scheduled every 5 minutes (`*/5 * * * *`). GitHub runs scheduled workflows on a
best-effort basis: under load a run can start several minutes late or be skipped. The page copes:

- Missing runs are "no data", never "down". Uptime is counted over the checks that ran.
- In the 24-hour view a 5-minute slot without its own run shows the last check, if that check is
  at most 30 minutes old.
- If the newest check is older than 30 minutes, the top line says so instead of
  "All systems working".

raw.githubusercontent.com caches files for up to 5 minutes, so the page can be up to about
10 minutes behind reality. The page refreshes itself every minute.

## History

`history.json` on the `data` branch holds:

- `recent`: every check from the last 24 hours (5-minute resolution).
- `days`: for each of the last 90 UTC days, how many checks per service were up, slow, down and
  not live.
- `liveSince`: when each service was first seen working.

Every run moves checks older than 24 hours into the day counts and drops days older than 90, so
each check is counted exactly once and the file stays around 50 KB. The `data` branch is one
commit, replaced on every run, so the repository does not grow by 288 commits a day.

Uptime is (up + slow) / (up + slow + down). Not-live checks and missing runs are left out. A day
is green at 99% or more, amber from 95% to 99%, and red below 95%.

## Post an incident

Edit `incidents.md` on `main` (the GitHub web editor is fine) and commit. Add a section like this:

```
## 2026-11-17 14:20 UTC | The API answers slowly
Status: Investigating
Affected: api, mcp

One or two plain sentences on what users see.

- 14:20 UTC We are looking into slow answers from the API.
- 14:55 UTC Fixed. Answers are back to normal speed.
```

- Heading: `## `, date, time in UTC, `UTC`, ` | `, title. A heading in another shape is skipped.
- `Status:` Investigating, Identified, Monitoring or Resolved. Resolved shows in green.
- `Affected:` service ids from `services.json`.
- Update the same section as things change. Change `Status:` to Resolved at the end.
- Everything shows as plain text. Newest incidents show first.

The page picks up the change after Pages redeploys `main`, usually within a few minutes.

## Run it locally

Node 22 or newer, curl and nothing else.

```sh
node scripts/check.mjs --history history.json --new        # one real run; --new only when the file does not exist yet
node --test test/history.test.mjs test/stream.test.mjs     # compaction on 100 synthetic days, stream check on a local mock
node test/synth.mjs --out demo.json                        # 100 synthetic days for looking at the page
python3 -m http.server 8000 --bind 127.0.0.1               # then open http://127.0.0.1:8000/?data=demo.json
```

On localhost only, the page takes `?data=` and `?incidents=` to read local files and `?now=` to
pretend it is another time. On the public site these are ignored.

## Make it live (one time)

1. Create the public repository `endix-labs-v1/eta-status` and push both branches:
   `git push -u origin main data`. `main` must be the default branch: scheduled workflows run
   only from the default branch.
2. Settings, Pages: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
   `.nojekyll` is there so Pages serves `incidents.md` as it is.
3. Actions tab: enable workflows if GitHub asks, open "checks" and press "Run workflow" once.
   Then check that the run is green, that `data` now has a fresh `history.json`, and that the run
   did not start a Pages build.
4. Check that no branch ruleset blocks force-pushes to `data`, and that the organisation lets the
   workflow token write (`permissions: contents: write` is set in the workflow).

The page is then at `https://endix-labs-v1.github.io/eta-status/`.

## Custom domain (status.eta.cash), later

1. At the DNS provider for eta.cash: a `CNAME` record `status` pointing to `endix-labs-v1.github.io`.
2. Settings, Pages, Custom domain: `status.eta.cash`, save. GitHub adds a `CNAME` file to `main`.
   Do not commit one by hand before the DNS record exists.
3. When the certificate is ready, tick "Enforce HTTPS".
4. Recommended: verify `eta.cash` for the organisation (organisation settings, Pages) so nobody
   else can claim the subdomain.

Nothing in the code changes: the page still reads `history.json` from raw.githubusercontent.com.

## Things to know

- GitHub turns off scheduled workflows in a public repository after 60 days without repository
  activity. Whether the bot's pushes to `data` count as activity is not confirmed. If the page
  shows "No check in the last … minutes" for a long time, look at the Actions tab and re-enable
  the workflow.
- A run that fails (it cannot read or write the history) shows as a failed run in Actions. A
  service being down does not fail the run: that is data, not an error.
- If `history.json` exists but cannot be parsed, the run stops rather than start a new history.
