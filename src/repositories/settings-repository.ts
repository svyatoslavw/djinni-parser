import Database from "better-sqlite3"
import path from "node:path"

import type { IUser } from "@/models"
import { ALL_CATEGORIES_VALUE, type ExpLevelId } from "../common/constants"

interface IUserRow {
  chat_id: number
  category: string | null
  exp_levels: string
  is_active: number
  last_job_link: string | null
  created_at: string
  updated_at: string
}

export class SettingsRepository {
  private readonly db: Database.Database

  private readonly ensureUserStmt: Database.Statement
  private readonly getUserStmt: Database.Statement<[number], IUserRow | undefined>
  private readonly upsertCategoryStmt: Database.Statement
  private readonly upsertExpLevelsStmt: Database.Statement
  private readonly setActiveStmt: Database.Statement
  private readonly setLastJobLinkStmt: Database.Statement
  private readonly configuredUsersStmt: Database.Statement

  public constructor() {
    const databasePath = process.env.DATABASE_PATH
      ? path.resolve(process.env.DATABASE_PATH)
      : path.resolve("./data.sqlite")

    this.db = new Database(databasePath)
    this.db.pragma("journal_mode = WAL")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        chat_id INTEGER PRIMARY KEY,
        category TEXT,
        exp_levels TEXT NOT NULL DEFAULT '[]',
        is_active INTEGER NOT NULL DEFAULT 1,
        last_job_link TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)

    const userColumns = this.db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>

    if (!userColumns.some((column) => column.name === "last_job_link")) {
      this.db.exec("ALTER TABLE users ADD COLUMN last_job_link TEXT")
    }

    this.ensureUserStmt = this.db.prepare(`INSERT OR IGNORE INTO users (chat_id) VALUES (?)`)

    this.getUserStmt = this.db.prepare(
      `SELECT * FROM users WHERE chat_id = ?`
    ) as Database.Statement<[number], IUserRow | undefined>

    this.upsertCategoryStmt = this.db.prepare(`
      INSERT INTO users (chat_id, category, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id) DO UPDATE SET
        category = excluded.category,
        updated_at = CURRENT_TIMESTAMP
    `)

    this.upsertExpLevelsStmt = this.db.prepare(`
      INSERT INTO users (chat_id, exp_levels, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id) DO UPDATE SET
        exp_levels = excluded.exp_levels,
        updated_at = CURRENT_TIMESTAMP
    `)

    this.setActiveStmt = this.db.prepare(
      `UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?`
    )

    this.setLastJobLinkStmt = this.db.prepare(
      `UPDATE users SET last_job_link = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?`
    )

    this.configuredUsersStmt = this.db.prepare(
      `SELECT * FROM users WHERE is_active = 1 AND category IS NOT NULL`
    )
  }

  public ensureUser(chatId: number): void {
    this.ensureUserStmt.run(chatId)
  }

  public getUser(chatId: number): IUser | null {
    const row = this.getUserStmt.get(chatId)
    return row ? this.mapUser(row) : null
  }

  public getConfiguredUsers(): IUser[] {
    const rows = this.configuredUsersStmt.all() as IUserRow[]
    return rows.map((row) => this.mapUser(row)).filter((user) => user.categories.length > 0)
  }

  public saveCategories(chatId: number, categories: string[]): void {
    const normalized = this.normalizeCategories(categories)
    const payload = normalized.length > 0 ? JSON.stringify(normalized) : null
    this.upsertCategoryStmt.run(chatId, payload)
  }

  public saveExpLevels(chatId: number, expLevels: ExpLevelId[]): void {
    this.upsertExpLevelsStmt.run(chatId, JSON.stringify(expLevels))
  }

  public setUserActive(chatId: number, isActive: boolean): void {
    this.setActiveStmt.run(isActive ? 1 : 0, chatId)
  }

  public setLastJobLink(chatId: number, lastJobLink: string | null): void {
    this.setLastJobLinkStmt.run(lastJobLink, chatId)
  }

  private mapUser(row: IUserRow): IUser {
    let parsedLevels: ExpLevelId[] = []

    try {
      const raw = JSON.parse(row.exp_levels)
      if (Array.isArray(raw)) {
        parsedLevels = raw.filter((value): value is ExpLevelId => typeof value === "string")
      }
    } catch {
      parsedLevels = []
    }

    const categories = this.parseCategories(row.category)

    return {
      chatId: row.chat_id,
      categories,
      expLevels: parsedLevels,
      isActive: row.is_active === 1,
      lastJobLink: row.last_job_link,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private parseCategories(rawValue: string | null): string[] {
    if (!rawValue) return []

    try {
      const parsed = JSON.parse(rawValue) as unknown
      if (Array.isArray(parsed)) {
        const categories = parsed.filter((value): value is string => typeof value === "string")
        return this.normalizeCategories(categories)
      }

      if (typeof parsed === "string") {
        return this.normalizeCategories([parsed])
      }
    } catch {}

    return this.normalizeCategories([rawValue])
  }

  private normalizeCategories(categories: Iterable<string>): string[] {
    const normalized = Array.from(
      new Set(
        Array.from(categories)
          .map((value) => value.trim())
          .filter(Boolean)
      )
    )

    if (normalized.includes(ALL_CATEGORIES_VALUE)) {
      return [ALL_CATEGORIES_VALUE]
    }

    return normalized
  }
}
