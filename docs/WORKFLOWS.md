# Multi-step workflows (`x-mastro-workflow`)

OpenAPI describes single request/response operations. Some connector commands
are *stateful sequences* — e.g. Depop's "list an item": upload each photo, PUT
the bytes to a presigned URL, poll until processed, then create the listing,
with the numeric picture ids (derived from the upload slots) feeding the final
body.

`x-mastro-workflow` models that declaratively, in the OpenAPI doc. The command's
own path/method isn't called; its **steps** are.

## Shape

```yaml
/x-mastro/list:                 # synthetic path — the workflow wrapper
  post:
    operationId: list
    x-mastro-command: list
    x-mastro-args:              # workflow flags (no OpenAPI parameters of its own)
      - { name: photo, required: true, multiple: true }
      - { name: department, enum: [menswear, womenswear, ...] }
      - { name: variant-set,   # a DERIVED flag, looked up from other args
          x-mastro-resolve:
            from: "file:reference/categories.json"
            keyed: true
            value_path: size_set_us
            key_template: "${args.department}/${args.type}" }
    x-mastro-workflow:
      result: createListing     # which step's response the command returns
      steps:
        - id: slots
          operationId: uploadPicture
          foreach: "${args.photo}"      # run once per photo
          output: { path: url }         # keep response.url (the presigned slot)
        - id: uploads
          operationId: s3Put
          foreach: "${args.photo}"      # iterate photos so ${item} is the file…
          request:
            url: "${steps.slots.${index}}"  # …paired with its slot by index
            no_auth: true                   # presigned → no bearer/cookies
            body: "${file:item}"            # binary file body (this photo)
        - id: pictureIds                 # transform: slot URL → numeric id
          foreach: "${steps.slots}"
          value: "${item}"
          output: { extract: "/(\\d+)_[a-f0-9]+/P0\\.jpg", coerce: number }
        - id: createListing
          operationId: createListing
          request:
            body: { picture_ids: "${steps.pictureIds}", ... }
```

## Step model

Each step calls an operation (`operationId`) and stores its result under
`steps.<id>`. Modifiers:

- **`foreach: <list-template>`** — run once per element; results collected into a
  list. The current element is `${item}` (or `${<as>}` when `as:` is set), and
  its position is `${index}` — use `${index}` to pair this list with a parallel
  one (e.g. each photo with its upload slot: `${steps.slots.${index}}`).
- **`poll: { until, attempts, delay_ms }`** — repeat the request until `until`
  resolves truthy (e.g. `"${steps.batch.result.ready}"`). `until` is evaluated
  against the step's **raw** response, so it can reference any response field
  even when `output` extracts only part of it.
- **`request`** — per-step overrides: `url`, `method`, `body`, `headers`,
  `no_auth` (skip auth, for presigned URLs), `transport` (`direct` | `browser`),
  `form` (replay a server-rendered form as the body — see below).
- **`request.form: { html, selector, set, unset }`** — build an
  `application/x-www-form-urlencoded` body by replaying an HTML `<form>` from a
  prior step's response. `html` is a template (usually `"${steps.<id>}"`),
  `selector` picks the form (first match only — `querySelector` semantics, so
  duplicate-id pages like Amazon's buy boxes work), `set` overrides/adds fields
  (the clicked submit button, a JS-set flag), `unset` drops fields. The form is
  serialized exactly as a browser would submit it (named non-button controls,
  checked boxes only, selected option, textarea text), which captures a
  server-rendered CSRF token and hidden fields verbatim. Use for state changes
  gated behind a form (Amazon Buy Now → place-order). Mutually exclusive with
  `body`.
- **`output: { path, extract, coerce }`** — keep `response.<path>`; `extract`
  runs a regex and keeps the first capture group (e.g. pull a picture id from an
  S3 URL); `coerce: number` parses a numeric string into a JS number (so a later
  body sends it as a JSON number, not a string).
- **transform step (no `operationId`)** — makes no HTTP call; shapes its `value`
  (templated, defaults to the foreach `${item}`) through `output`. Use to derive
  data from a prior step — e.g. map slot URLs to numeric picture ids — without a
  round-trip:

  ```yaml
  - id: pictureIds
    foreach: "${steps.slots}"
    value: "${item}"
    output: { extract: "/(\\d+)_[a-f0-9]+/P0\\.jpg", coerce: number }
  ```

The workflow's `result:` names the step whose response the command returns (or a
dotted path into it, e.g. `createListing.slug`).

## Templates available in a workflow

- `${args.<flag>}` — a CLI flag value (`${args.brand}`)
- `${args.<flag>|<default>}` — with a literal fallback (`${args.currency|USD}`).
  The fallbacks `[]` and `{}` yield a real empty array / object, not the strings
  `"[]"` / `"{}"` — so an omitted repeatable flag becomes `[]` in the body.
- `${steps.<id>...}` — a prior step's result
- `${item}` / `${<as>}` / `${index}` — the current foreach element / its index
- `${uuid}` / `${now}` — generated per use
- `${file:<expr>}` — load the file at the resolved path as bytes (binary body)
- `${num:<expr>}` — resolve, then cast to a JS number, so a body field
  serializes as a JSON number (`${num:args.lat}` → `37.78`, not `"37.78"`)
- **nested** — an inner `${...}` inside another resolves first:
  `${steps.slots.${index}}` becomes `${steps.slots.0}` then the slot URL.

A whole-placeholder string (`"${steps.slots}"`) preserves the resolved value's
type (array/object/number); a mixed string interpolates to text. In a body
object, **keys are templated too** — `{ "${args.variant}": 1 }` → `{ "4": 1 }`,
and an entry whose key resolves empty is dropped (so a one-size item with no
variant yields `{}`).

## Deriving values from bundled data

`x-mastro-resolve` works against **bundled JSON files** (`from: "file:..."`), not
just live endpoints. With `keyed: true` it's a key→entry lookup; with
`key_template` the key is built from *other* args. This keeps reference-data
transforms (category → size set, department → gender) declarative — no
per-provider code. See `providers/depop/reference/`.

Derived args resolve in declaration order, so a `key_template` can reference an
earlier-derived arg. Depop chains two lookups for the size variant:
`(department/type) → variant-set`, then `(variant-set/size) → variant` (the
member id within the set), which becomes the `variants` map on the listing.

## Dry run

`--dry-run` builds and prints every planned request (method, URL, redacted
headers, body) **without sending anything**. Steps that would feed later steps
return placeholders, so the final body is fully inspectable. Always dry-run a new
workflow before running it live.
