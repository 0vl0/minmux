import { createContext } from "react"

/** The viewer's gh accounts, the one acting, and the PR's author: for marking names. */
export const PrPeople = createContext<{ mine: string[]; acting?: string; author?: string }>({
  mine: [],
})
