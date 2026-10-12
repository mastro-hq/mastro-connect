# mastro connector reference

Compact reference for the `mastro-author` skill. Full docs:
`docs/AUTHORING.md`, `docs/WORKFLOWS.md`, `docs/BROWSER-PROXY.md` in the
mastro-connect package (https://github.com/mastro-hq/mastro-connect/tree/main/docs).

## auth.manifest.json

```json
{
  "schema_version": "browser-auth-manifest/v1",
  "provider_id": "myapp",
  "display_name": "MyApp",
  "launch": {
    "url": "https://www.myapp.com/",
    "open_tab": true,
    "expected_origins": ["https://www.myapp.com"],
    "timeout_seconds": 180
  },
  "permissions": {
    "host_permissions": ["https://www.myapp.com/*"],
    "observes_cookies": true,
    "observes_request_headers": false,
    "observes_request_body": false,
    "observes_response_headers": false,
    "injects_page_bridge": false,
    "observes_storage": false
  },
  "capture": {
    "cookies": [
      { "url": "https://www.myapp.com", "include_names_matching": ["^session$", "^csrf$"], "save_as": "cookies" }
    ]
  },
  "completion": { "all": [{ "cookie_present": "session" }] },
  "serialization": {
    "output_schema": "capture-bundle/myapp-web/v1",
    "fields": {
      "csrf": "${cookies.csrf.value}",
      "cookie_header": "${cookies.as_header}"
    }
  },
  "security": {
    "redact_fields": ["csrf", "cookie_header"],
    "persist_minimum": true,
    "allowed_postback_origin": "http://127.0.0.1"
  }
}
```

Capture sources (`capture.*`, each optional):

| Rule | Shape | Serialize with |
| --- | --- | --- |
| `cookies[]` | `{ url, include_names_matching: [regex], save_as }` | `${cookies.<name>.value}`, `${cookies.as_header}` |
| `storage[]` | `{ area: local\|session, keys: [..], save_as? }` (set `observes_storage`) | `${storage.local.<key>}` |
| `headers[]` | `{ source: request\|response, url_matches, is_regex?, include_names: [..], save_as? }` (set `observes_request_headers` / `observes_response_headers`) | the `save_as` name |
| `page_events[]` | `{ source: fetch-response\|xhr-response, url_matches, is_regex?, body_json_path?, save_as }` (set `injects_page_bridge`) | the `save_as` name |

Completion predicates (combine with `all` / `any` / `not`): `cookie_present`,
`cookie_name_prefix_present`, `storage_key_present` (`"local.<key>"`),
`header_seen`, `field_present`, `authenticated_response_seen`.

## openapi.yaml skeleton

```yaml
openapi: 3.1.0
info: { title: MyApp API (unofficial), version: reverse-engineered-YYYY-MM-DD }
servers:
  - url: https://www.myapp.com

x-mastro-replay:
  via_browser: true            # only if a plain client is bot-walled
  recapture_on: [401, 403]     # auth-expiry statuses → "re-run mastro login"
  retry_on: [429]
  rate_limit: { requests_per_minute: 20 }

x-mastro-auth:
  required_fields: [cookie_header, csrf]
  verify: { operationId: me }  # cheap read-only liveness probe after login
  headers:
    cookie: "${auth.cookie_header}"
    x-csrf-token: "${auth.csrf}"
    x-request-id: "${uuid}"    # generated per request; also ${now}
  redact: [cookie, x-csrf-token]

paths:
  /api/me:
    get:
      operationId: me
      summary: The signed-in user

  /api/search:
    get:
      operationId: search
      x-mastro-result: results           # print response.results
      parameters:
        - { name: q, in: query, required: true, schema: { type: string } }
        - name: condition                # closed set → enum
          in: query
          explode: true
          schema: { type: array, items: { type: string, enum: [new, used] } }
        - name: brand                    # API-served set → resolve
          in: query
          schema: { type: string }
          x-mastro-resolve: { from: brands, value_path: "[].id", label_path: "[].name" }

  /api/brands:
    get:
      operationId: brands
      x-mastro-hidden: true              # metadata, not a command
```

The first declared parameter also binds to the first positional
(`mastro myapp search "red jacket"`).

## x-mastro-* extensions

| Extension | Where | For |
| --- | --- | --- |
| `x-mastro-auth` | root | credential → request: `required_fields`, `headers`, `cookies`, `verify`, `redact` |
| `x-mastro-replay` | root | `via_browser`, `browser_tab_origin`, `impersonate_browser`, `rate_limit`, `retry_on`, `recapture_on`, `follow_html_refresh`, `user_agent` |
| `x-mastro-command` | operation | CLI command name (default: `operationId`) |
| `x-mastro-hidden` | operation | not a command (helpers, resolve sources) |
| `x-mastro-result` | operation | dotted path of the response to print |
| `x-mastro-resolve` | parameter / arg | dynamic enum: `from` (operationId or `file:<path>`), `value_path`, `label_path`, `keyed`, `key_template`, `cache_ttl` |
| `x-mastro-extract` | operation | non-JSON responses → objects. HTML: `items` selector + `fields` (`selector`, `attr`, `pattern`, list fields with `each` + `fields`); omit `items` for one object. `format: flight` for RSC streams |
| `x-mastro-transport` | operation | force `direct` or `browser` for one operation |
| `x-mastro-body` + `x-mastro-args` | operation | templated JSON body for a single request + the flags it reads |
| `x-mastro-headers` | operation | extra headers for one operation |
| `x-mastro-workflow` | operation | multi-step command (below) |

Plain OpenAPI also used: operation-level `servers` (API split across hosts),
`security: []` (public operation, callable before login).

## Templates

`${auth.<field>}` (credential), `${args.<flag>}` and `${args.<flag>|default}`,
`${steps.<id>.<path>}`, `${item}` / `${index}` (inside `foreach`), `${uuid}`,
`${now}`, `${file:item}` (binary body from a file path).

## Workflows

```yaml
/x-mastro/create-thing:
  post:
    operationId: create-thing
    summary: Create a thing (supports --dry-run)
    x-mastro-args:
      - { name: title, required: true }
      - { name: photo, multiple: true }
    x-mastro-workflow:
      result: create                      # step (or step.path) to return
      steps:
        - id: uploads
          operationId: uploadPhoto
          foreach: "${args.photo}"
          request: { body: "${file:item}" }
          output: { path: id }
        - id: create
          operationId: createThing        # a hidden op
          request:
            body: { title: "${args.title}", photo_ids: "${steps.uploads}" }
          fail_when: ["${steps.create.error}"]   # 200-with-error APIs
      handoff:                            # optional: finish in the browser
        url: https://www.myapp.com/checkout
        local_storage: { cartKey: "${steps.create.cart_key}" }
```

Step options: `foreach` (+ `as`), `poll: { until, attempts, delay_ms }`,
`request: { url, method, body, headers, no_auth, transport, form }`,
`output: { path, extract, coerce: number }`, `fail_when`, and transform steps
(no `operationId`, just `value` + `output`). `request.form` replays a
server-rendered `<form>` (CSRF + hidden fields) from a prior step's HTML.

## Validation

`mastro validate <dir>` checks: manifest schema and `provider_id`, spec parses
as 3.1, unique operationIds/commands, servers present, every operation that
sends the session targets an origin the manifest names, workflow step/handoff/
result references, `${args.*}` reads match declared flags, resolve sources
exist inside the connector, regexes compile, a rate limit ≥ 1, skill
frontmatter + `mastro-<id>-` prefix, no symlinks, HARs or live-looking tokens.
Warns on a missing rate limit, missing README, and write workflows.

At run time, credentials are only ever sent to the origins recorded at login,
and the extension only proxies for sites the user logged in to — so list every
authenticated host in `permissions.host_permissions`.
