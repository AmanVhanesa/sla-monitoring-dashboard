# SLA Monitoring Dashboard

Upload a CSV of health-check logs, have it cleaned by a deployed serverless function,
stored in a database, and measured against a 99.9% availability SLA.

| | |
|---|---|
| **Dashboard** | `https://dashboard.sla-monitoring-api.workers.dev` |
| **API (Cloudflare Worker)** | `https://api.sla-monitoring-api.workers.dev` |
| **Health check** | `https://api.sla-monitoring-api.workers.dev/api/health` |
| **Last verified live** | `21 Sep 2026 — both URLs responding, three datasets loaded (9, 12 and 30 day windows)` |

---

## 1. Architecture

```
  Browser                     Cloudflare Worker                 Cloudflare D1
  (Pages, static)             (serverless, stateless)           (SQLite)

  Upload UI  ──── CSV slices ────►  parse / validate / clean  ──►  uploads
     │                               dedupe by (service, ts)       checks
     │                                                             rejected_rows
     │                                                                  │
  Dashboard ◄─── JSON (stats, logs) ◄─── SQL aggregation ◄─────────────-┘
```

**Why each piece**

| Layer | Choice | Reasoning |
|---|---|---|
| UI | React + Vite, served as a **static-assets Worker** | Static hosting, free, no card. The page holds no business logic — it renders whatever the API returns. (Cloudflare Pages is now part of Workers; the project deploys with `wrangler deploy` and an `[assets]` block, no server code.) |
| Function | **Cloudflare Worker** | Genuinely serverless and free without a credit card. AWS and GCP free tiers both require a card on file, which the brief rules out. |
| Database | **Cloudflare D1** (SQLite) | Explicitly permitted, free, real SQL with window functions (needed for percentiles), and no connection pooling to manage from a Worker. |

The UI and API are deployed separately and are reachable at their own URLs. The
browser talks to the Worker cross-origin; there is no server-side rendering and
no backend-for-frontend in between.

### The upload path, and why it is chunked

The browser reads the file, splits it **on line boundaries only**, and POSTs each
slice of 500 rows to the Worker with the header line attached. It never parses a
field, converts a unit, or decides what a row means — all of that happens in the
function, so the stored numbers cannot be influenced by the client.

Chunking is deliberate, for two reasons:

1. Cloudflare's free tier caps CPU time per invocation. A 15,000-row file parsed
   and inserted in a single request is a real risk of hitting that ceiling;
   31 small requests are not.
2. It is what makes the function honestly stateless. Each slice is independent
   and idempotent, so any isolate can serve any slice, a retry is harmless, and
   progress is visible in the UI.

State lives entirely in D1. Re-running a slice cannot double-count, because the
`checks` table is keyed on `(upload_id, service_id, ts)` — see *Duplicates* below.

---

## 2. Data findings

Every issue below was found by profiling the five supplied CSVs; none of it was
given. Counts are from `monitoring_checks_9d_seed101.csv` / the 30-day file, and
the dashboard reports the same numbers for whatever you upload.

### 2.1 The same check is reported twice — 352 / 1,177 rows

Two agents (`agent-1`, `agent-2`) probe the same service at the same instant and
both file a report, with slightly different latencies (181ms vs 185ms).

Roughly 7.5% of rows are these second reports. Left alone they inflate the
denominator of every availability percentage, and the file appears to contain
more checks than were actually run.

**Handled by** treating a check as identified by *what was probed and when*, not
by who reported it: `PRIMARY KEY (upload_id, service_id, ts)`. The two reports
collapse into one logical check.

When two agents disagree, an upsert guard decides which survives:
a real failure outranks a success, and both outrank an unusable reading.

This same key makes ingestion idempotent — re-uploading a file cannot inflate
the numbers.

> **Sanity check:** after deduping, all five files contain exactly 96 checks per
> service per day with **zero gaps** (4,320 / 5,760 / 6,720 / 10,080 / 14,400
> rows). Any "missing check" you find without deduping first is one you created.

### 2.2 One service reports latency in seconds — 924 / 3,095 rows

`svc-search` sets `latency_unit = s` (`0.717`) while every other service uses
`ms` (`707`). Reading the number without the unit makes search look roughly
1000× faster than it is, and it would never trip a latency threshold.

**Handled by** normalising to milliseconds on ingest via a unit lookup table,
storing `latency_ms` as the canonical value and keeping `latency_raw` +
`latency_unit` alongside it so any figure can be traced back to the file. The
log view shows both.

### 2.3 Three different timestamp encodings

| Encoding | Example | 9-day file | 30-day file |
|---|---|---|---|
| ISO-8601 UTC | `2025-05-13T12:45:00Z` | 4,570 | 15,235 |
| Unix epoch seconds | `1746938700` | 70 | 233 |
| ISO-8601 with `+05:30` offset | `2025-05-13T18:00:00+05:30` | 32 | 109 |

The offset rows are the dangerous ones, and they fail silently. `18:00+05:30` is
`12:30Z` — a different check slot, and for rows near midnight **a different
calendar day**, which corrupts per-day availability without anything looking
wrong.

**Handled by** converting everything to UTC at ingest and counting each encoding
for the data-quality panel. A timestamp with no zone marker at all is pinned to
UTC rather than inheriting the runtime's local timezone (JavaScript's default,
and a classic source of results that change depending on where the code runs).

### 2.4 A status code that is not HTTP — 1 row per file

Exactly one row per file carries `status_code = 999`, with an otherwise normal
latency.

**The evidence that decided this:** in `monitoring_checks_14d_seed202.csv` there
is a check where `agent-1` reports `999` and `agent-2` reports `200` for the
same service at the same instant. The service answered. The agent failed to
record it.

So `999` is a **failed probe, not a failed service**. It is classified
`unknown` and excluded from both sides of the availability ratio — counting it
as downtime would issue a billing credit for a monitoring bug, and counting it
as uptime would hide real failures. The count is displayed separately so it is
never silently dropped.

### 2.5 Negative latency — 1 row per file

e.g. `-223 ms`. Latency is elapsed time and cannot be negative. Stored as
`NULL` and excluded from percentiles; the check itself still counts toward
availability, because its status code is perfectly valid.

### 2.6 Missing latency — 56 / 186 rows, all on status 200

Blank `latency` on successful checks. Reading a blank as `0` would drag every
average and percentile down. Stored as `NULL`, excluded from latency stats,
still counted for availability. The per-service missing count is reported.

### 2.7 Outages are brownouts, not clean on/off failures

This one changed the design. The seeded `svc-reports` outage looks like this:

```
16:00  502   3000ms
16:15  502   3022ms
16:30  200   2193ms   <- "success", 3.4x the 644ms median
16:45  503   1942ms
17:00  200   2983ms   <- "success", 4.6x the median
17:15  503   2805ms
17:45  200    713ms   <- actually recovered
```

Counting only non-2xx responses reports this as two unrelated 30-minute blips.
It was one continuous degradation, and the 200s in the middle were served to
users three to five times slower than normal.

**Handled by** grouping *impaired* checks rather than only failed ones. A check
is impaired if it failed, or if it succeeded but took more than **3× its
service's median latency** (median, because it barely moves during an outage, so
the threshold does not drift upward as the incident worsens).

A second effect appears in longer outages: they are not solid blocks of
failures. The 6-hour `svc-auth` outage returned one entirely normal 200 in 426ms
partway through — against a 429ms slow threshold. Latency alone was deciding
incident boundaries on a coin flip. So an incident also **bridges a single fully
healthy check**; two healthy checks in a row (30 minutes of recovery) end it.

**Validation:** the case study bundles `dataset_incident_log.json`. It was used
only to check this logic after the fact, never as an input. Against it, the
detector reconstructs **all 8 documented incidents across all 5 files**, two of
them to the exact minute:

| File | Documented | Detected |
|---|---|---|
| 21d | `svc-payments` 2025-04-05 09:30–15:00 | 09:30–15:00 (16 failed + 4 slow) |
| 30d | `svc-auth` 2025-04-22 04:00–10:15 | 04:00–10:15 (18 failed + 4 slow) |
| 30d | `svc-reports` 2025-04-09 11:45–13:45 | 11:45–14:00 (7 failed + 1 slow) |
| 14d | `svc-notify` 2025-05-19 14:45–19:15 | 14:45–19:30 (16 failed + 1 slow) |
| 14d | `svc-notify` 2025-05-25 07:30–10:00 | 07:30–10:15 (8 failed + 2 slow) |
| 12d | `svc-search` 2025-04-14 12:00–16:45 | 12:00–17:00 (16 failed + 3 slow) |
| 12d | `svc-search` 2025-04-18 12:15–13:30 | 12:15–13:45 (3 failed + 3 slow) |
| 9d | `svc-reports` 2025-05-13 16:00–17:15 | 16:00–18:15 (6 failed + 2 slow) |

Detected windows run to the end of the last impaired check plus one interval,
which is why they close 15 minutes later than the log's last check-point.

The detector also surfaces a handful of smaller 2-check, 30–45 minute events
that the log does not list. They are real — two consecutive failed checks is
30 minutes a user would notice — and their size makes them obviously distinct
from a 16-failure outage.

### 2.8 Things that look like problems but are not

- **Latency spikes of 2–3 seconds** against a ~750ms p95 are concentrated inside
  incident windows. They are signal, not corruption, and are kept.
- **`region` is a single value** (`ap-south-1`) in every file. Stored, but there
  is nothing to compare across yet.
- **No 4xx anywhere.** The classifier still handles it (see assumptions).

---

## 3. Assumptions

Where the brief left room, this is what I chose and why.

**Availability = successful checks ÷ evaluated checks**, where evaluated excludes
`unknown` readings. Each check represents one interval of service state.

**A service is "up" if it returned a valid HTTP response that was not a server
error.** 5xx is the provider's fault and counts as downtime. 4xx would be a
client error and is counted as *up*, which is how commercial SLAs treat it —
none appears in this data, but the rule is implemented rather than left to
chance.

**Downtime = failed checks × the check interval.** Slow-but-successful checks
are deliberately **not** counted as downtime. The SLA number stays strictly "did
it return an error", because that is what a billing credit rests on; degradation
is reported next to it as context rather than folded into it.

**The check interval is measured, not assumed.** The brief says 15 minutes, and
the data agrees, but downtime is a multiple of this number — if an export moved
to 5-minute probes, a hard-coded 15 would silently triple every figure and every
credit derived from it. It is derived per upload as the modal gap between
consecutive checks.

**An incident needs at least 2 consecutive impaired checks and at least one real
failure.** A single isolated 5xx is noise — a retry would very likely have
succeeded — and a merely slow patch is degradation, not an outage.

**The date range comes from the data.** Nothing assumes 9, 14 or 30 days; the
window is `MIN(day)`–`MAX(day)` of what was stored, and the date pickers are
bounded by it.

**Each upload is its own dataset.** Uploads are not merged, so two files with
overlapping dates do not contaminate each other, and the dashboard has a
dataset selector. This also makes re-uploading the same file safe.

**All dates and times are UTC**, everywhere, with no localisation. Mixing zones
is what caused finding 2.3 in the first place.

### Which stats, and why

The brief calls this a real design decision, so: the two people who open this
page are **on-call** ("what broke, how long, is it still broken") and **billing**
("does this window owe a credit"). Every block answers one of those. Anything
that answered neither was left out.

| Stat | Who needs it | Why this and not something else |
|---|---|---|
| Availability to 3 decimals | Billing | The SLA line sits at the third decimal. Rounding 99.94% to 99.9% hides a breach. |
| Breach badge per service | Billing | The actual output of the whole pipeline: does this service owe money. |
| Downtime in minutes | Billing | Credits are argued in minutes, not percentages. |
| Error budget consumed | On-call | "1,007% of the month's budget is gone" is immediately actionable in a way that "98.993%" is not. 99.9% over 30 days allows only 43.2 minutes. |
| p50 / p95 / p99 latency | On-call | Never the mean — one 3-second outlier moves an average and tells you nothing about what most users experienced. |
| Incident list | On-call | Turns 15,000 rows into "auth-api was degraded 04:00–10:15". The single most useful thing on the page. |
| Slow-check count | On-call | Surfaces brownouts that availability alone cannot see (finding 2.7). |
| Daily availability bars | Both | Shows whether a breach was one bad day or steady decay. Anchored at 95%, because a scale from 0 makes every bar look identically full. |
| Data-quality panel | Both | The brief opens with "the pipeline has to be trustworthy". A number with no provenance is not trustworthy, so what the function changed is shown next to what it produced. |

Deliberately left out: uptime streaks, alert counts, per-agent breakdowns, and
request volume. With one region and two agents there is nothing to compare, and
they would be decoration.

---

## 4. Running and deploying

### Prerequisites
Node 20+, and a free Cloudflare account (`npx wrangler login`).

### Local

```bash
# API — http://localhost:8787
cd worker
npm install
npx wrangler d1 execute sla-monitoring --local --file=./schema.sql
npm run dev

# UI — http://localhost:5173
cd ../web
npm install
echo "VITE_API_BASE=http://localhost:8787" > .env
npm run dev
```

Load a file without the browser, using the same chunked protocol the UI uses:

```bash
node tools/upload-csv.mjs http://localhost:8787 ../monitoring_checks_30d_seed404.csv
```

### Tests

```bash
cd worker && npm test
```

39 tests covering CSV field splitting, all three timestamp encodings, unit
conversion, status classification, dedupe precedence, and incident grouping
(including the brownout and single-recovered-check cases above).

### Deploy from scratch

```bash
cd worker
npx wrangler d1 create sla-monitoring          # put the printed id in wrangler.toml
npx wrangler d1 execute sla-monitoring --remote --file=./schema.sql
npx wrangler deploy                            # prints the API URL

cd ../web
echo "VITE_API_BASE=https://<your-api-url>" > .env.production
npm run deploy                                 # builds, then wrangler deploy
```

### Staying live

Both the API and the static-asset Worker are always-on with no idle suspension,
so this does not sleep. Free-tier ceilings that matter: 100,000 Worker requests/day
(a 30-day file costs 34) and 100,000 D1 row writes/day (~14,400 per upload).
Normal review traffic is nowhere near either.

---

## 5. What I would do differently with more time

- **Move ingest off the request path.** Chunking works and is honest, but the
  correct shape at real volume is: upload to object storage, enqueue, and have a
  consumer process it, so a browser tab closing mid-upload cannot leave an
  upload half-finished. Right now that shows as `status = "receiving"`.
- **Make the incident thresholds configurable per service.** `3×` the median and
  bridging one healthy check are defensible and validated against all five
  files, but they are currently constants in the source. They belong in a
  per-service config, since a batch job and a login API do not deserve the same
  latency rule.
- **Reconcile agents instead of picking a winner.** Today the higher-severity
  report wins a disagreement. With more time I would keep both reports and
  surface disagreement explicitly — persistent one-agent-only failures are how
  you detect a network partition rather than a service outage.
- **Add SLA periods.** Credits are assessed monthly; this measures whatever
  window you uploaded. Real billing needs calendar-month boundaries and a
  maintenance-window exclusion list.
- **Push percentile computation into a rollup table.** The percentile query ranks
  every latency in the window on each request. Fine at 15,000 rows, wrong at 15
  million — daily per-service rollups written at ingest would fix it.
- **Test the SQL, not just the pure functions.** The 39 tests cover the cleaning
  and grouping logic; the aggregation queries are verified by hand against the
  five sample files. They deserve a test harness against a real D1 instance.
