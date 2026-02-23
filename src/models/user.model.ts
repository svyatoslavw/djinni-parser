import type { ExpLevelId } from "../constants"

export interface IUser {
  chatId: number
  category: string | null
  expLevels: ExpLevelId[]
  isActive: boolean
  lastJobLink: string | null
  createdAt: string
  updatedAt: string
}
