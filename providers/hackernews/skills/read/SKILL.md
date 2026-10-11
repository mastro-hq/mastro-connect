---
name: mastro-hackernews-read
description: Read Hacker News through mastro — the front page, any item (story/comment/job/poll) by id, or a user's profile. Use when the user asks what's on HN, wants a story or thread looked up, or asks about an HN user. No login needed.
---

# Hacker News (example connector)

Public, read-only — no `mastro login` required.

```bash
mastro hackernews top --limit 10 --json     # front page, full story objects
mastro hackernews item --id 8863 --json     # one item; comments are in `kids`
mastro hackernews user --id pg --json       # karma, about, submitted ids
```

- `top` returns stories in rank order; each has `title`, `url`, `score`,
  `by`, `descendants` (comment count) and `kids` (top-level comment ids).
- To read a thread, fetch the story, then `item --id <kid>` for the comments
  you need. Don't walk a whole large thread unless asked.
- Times are Unix seconds.
