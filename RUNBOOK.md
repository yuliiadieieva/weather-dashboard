# Andrews Sykes Weather Dashboard: daily run (UK, Italy, Netherlands, Belgium, Luxembourg, Switzerland, Middle East, Saudi Arabia)

Runs every day at 08:10 London time. Same artifact URL every time. Email only when a new alert fires.

## 0. Status for the page header
The page header shows the run's progress from the database document `runs/status` (ArtifactData on the dashboard URL). Times: `started`/`finished` = UTC ISO (`2026-11-06T08:13:00Z`), `started_local`/`finished_local` = London time `YYYY-MM-DDTHH:MM` (same format as state.json `generated`).
- First thing: `get` runs/status (note its `version`; it may not exist), then `set` `{state:"running", step:"fetch", started, started_local}` (with `if_version` when it existed).
- After step 5 (publish) and step 6: `set` `{state:"done", started, started_local, finished, finished_local}`.
- On a failure (step 7): `set` `{state:"failed", step:"<step name>", error:"<short error>", started, started_local, finished, finished_local}`.
A status write never blocks the run: if it fails, carry on.

## 1. Get the files
Read the artifact (Artifact tool, action "read", URL in the task prompt). Fetch its published files into a working folder `wx/` (keep the `data/` sub-folder):
`data/fetch.py`, `data/build.py`, `data/db_merge.py`, `data/backfill.py`, `data/export_site.py`, `data/gapfill.py`, `data/template.html`, `data/depots.json`, `data/normals.json`, `data/outline.json`, `data/prev.json`, `data/sent.json`, `data/logo.svg`, `data/nolo-logo.svg`, `data/RUNBOOK.md`.

## 2. Fetch (shell, direct)
`python3 data/fetch.py` writes `data/raw_YYYY-MM-DD.json`:
- Open-Meteo, one request for every location: 16 days (Met Office model for the UK days 1 to 7, best match after that and for every other country) plus yesterday's observed day.
- Met Office UK warnings RSS. Meteoalarm feeds for Italy, Netherlands, Belgium, Luxembourg (plus the Belgian feed for Arlon) and Switzerland, filtered to the regions in depots.json (`mo`). The Middle East and Saudi Arabia have no warning feed (`mo` is empty); the page links to the national met services.
- Environment Agency flood alerts within 15 km of each English location.
- UKHSA cold and heat health alerts (needs `ukhsa-dashboard.data.gov.uk` in the allowed domains; if blocked the run carries on and the page says "not available this run").
If the forecast or warnings fail, the script exits with an error: do not publish, go to step 7.
If Open-Meteo answers 429 for a short burst the script waits and retries. If it answers with the DAILY limit (the cloud IP is shared with other users), the script stops at once with `FORECAST_DAILY_LIMIT`: go to step 2b, do not fail the run.

## 2b. Forecast fallback (only after FORECAST_DAILY_LIMIT)
Same Open-Meteo data, fetched from a different network:
1. `python3 data/fetch.py --print-url` prints the one forecast URL.
2. Firecrawl `firecrawl_scrape` with that `url`, `formats: ["rawHtml"]`, `maxAge: 0`. The `rawHtml` field is the JSON body (a list, one object per location); the tool result is too large to show, so it is saved to a file: load that file with Python, take `rawHtml`, `json.loads` it and save it as `data/forecast_fallback.json`. Check `metadata.statusCode` is 200 and the list length equals the number of locations in depots.json.
3. `python3 data/fetch.py --forecast-json data/forecast_fallback.json` writes the raw file as usual (warnings, floods and UKHSA are still fetched directly). The raw file records `forecast_route`.
If Firecrawl is not available or also fails, this is a failed run: step 7, naming both errors.

## 3. Build
`python3 data/build.py data/raw_YYYY-MM-DD.json`
Writes `index.html`, `data/state.json`, `data/email.json`, `data/sent.json`, `data/prev.json`, `data/db_writes.json` and prints the quick-read summary.

## 4. History database
1. ArtifactData `get` collection `actuals`, doc `<YYYY-MM>` of yesterday's month (from db_writes.json) with `out_dir` set; note its `version` (it may not exist on the 1st of a month).
2. `python3 data/db_merge.py <saved month file>` (omit the file if the doc does not exist) writes `data/db_out.json`.
3. ArtifactData `batch`: one `set` per entry in db_out.json (write each `data` to a temp JSON file and pass `file_path`), with `if_version` for the month doc when it already existed.
4. Gap fill (never blocks the run): days the daily run missed (failed runs) are refetched. Save this month's and last month's `actuals` docs (the ones you read or just wrote, as `<YYYY-MM>.json` in one folder), then `python3 data/gapfill.py <that folder>`. If it prints "skip", carry on. If it stops with the daily limit, use the same Firecrawl route as step 2b with `python3 data/gapfill.py <folder> --print-url` and `--forecast-json <file>`. Otherwise `set` each file in `data/gapfill_out/` as `actuals/<YYYY-MM>` with `if_version` (the version from your last read or write of that month). Leave `data/gapfill_out/` in place: step 5b copies it to the public site.
5. Backfill (optional, never blocks the run): ArtifactData `list` collection `actuals` with `out_dir` (note each month's `version`), then `python3 data/backfill.py <that actuals folder>`. It first fills locations missing from saved months (new depots), otherwise extends history three months further back, until January 2024. If it writes files in `data/backfill_out/`, `set` each as `actuals/<YYYY-MM>` in one batch, with `if_version` for months that already existed. If it prints "skip", carry on.

## 5. Publish
Artifact publish with `url` = the dashboard URL, `file_path` = index.html, `root` = the wx folder, and `files` for every file under `data/` listed in step 1 plus `data/state.json` and today's raw file. Keep the stored capabilities (omit `capabilities`). Never publish a partial update.

## 5b. Public copy (GitHub, served by Cloudflare)
After step 5 succeeds. Never blocks the run: if it fails, mention it in the email (or send a short note) and carry on.
1. `add_repo` (Claude Code Remote connector) owner `yuliiadieieva`, repo `weather-dashboard`, access `push`, then `git clone --depth 1 https://github.com/yuliiadieieva/weather-dashboard site` (generous timeout).
2. `python3 data/export_site.py site/public` (needs `index.html`, `data/state.json`, `data/template.html`, `data/db_out.json` from step 4 and the logos). It replaces `public/index.html`, merges today's month and flags into `public/history/`, and rebuilds the three regional sites `public-uk`, `public-europe` and `public-me` from the same template and data, filtered to each region (UK; IT, NL, BE, LU, CH; ME, SA). Commit all four folders together.
3. `git -C site add -A`, commit "Daily update <YYYY-MM-DD>", `git -C site -c push.negotiate=true push origin HEAD:main`. Cloudflare rebuilds the site from the push in about a minute.
4. Check the build started: after about 60 seconds, `gh api repos/yuliiadieieva/weather-dashboard/commits/$(git -C site rev-parse HEAD)/check-runs --jq '.check_runs[]|[.status,.conclusion]|@tsv'`. If it returns nothing (Cloudflare sometimes skips a push), push an empty commit (`git -C site commit --allow-empty -m "Retrigger deploy"`, then push again) and check once more.

## Public sites (password protected)
Four Cloudflare Workers serve the repo, each behind its own password (secret `PASSWORD` on that Worker, set in the Cloudflare dashboard; never in the repo):
- ASG (all regions): `weather-dashboard`, folder `public/`, config `wrangler.jsonc`
- UK: `weather-uk`, folder `public-uk/`, config `wrangler.uk.jsonc`
- Europe: `weather-europe`, folder `public-europe/`, config `wrangler.europe.jsonc`
- Middle East: `weather-me`, folder `public-me/`, config `wrangler.me.jsonc`
The gate is `worker/auth.js` (login page, 30-day signed session cookie, Log out, 5 wrong attempts lock for 15 minutes). Changing a password in Cloudflare ends that site's sessions only.
Official warnings refresh every 20 minutes on the public sites: a Cron Trigger on the ASG, UK and Europe Workers runs `worker/live.js` (same logic as fetch.py and build.py for Met Office, Meteoalarm, Environment Agency floods and UKHSA), stores the result, and the page reads `live.json` and replaces the official warnings and flags. The forecast still updates once a day. Middle East has no warning feed, so no cron. If depots change, regenerate `worker/depots.js` from `data/depots.json`.
RULE: every change (design, template, data, scripts) is published to the artifact, the main site and all three regional sites in the same push, never to one site alone. Regional sites must never contain another region's data.

## 6. Email (only when data/email.json is not empty)
Gmail send_message to yuliia.dieieva@gmail.com. One email per run, never more.
`data/email.json` is a list of EVENTS, already grouped like the page: forecast flags of one weather type on consecutive days in one country are one event (frost, cold day, colder than normal and cold snap together are one cold event); each official warning is its own event. Write ONE line per event, never one line per rule or per location. (`data/email_items.json` keeps the per-rule detail for reference only.)
Each event has `kind`: `new` (alert first seen inside 7 days), `early` (alert-level risk first seen in days 8 to 15), `reminder` (7, 3 or 1 day before, current values), `downgraded` (now only a watch flag) or `cleared` (no longer in the forecast); `label` (headline flag), `also` (other flags in the same event), `level`, `start`/`end`, `days_to` (days until it starts), `country`, `locations` (name plus merged detail) and `source`.
Subject: `Weather alert: <event labels> – <dd/mm/yyyy>`; if there are only reminders or changes, `Weather reminder: <event labels> – <dd/mm/yyyy>`.
Body, British English, no em dashes, short and plain:
1. Quick-read lines for each affected country (from the build output).
2. Sections, only those with entries, in this order: "New alerts", "Early warning (days 8 to 15, lower confidence)", "Reminders", "Changes". One line per event: dates (start to end), "in N days", country, label (plus "also: ..." when `also` is not empty), the locations (names, or "N locations" when more than 4, followed by the strongest reading), source. For changes say "Downgraded to watch" or "Cleared".
3. The dashboard link and the public link https://weather-dashboard.andrewssykes.workers.dev/

## 7. Failure
If any required step fails (including the 2b fallback): do not publish; email yuliia.dieieva@gmail.com, subject `Weather Dashboard: update failed – <dd/mm/yyyy>`, saying which step and the error.

## Rules
Thresholds live in build.py (RULES, RULE_INFO, OVERRIDES for Italy). Days 1 to 7 get full flags; days 8 to 15 are the outlook (watch flags on the page, but alert-level risks there are emailed as early warnings). Reminders go 7, 3 and 1 day before; nothing is emailed for today itself. Warmer-than-normal flags apply May to September only. Fog never flags or emails. Downgrades and drop-outs are reported once. sent.json tracks this per location, rule and day.
