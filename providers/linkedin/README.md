# LinkedIn connector (read-only)

Reads a LinkedIn member, a company, and the signed-in member — using your
logged-in browser session. **Read-only**: no messaging, posting, or connection
requests.

```bash
mastro login linkedin
mastro linkedin me                    # the signed-in member (also the verify probe)
mastro linkedin profile williamhgates # a member, by /in/<publicId> slug
mastro linkedin company microsoft     # a company, by /company/<universalName> slug
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

| Command   | Endpoint                                    |
| --------- | ------------------------------------------- |
| `me`      | `GET /voyager/api/me` (also the verify probe) |
| `profile` | `GET /voyager/api/identity/dash/profiles` by public id |
| `company` | `GET /voyager/api/organization/companies` by universal name |

Responses are LinkedIn's normalized+json envelope (a `data` object plus an
`included` array of entities referenced by URN). The `publicId` / `universalName`
slugs come straight from the LinkedIn URL (`/in/<publicId>`, `/company/<name>`).

## Why there's no search

Search (people / companies / jobs) is **not** part of this connector: LinkedIn
moved its search and jobs UI onto a **server-driven-UI** layer (RSC) that
`POST`s to `/flagship-web/rsc-action/...` and returns a base64 component tree,
not a consumable JSON API. The old Voyager search endpoints no longer answer
(typeahead 404s, blended-search/jobs need per-deploy ids the page never exposes),
and a live search page load makes no Voyager search calls at all. Adding search
would mean either replaying the RSC requests and decoding the SDUI tree, or
scraping the rendered DOM — a browser-automation effort separate from this
HTTP-replay connector.

## Status & drift

`status: reverse_engineered` — observed from a live linkedin.com session, can
change without notice.

- **`403 "CSRF check failed"`** → the `csrf-token` header isn't the unquoted
  `JSESSIONID` (see the quote gotcha above).
- **`401`** → the session expired or wasn't captured; `mastro login linkedin`.
- **Profile data looks thin** → the default decoration returns the core profile;
  for richer sections, capture a live `/identity/dash/profiles` request from an
  `/in/<id>` page load and add its `decorationId` as a param.
