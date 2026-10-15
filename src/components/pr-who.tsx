import { useContext } from "react"
import { whoIs } from "../lib/pr-detail"
import { PrPeople } from "./pr-people"

/** A login as the dialog shows it: yours marked "(you)", the PR's author with a chip. */
export function Who({ login, bold }: { login: string; bold?: boolean }) {
  const w = whoIs(login, useContext(PrPeople))
  const Name = bold ? "b" : "span"
  return (
    <>
      <Name className={w.you ? "pr-you" : undefined}>{login}</Name>
      {w.you && <span className="pr-faint"> (you{w.via ? ` · @${w.via}` : ""})</span>}
      {w.author && " "}
      {w.author && (
        <span className="pr-chip" title="Opened this pull request">
          author
        </span>
      )}
    </>
  )
}
