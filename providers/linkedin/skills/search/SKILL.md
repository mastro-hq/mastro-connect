---
name: mastro-linkedin-search
description: Search LinkedIn for people by keyword from the command line via the mastro CLI. Use when the user wants to find people on LinkedIn ("find react engineers in Berlin on LinkedIn", "search LinkedIn for the CEO of Acme", "who works at Stripe in design"). Returns name, headline, location, and profile slug. Read-only, first page only, higher account-risk than a profile read.
---

# Search LinkedIn for people

Agent-facing playbook for the `search-people` command. If `mastro` is not on
PATH, invoke it as `npx -y mastro-connect`.

## When to use

The user wants to **find** people on LinkedIn by keyword (name, title, company,
or a mix) rather than read one known profile. Each result gives name, headline,
location, connection distance, the profile URL, and the `publicId` slug — feed
that slug to the `profile` command (the `mastro-linkedin-profile` skill) for the
full record.

Use `profile`/`company` instead when the user already has a specific person or
company URL/slug; search is for discovery.

## ⚠️ Account-risk caveat (tell the user before running)

This is the **higher-risk** LinkedIn command. A profile read is "open one page";
a keyword search is the classic *scraping* pattern LinkedIn's anti-automation
heuristics watch for most, and it surfaces members the user didn't already know.
It's still read-only, but:

- Run it **occasionally and by hand**, never in a loop or batch.
- The risk lands on the **signed-in account** — restriction or ban for automation
  is real and behavioral (velocity, robotic timing), not just volume.
- Only what the **first results page renders inline** is available by design
  (the top few; the rest lazy-load on scroll). Don't ask for or expect
  pagination.

If the user wants to bulk-collect people, stop and tell them that's exactly what
gets accounts banned.

## Preconditions

- `mastro login linkedin` has been run (`mastro status --json` →
  `linkedin.state == "active"`). If absent, ask the user to run it.
- Replay runs inside a logged-in linkedin.com tab via the mastro extension.

## Command

```bash
mastro linkedin search-people --keywords "react engineer berlin" --json
```

- `--keywords` is the free-text query, exactly as typed in LinkedIn's search box
  (names, titles, companies, or a combination). Required.

Run `mastro linkedin search-people --help` for the live flags.

## Reading results

`--json` returns an array of people, each:

```json
{
  "name": "Ada Lovelace",
  "headline": "Mathematician at Analytical Engine Co.",
  "location": "London, England, United Kingdom",
  "distance": "• 3rd+",
  "url": "https://www.linkedin.com/in/ada-lovelace/",
  "publicId": "ada-lovelace"
}
```

- **publicId** is the `/in/<publicId>` slug — hand it to `mastro linkedin profile
  <publicId>` to read the full profile.
- **distance** is the connection degree badge ("• 1st", "• 2nd", "• 3rd+").
- Fields can be `null` when a card omits them (e.g. a private headline).

This command does NOT hit LinkedIn's Voyager JSON API — search moved to a
server-driven-UI layer, so the connector replays the search page POST and decodes
the React-Server-Components (Flight) tree. You don't need to know that to use it.

## Tips

- An **empty array with a successful run** usually means LinkedIn changed the
  search component tree, not that there were no matches — mention the provider
  README "Status & drift" note to the user if a clearly-valid query returns `[]`.
- **A 4xx** → either the session expired (`mastro login linkedin` again) or the
  SDUI deploy moved on (re-capture; see the README).
- To go from a search hit to a full profile: take its `publicId` and run
  `mastro linkedin profile <publicId>` (the `mastro-linkedin-profile` skill).
