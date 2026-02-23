import type { ExpLevelId } from "../constants"

export interface IUser {
  chatId: number
  categories: string[]
  expLevels: ExpLevelId[]
  isActive: boolean
  lastJobLink: string | null
  createdAt: string
  updatedAt: string
}
