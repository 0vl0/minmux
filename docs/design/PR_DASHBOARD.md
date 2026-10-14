# Pull requests dialog: a gh-dash in the terminal

Status: **proposed** · Scope: new `electron/pr-dashboard.ts` (gh calls, main), `src/lib/pr-dashboard.ts`
(parsing, status, stacks: pure), `src/components/pr-dialog.tsx`, a top-bar button, a ⌘K command

## Problem

Checking PRs means leaving the terminal for github.com: which of mine have reviews, which are
approved, behind, or failing CI; which wait for my review; what reviewers said, line by line.
`gh dash` answers this in a terminal, but in its own TUI, apart from the panes where the work
happens. minmux already runs `gh` for the sidebar's PR line (`electron/pane-git.ts`), so it
can show the same, and link it to the panes and the diff panel.

## Goals

1. **Three lists:** PRs I opened, PRs that request my review, and the focused pane's repo.
2. **Status at a glance:** draft / open / merged / closed, review decision (approved, changes
   requested, review required), who reviewed, behind its base or conflicting, CI.
3. **Every comment:** review threads (file, line, the diff hunk, resolved / outdated) and the
   conversation, in one place.
4. **Request reviewers:** from GitHub's suggestions and people / teams who can review the repo.
5. **Stacks and links:** PRs based on another PR's branch shown as a tree; PRs that mention
   each other listed in the detail.
6. **Performance:** no work while the dialog is closed; one request per refresh; nothing near
   the terminal hot path.

Non-goals (v1): writing comments, approving / merging, GitHub Enterprise hosts (`gh`'s default
host only), notifications.

## UI: a dialog

A large dialog (about 85 % of the window), opened from a **top-bar button** (visible, beside
Files / Changes / Agents) and a ⌘K command. Esc closes it; it remembers its tab and selection.
Terminals keep running behind it (no backdrop blur or animated transition: never animate
compositing over WebGL panes).

```
┌ Pull requests ─────────────────────────────────────────────── ⟳ 12 s ago  ✕ ┐
│ Mine (4) · Review requested (2) · vcmf/minmux (11)          [Include closed] │
├──────────────────────────────────────┬───────────────────────────────────────┤
│ ● #119 feat(sidebar): edits line     │ #119 feat(sidebar): show the checkout │
│   approved · CI ✓ · up to date · ⌂2  │ vcmf/minmux · feat/x → main · +1.5k   │
│ ◐ #118 fix(git): …                   │ Reviewers: alice ✓ bob (requested)    │
│   changes requested · behind main    │ [+ Request reviewer]                  │
│   └ #120 feat: stacked on #118       │ ── Comments (5, 2 unresolved) ──────  │
│ ○ #117 draft · CI running            │ src/app.tsx:445  ▸ hunk               │
│                                      │   alice: this awaits both …  [Open ↗] │
└──────────────────────────────────────┴───────────────────────────────────────┘
```

- **Left:** the tab's list, newest update first. Each row: state icon, number, title, then a
  status line (review decision, CI, behind / conflicts, comment count, `⌂n` = checked out in
  pane n). Stacked PRs are indented under their base PR.
- **Right:** the selected PR (step 2+): header, reviewers, body, comments.
- **Keys:** ↑/↓ or j/k move, Enter selects, `o` opens on GitHub, `r` refreshes, 1/2/3 switch
  tabs, Esc closes.
- **The repo tab** is the focused pane's repo (the sidebar's `from` checkout), named with its
  `owner/name`; a pin keeps another repo while the focus moves.

## Data: one GraphQL query per refresh

Through `gh api graphql` (the user's own login; minmux stores no token), in the focused pane's
environment (host, or its WSL distro, as `pane-git.ts` does). One query, three aliased
searches, so a refresh is a single process and a single request:

```graphql
query ($mine: String!, $review: String!, $repo: String!, $n: Int!) {
  mine: search(type: ISSUE, query: $mine, first: $n) {
    nodes {
      ...pr
    }
  }
  review: search(type: ISSUE, query: $review, first: $n) {
    nodes {
      ...pr
    }
  }
  repo: search(type: ISSUE, query: $repo, first: $n) {
    nodes {
      ...pr
    }
  }
  rateLimit {
    cost
    remaining
    resetAt
  }
}
fragment pr on PullRequest {
  id
  number
  title
  url
  state
  isDraft
  updatedAt
  author {
    login
  }
  repository {
    nameWithOwner
  }
  headRefName
  baseRefName
  headRepository {
    nameWithOwner
  }
  reviewDecision
  mergeStateStatus
  mergeable
  additions
  deletions
  comments {
    totalCount
  }
  reviewThreads {
    totalCount
  }
  latestOpinionatedReviews(first: 10) {
    nodes {
      author {
        login
      }
      state
    }
  }
  reviewRequests(first: 10) {
    nodes {
      requestedReviewer {
        ... on User {
          login
        }
        ... on Team {
          slug
        }
      }
    }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
        }
      }
    }
  }
}
```

- **Searches:** `is:pr is:open author:@me`, `is:pr is:open review-requested:@me`,
  `is:pr is:open repo:<owner/name>`, each `sort:updated-desc`, `$n` = 30. "Include closed"
  swaps `is:open` for `updated:>=<14 days ago>`.
- **The repo's `owner/name`:** `gh repo view --json nameWithOwner` in the pane's checkout root
  (gh resolves remotes and forks), cached per root. No GitHub remote: the tab is hidden.
- **Status mapping** (pure, `src/lib/pr-dashboard.ts`):
  - state: `MERGED` / `CLOSED` / `isDraft` → draft / open.
  - review: `reviewDecision` (`APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, none) plus
    each reviewer's latest opinionated review, and pending requests.
  - up to date: `mergeStateStatus` `BEHIND` → behind base; `DIRTY` → conflicts; `UNKNOWN`
    (GitHub computes it lazily) → shown as "…", never as a problem.
  - CI: the last commit's `statusCheckRollup.state` (success / failure / pending / none).
- **Checked out in a pane:** a PR whose number and repo match a pane's sidebar PR
  (`paneGit[pane].pr`) gets `⌂n`; clicking it focuses that pane.

## Refresh rules

- **Never while the dialog is closed** (and not while the window is hidden).
- **On open:** the last answer shows at once (with its age), and a refresh starts.
- **While open:** every 60 s, plus the ⟳ button; after an action (a reviewer added), that PR
  alone is fetched again.
- **One in flight.** Errors back off (60 s → 5 min); offline keeps the last lists with a note.
- **Budget:** `rateLimit` is read on every answer; under 10 % remaining, the timer pauses until
  `resetAt` (the button still works).

## Detail and comments (step 2)

Fetched when a PR is selected (one query), cached per PR `updatedAt`:

- `body`; `reviews` (author, state, body); `comments` (the conversation);
- `reviewThreads(first: 100)`: `isResolved`, `isOutdated`, `path`, `line`, and each comment's
  author, body, `createdAt`, `url`, `diffHunk`;
- `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT])` for links (step 4).

Rendering:

- Threads grouped by file, in diff order; unresolved first; resolved and outdated collapsed.
- Each thread shows the last lines of its `diffHunk`, so it reads without a checkout.
- **Open in editor** at `path:line` when the focused pane's checkout has that file (the
  existing editor action); **Open ↗** opens the comment on GitHub.
- Bodies are untrusted markdown: rendered as text with links and code blocks only, never as
  HTML.

## Reviewers (step 3)

- **Candidates:** `pullRequest.suggestedReviewers`, then a debounced (250 ms) search of
  `repository.assignableUsers(query:)`. GitHub lists only people who can review, so "same org"
  needs no check of our own. Teams: `organization.teams(query:)` when the owner is an org; if
  gh's token lacks `read:org`, teams are hidden with a hint (`gh auth refresh -s read:org`).
- **Add / remove:** `gh pr edit <n> --repo <owner/name> --add-reviewer <login|org/team>`
  (`--remove-reviewer`); an explicit click, never automatic. Only a login or `org/team` slug
  reaches gh. The PR's row is then fetched directly (search answers lag behind edits), and
  a later list answer older than it doesn't undo the change.
- **No `read:org`:** the teams query fails as a whole; it's asked again without teams, and
  teams aren't tried for 10 minutes.

## Stacks and links (step 4)

- **Stacks (free):** in one list, PR B is stacked on PR A when both are in the same repo and
  `B.baseRefName == A.headRefName`. The list renders a forest: each stack under its bottom PR,
  with connector lines; a PR whose base PR isn't in the list shows "on #N".
- **Links:** the detail lists "mentions" and "mentioned by" from the timeline (cross
  references, and closing links), each clickable within the dialog.
- **A graph view** (all PRs of the repo as nodes, stacks and links as edges) is a stretch goal.

## Performance and failure modes

- All gh calls run in main through the same launcher and limits as `pane-git.ts` (async
  `execFile`, at most 2 gh at once), on their own IPC channels, never on the PTY path.
- One query per refresh, only while the dialog is open: on the order of 1–3 GraphQL points
  per refresh against 5 000 an hour.
- **gh missing / logged out:** the dialog shows the sidebar's hint (`withGhHint`), no polling.
- **Non-GitHub remotes, GitHub Enterprise:** the repo tab is hidden; the other two tabs use
  gh's default host.
- **Big answers:** lists capped at 30 per tab, threads at 100, comments per thread at 50.

## Plan (one PR each)

1. **The dialog, read-only** (#120): main module + IPC, parsing and status mapping (tests on recorded
   JSON fixtures), the three tabs, refresh rules, open on GitHub, `⌂n` pane links.
2. **Detail** (#121): body, reviews, threads grouped by file with hunks, open in editor / on GitHub.
3. **Reviewers** (#122): the picker (suggestions, search, teams) and add / remove.
4. **Stacks and links** (#123): the stack forest in the lists, mentions in the detail.

Each step: unit tests for the pure parts, a real-app check with the `run-minmux` driver (gh
stubbed on PATH with recorded answers, so tests never touch the user's GitHub account).
