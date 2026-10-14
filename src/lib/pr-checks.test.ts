import { describe, expect, it } from "vitest"
import { checksRunning, parsePrChecks } from "./pr-checks"

const answer = (
  latest: unknown[],
  rollup: string | null,
  commits: unknown[] = [],
  total?: number,
) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          updatedAt: "t",
          latest: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: rollup ? { state: rollup, contexts: { nodes: latest } } : null,
                },
              },
            ],
          },
          commits: { totalCount: total ?? commits.length, nodes: commits },
        },
      },
    },
  })
const run = (name: string, status: string, conclusion: string | null, workflow = "CI") => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl: `https://ci/${name}`,
  checkSuite: { workflowRun: workflow ? { workflow: { name: workflow } } : null },
})

describe("parsePrChecks", () => {
  it("check runs and commit statuses: failed first, then running, then the rest", () => {
    const c = parsePrChecks(
      answer(
        [
          run("lint", "COMPLETED", "SUCCESS"),
          run("build", "IN_PROGRESS", null),
          run("test", "COMPLETED", "FAILURE"),
          {
            __typename: "StatusContext",
            context: "codecov",
            state: "SUCCESS",
            targetUrl: "https://cov",
          },
          run("docs", "COMPLETED", "SKIPPED", ""),
        ],
        "PENDING",
      ),
    )!
    expect(c.checks.map((x) => [x.name, x.state, x.workflow])).toEqual([
      ["test", "failed", "CI"],
      ["build", "running", "CI"],
      ["codecov", "passed", ""],
      ["lint", "passed", "CI"],
      ["docs", "skipped", ""],
    ])
    expect([c.state, checksRunning(c)]).toEqual(["running", true])
  })

  it("commits with their own state; the older ones counted", () => {
    const c = parsePrChecks(
      answer(
        [],
        "SUCCESS",
        [
          {
            commit: {
              abbreviatedOid: "abc1234",
              messageHeadline: "fix: x",
              committedDate: "2026-10-14T10:00:00Z",
              url: "https://c/abc",
              author: { name: "Q", user: { login: "q" } },
              statusCheckRollup: { state: "FAILURE" },
            },
          },
          {
            commit: {
              abbreviatedOid: "def5678",
              messageHeadline: "y",
              author: { name: "N", user: null },
            },
          },
        ],
        25,
      ),
    )!
    expect(c.commits.map((x) => [x.oid, x.author, x.state])).toEqual([
      ["abc1234", "q", "failed"],
      ["def5678", "N", null],
    ])
    expect([c.moreCommits, checksRunning(c)]).toEqual([23, false])
  })

  it("no checks; not an answer: null", () => {
    expect(parsePrChecks(answer([], null))!.checks).toEqual([])
    expect(parsePrChecks("nope")).toBeNull()
    expect(parsePrChecks(JSON.stringify({ data: { repository: null } }))).toBeNull()
  })
})
