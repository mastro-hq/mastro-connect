# Multi-step workflows (`x-mastro-workflow`)

OpenAPI describes single request/response operations. Some connector commands
are *stateful sequences* — e.g. Depop's "list an item": upload each photo, PUT
the bytes to a presigned URL, poll until processed, then create the listing,
with picture ids from step 1 feeding the final body.

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
      result: createListing     # which step's result to return
      steps:
        - id: slots
          operationId: uploadPicture
          foreach: "${args.photo}"      # run once per photo
          as: photo
          output: { path: url }         # keep response.url as this step's result
        - id: uploads
          operationId: s3Put
          foreach: "${steps.slots}"
          request:
            url: "${item}"              # presigned URL from the prior step
            no_auth: true              # presigned → no bearer/cookies
            body: "${file:args.photo}" # binary file body
        - id: createListing
          operationId: createListing
          request:
            body: { picture_ids: "${steps.slots}", ... }
```

## Step model

Each step calls an operation (`operationId`) and stores its result under
`steps.<id>`. Modifiers:

- **`foreach: <list-template>`** — run once per element; results collected into a
  list. The current element is `${item}` (or `${<as>}`).
- **`poll: { until, attempts, delay_ms }`** — repeat the request until `until`
  resolves truthy (e.g. `"${steps.batch.result.ready}"`).
- **`request`** — per-step overrides: `url`, `method`, `body`, `headers`,
  `no_auth` (skip auth, for presigned URLs), `transport` (`direct` | `browser`).
- **`output: { path, extract }`** — keep `response.<path>`; `extract` runs a
  regex and keeps the first capture group (e.g. pull a picture id from an S3 URL).

## Templates available in a workflow

- `${args.<flag>}` — a CLI flag value (`${args.brand}`)
- `${args.<flag>|<default>}` — with a literal fallback (`${args.currency|USD}`)
- `${steps.<id>...}` — a prior step's result
- `${item}` / `${<as>}` — the current foreach element
- `${uuid}` / `${now}` — generated per use
- `${file:<expr>}` — load the file at the resolved path as bytes (binary body)

## Deriving values from bundled data

`x-mastro-resolve` works against **bundled JSON files** (`from: "file:..."`), not
just live endpoints. With `keyed: true` it's a key→entry lookup; with
`key_template` the key is built from *other* args. This keeps reference-data
transforms (category → size set, department → gender) declarative — no
per-provider code. See `providers/depop/reference/`.

## Dry run

`--dry-run` builds and prints every planned request (method, URL, redacted
headers, body) **without sending anything**. Steps that would feed later steps
return placeholders, so the final body is fully inspectable. Always dry-run a new
workflow before running it live.
