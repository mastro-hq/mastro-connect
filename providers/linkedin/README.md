# LinkedIn connector (read-only)

Reads a LinkedIn member, a company, the signed-in member, and people search
results — using your logged-in browser session. **Read-only**: no messaging,
posting, or connection requests.

```bash
mastro login linkedin
mastro linkedin me                       # the signed-in member (also the verify probe)
mastro linkedin profile williamhgates    # a member, by /in/<publicId> slug
mastro linkedin company microsoft        # a company, by /company/<universalName> slug
mastro linkedin search-people --keywords "react engineer berlin"
```

The connector is described by [`openapi.yaml`](openapi.yaml) (a valid OpenAPI 3.1
document) plus [`auth.manifest.json`](auth.manifest.json) for the browser capture.

## ⚠️ Read this before using it

Automating linkedin.com **violates LinkedIn's User Agreement §8.2** (it prohibits
scripts/crawlers/bots for scraping). The risk lands on the **signed-in account**
— yours: LinkedIn restricts or bans accounts caught automating, and detection is
behavioral (request velocity, robotic timing, IP/device consistency), not just
volume. These are read calls, the lowest-risk slice, but the risk is real — keep
usage human-paced (the rate limit is 10 req/min) and don't fan it out.

**`search-people` is the higher-risk command.** A profile read is "open one
page"; a keyword search is the classic *scraping* pattern LinkedIn's heuristics
watch for most closely, and it returns a page of members you didn't already know.
It's still read-only, but treat it as the riskiest thing here: run it
occasionally and by hand, never in a loop. (That's also why pagination past the
first page of results is intentionally not wired.)

There is **no legitimate API path** to these operations: LinkedIn's official
OAuth API only grants sign-in, reading your *own* profile, and posting to your
*own* feed. Reading *other* members is partner-program-gated and unavailable to
an individual developer, so this connector uses the web app's internal **Voyager**
API.

## How auth works

Auth is the cookie jar on `linkedin.com`:

| Cookie       | Use                                                          |
| ------------ | ------------------------------------------------------------ |
| `li_at`      | Session auth token (**HttpOnly**) — the logged-in marker     |
| `JSESSIONID` | Doubles as the CSRF secret — its value is sent in the `csrf-token` header |
| `bcookie` / `lidc` | Browser id + datacenter routing (replayed with the jar) |

`mastro login linkedin` opens linkedin.com/feed, waits until `li_at` and
`JSESSIONID` exist, and stores the full cookie header plus the raw `JSESSIONID`
value (all redacted in logs). After capture it runs the `me` verify probe so a
dead session is caught at login, not at first use.

**The JSESSIONID quote gotcha:** LinkedIn stores `JSESSIONID` quoted
(`"ajax:123…"`), but Voyager wants the `csrf-token` header *unquoted*
(`ajax:123…`). The spec strips the quotes at replay time with
`csrf-token: ${unquote:auth.jsessionid}` (the `unquote:` template modifier). A
wrong/quoted csrf-token answers `403 "CSRF check failed"`.

## How replay works

LinkedIn fingerprints non-browser clients and challenges them after a few
requests, so the spec sets `x-mastro-replay.via_browser: true` and mastro runs
requests **inside your logged-in linkedin.com tab** via the extension (same path
as Depop/Amazon — see [`docs/BROWSER-PROXY.md`](../../docs/BROWSER-PROXY.md)),
which carries the real TLS fingerprint and challenge cookies.

The Voyager endpoints need a fixed header set, declared once in
`x-mastro-auth.headers`:

| Header                       | Value                                          |
| ---------------------------- | ---------------------------------------------- |
| `cookie`                     | the full captured jar (`${auth.cookie_header}`) |
| `csrf-token`                 | the unquoted `JSESSIONID` (`${unquote:auth.jsessionid}`) |
| `x-restli-protocol-version`  | `2.0.0` (the Rest.li wire format)              |
| `x-li-lang`                  | `en_US`                                        |
| `x-li-track`                 | client/version JSON the web app sends          |
| `accept`                     | `application/vnd.linkedin.normalized+json+2.1` |

**Requirement:** the mastro extension must be installed/enabled and you need a
linkedin.com tab (mastro opens one if needed).

## Commands

| Command         | Endpoint                                                       |
| --------------- | -------------------------------------------------------------- |
| `me`            | `GET /voyager/api/me` (also the verify probe)                  |
| `profile`       | `GET /voyager/api/identity/dash/profiles` by public id         |
| `company`       | `GET /voyager/api/organization/companies` by universal name    |
| `search-people` | `POST /flagship-web/search/results/all/` (SDUI/Flight) by keyword |

`me` / `profile` / `company` return LinkedIn's normalized+json envelope (a `data`
object plus an `included` array of entities referenced by URN). The `publicId` /
`universalName` slugs come straight from the LinkedIn URL (`/in/<publicId>`,
`/company/<name>`).

`search-people` is different (see "How search works" below): it returns an array
of people, each `{ name, headline, location, distance, url, publicId }`. Feed a
result's `publicId` straight to `profile` for the full record.

## How search works (people only)

`search-people` is the **odd one out**: it isn't a Voyager call. LinkedIn moved
its search UI onto a **server-driven-UI** layer (RSC). The old Voyager search
endpoints are all dead — typeahead 404s, blended-search/jobs need per-deploy ids
the page never exposes, and a live search page load makes zero Voyager search
calls. Instead the search results page `POST`s to
`/flagship-web/search/results/all/?keywords=…` and the server answers with a
**React Server Components (Flight) stream** — newline-delimited rows whose big
row is a nested component tree, *not* a JSON API.

So `search-people` replays that POST and walks the Flight tree:

- The request body is a large **fixed** SDUI navigation envelope; only `keywords`
  varies (it appears in the envelope's `url` field and its `requestedArguments`).
  The spec sends it via `x-mastro-body` (a raw templated body) because it can't
  be assembled from flat parameters. The SDUI endpoint also needs its own headers
  (`x-li-rsc-stream: true`, a plain `accept` instead of the Voyager
  `normalized+json`), declared per-operation via `x-mastro-headers`.
- The response is decoded by `x-mastro-extract` with `format: flight`: each
  element tagged `viewName: "people-search-result"` becomes one person, with the
  profile URL (and its `/in/<publicId>` slug) and the ordered visible text
  (name / headline / location) read off the card. The full SRP load returns the
  whole app shell and splits its component tree across **many** Flight rows (the
  shell first, the results in a later row), so the extractor parses every row and
  collects cards from all of them — it does not assume one results row.

**Limits:** only the **people** vertical, and only what the **first page**
renders inline — in practice the top few results (the SRP server-renders a
handful and lazy-loads the rest as you scroll). Companies/jobs are each a
separate SDUI surface (not wired). Deeper results come from a different
pagination POST that needs a per-search `searchId` from the first response —
deliberately not wired: a page of results is already a strong scraping signal,
and search is heavier on LinkedIn's automation heuristics than a single profile
read. The SDUI `x-li-application-version` rolls with LinkedIn deploys; a recent
value passes (it isn't strictly validated), but if search starts 4xx-ing,
re-capture it from a live search request (see "Status & drift").

## Status & drift

`status: reverse_engineered` — observed from a live linkedin.com session, can
change without notice.

- **`403 "CSRF check failed"`** → the `csrf-token` header isn't the unquoted
  `JSESSIONID` (see the quote gotcha above).
- **`401`** → the session expired or wasn't captured; `mastro login linkedin`.
- **Profile data looks thin** → the default decoration returns the core profile;
  for richer sections, capture a live `/identity/dash/profiles` request from an
  `/in/<id>` page load and add its `decorationId` as a param.
- **`search-people` returns `[]` (empty, but 200)** → the Flight component tree
  changed: either the card's `viewName` is no longer `people-search-result`, or
  the text/URL nesting moved. Re-capture a live search POST and update the
  `x-mastro-extract` `item`/`fields`. The extractor returns `[]` (not an error)
  when no card matches, so an empty result with a 200 is the signal.
- **`search-people` 4xx-ing** → the SDUI deploy moved on. Re-capture the live
  `POST /flagship-web/search/results/all/` to refresh `x-li-application-version`
  in `x-mastro-headers` (and the `screenHash` in the `x-mastro-body` envelope if
  the navigation hierarchy changed).
