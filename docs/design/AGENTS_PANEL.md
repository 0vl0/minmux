# Agents panel: one list, grouped like the sidebar

## Problem

The agents panel has two tabs that show the same sessions from two sides. **Live** lists every
agent session the board knows, one boxed block per pane, each with its sub-agents, worktrees and
processes always expanded. **Sessions** lists past sessions newest first, with search and agent
filters, and marks the ones open in a pane. To see what an agent is doing and what it did before,
you switch tabs; the Live tab grows long with a few busy panes; and nothing there follows the
sidebar's groups, which is how the panes themselves are organised.

## Goals

- One view: the agents in open panes first, grouped by sidebar group (one per tab), the active
  group on top; every other past session below, newest first.
- The pane you're in is highlighted, as in today's Live tab (its border).
- Each session is one line, collapsed by default; a `>` opens its details: what it is (folder,
  branch, tokens, session id), its sub-agent and worktree tree, and the processes it runs.
- Nothing lost from either tab: search, agent filters, "This folder", resume, go to pane,
  open a folder, left-running processes.
- No new polling: details that cost something (processes) are read only while open.

Not in scope: changing what the board or the Sessions listing know (hooks, readers, search),
Windows-specific behaviour (unchanged), a keyboard-driven tree (a later step if wanted).

## Layout

```
AGENTS                                         ×
[ Search conversations…                    ] ⟳
[Claude] [Codex] [OpenCode]   ☐ This folder

▾ minmux                                        ← the active group first
 ┌────────────────────────────────────────────┐
 │ > ■ support-codex-opencode   working   2m   │ ← the pane you're in (border)
 └────────────────────────────────────────────┘
   > ■ Fix flaky test           idle      5m
   > ■ old-run                  ended     1h    ← ended, its pane still open (dimmed)
▾ api
   > ■ epic-games               waiting   1m

LEFT RUNNING
   ~/w/api   node server.js  :5173 ↗

INACTIVE
   > · artistic-style-lab       ~/w/rts   1h
   > · mobile-connect           ~/w/term  4h
```

Expanded (one session):

```
 ┌────────────────────────────────────────────┐
 │ ▾ ■ support-codex-opencode   working   2m   │
 │     ~/workspace/term · main · ↑42k ↓8k      │ ← folder (opens a terminal), branch, tokens
 │     6986fe83 ⧉                              │ ← session id (copy)
 │     session · Bash                          │ ← the board's tree: root, sub-agents,
 │     ├ explore · src/lib                     │   worktrees, as today
 │     └ ⑂ feat/x · in                         │
 │     ▸ 3 processes · 12% CPU                 │ ← the process tree, as today
 └────────────────────────────────────────────┘
```

## Rules

- **Active**: a session in an open pane, whether its agent still runs or has ended there. This is
  what today's Live tab shows (the board's root sessions with a pane), plus a past session the
  Sessions listing already matches to an open pane (`panesFor`). An ended one is dimmed in its
  group; clicking it resumes it in that pane's split, as the Sessions tab does today.
- **Inactive**: every past session not in an open pane, newest first, as today's Sessions list.
- **Groups**: one per tab, named like the sidebar (`tabTitle`), in sidebar order with the active
  tab first. Only groups with at least one active session are shown. Clicking a group's header
  switches to that tab. Within a group: running sessions first (by the board's order), then
  ended ones (newest first).
- **Highlight**: the session(s) of the pane you're in get today's Live-tab border.
- **Collapsed row**: chevron, agent icon (in its agent's colour while it runs, muted otherwise),
  name, status (working, waiting, idle, ended), age; the session's colour tints the row as in
  today's Sessions tab. Clicking the row goes to its pane (running) or resumes it (ended,
  inactive); the chevron only expands.
- **Expanded**: folder (a link that opens a terminal there), branch, tokens, session id with copy,
  then the board's tree (sub-agents, worktrees) and the pane's process list for the pane's lead
  session, as today. An inactive session shows its folder, session id and first prompt.
- **Expanded state** lives in memory per session (a reload collapses everything). A session the
  board marks as needing attention (waiting) is never collapsed out of sight: its row shows the
  status regardless.
- **Search**: as in today's Sessions tab. While a query runs, the panel shows its results (open
  ones marked and highlighted the same way) instead of the groups. The agent filters and "This
  folder" apply to both sections.
- **Left running**: today's section, between the groups and the inactive list, shown only when
  something is left.

## Cost

The same data as today: the board (in memory), the Sessions listing (read when the panel is
shown, as now) and the process poll, which runs only for expanded rows (today: for open lists).
Collapsed rows read nothing extra. The process poll's rules don't change (2.5 s while a list is
open, the 10 s leftovers poll once an agent has run).

## Tests

The grouping and ordering (groups from tabs, active first, running before ended, active vs
inactive split, filters on both) are a pure function over the board, the tabs and the listing,
tested with fixtures. Component tests for expand and collapse, the highlight, clicks (go to pane,
resume, expand only on the chevron), and search replacing the groups. Real app: several groups
with running and ended agents, the highlight following focus, expanding a row shows its tree and
processes.

## Plan (one PR each, into `epic/agents-panel`)

1. **One list** (#160): the merged view (groups, active first, highlight, ended dimmed, left running,
   inactive list, search and filters), rows collapsed with a chevron that shows today's tree and
   process list. The Live and Sessions tabs go.
2. **Details** (#161): the info block in an expanded row (folder link, branch, tokens, session id; first
   prompt for inactive), and polish from using step 1.
