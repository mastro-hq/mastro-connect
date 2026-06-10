---
name: mastro-linkedin-profile
description: Read a LinkedIn member or company profile from the command line via the mastro CLI. Use when the user wants to look up someone's or a company's LinkedIn profile ("what's on Bill Gates' LinkedIn", "pull up Stripe's company page", "read this person's experience"). Read-only.
---

# Read a LinkedIn profile

Agent-facing playbook for reading a member or company profile via `mastro`. If
`mastro` is not on PATH, invoke it as `npx -y mastro-connect`.

## When to use

The user wants to read a specific LinkedIn **member** or **company** profile —
their headline, experience, education, or the company's industry, size, and
followers. You need the slug, which comes straight from the LinkedIn URL: a
member's `publicId` is the `/in/<publicId>` part, a company's `universalName` is
the `/company/<universalName>` part. There is no `search` command (LinkedIn
moved search off the API — see the provider README), so the user must supply the
profile URL or slug.

## ⚠️ Account-risk caveat (tell the user once)

Reading profiles via automation violates LinkedIn's User Agreement and can get
the **signed-in account** restricted or banned. It's a read call (lowest-risk),
capped to 10 req/min, but keep it human-paced — don't bulk-scrape profiles.

## Preconditions

- `mastro login linkedin` has been run (`mastro status --json` →
  `linkedin.state == "active"`). If absent, ask the user to run it.
- Replay runs inside a logged-in linkedin.com tab via the mastro extension.

## Commands

```bash
mastro linkedin profile <publicId> --json        # a member, by /in/<publicId> slug
mastro linkedin company <universalName> --json   # a company, by /company/<name> slug
```

- **profile** — `<publicId>` is the slug in `linkedin.com/in/<publicId>` (e.g.
  `williamhgates`). Take it from the member's profile URL.
- **company** — `<universalName>` is the slug in
  `linkedin.com/company/<universalName>` (e.g. `microsoft`). Take it from the
  company page URL.

Run `mastro linkedin profile --help` / `company --help` for the live flags.

## Reading results

JSON from LinkedIn's Voyager `identity/dash/profiles` (member) and
`organization/companies` (company) endpoints — LinkedIn's own shapes, not
normalized by mastro.

- **member** — name, headline, location, summary, and the position / education /
  skills sections the profile page renders. The response is the normalized+json
  envelope (entities referenced by URN); read it defensively — sections are
  nested and not all members fill every one.
- **company** — name, tagline, industry, headquarters, employee-count range,
  follower count, website.

## Tips

- `profile`/`company` need the exact slug from the URL, not a display name.
  Ask the user for the LinkedIn URL if they only gave you a name.
- **A thin/empty member profile** usually means LinkedIn rolled the Voyager
  `decorationId` (which fields the response includes) — see the drift notes in
  the provider README to re-capture it.
- **401 on everything** → `li_at` expired; `mastro login linkedin` again.
- **404** → no member/company with that slug (or the slug is wrong — confirm it
  from the `/in/` or `/company/` URL).
