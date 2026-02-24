import type { ExpLevelId } from "../common/constants"

export interface IUser {
  chatId: number
  categories: string[]
  expLevels: ExpLevelId[]
  isActive: boolean
  lastJobLink: string | null
  createdAt: string
  updatedAt: string
}
