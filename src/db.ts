import Database from 'better-sqlite3';
import path from 'node:path';

import type { ExpLevelId } from './constants';

export interface UserSettings {
  chatId: number;
  category: string | null;
  expLevels: ExpLevelId[];
  isActive: boolean;
  lastJobLink: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserSettingsRow {
  chat_id: number;
  category: string | null;
  exp_levels: string;
  is_active: number;
  last_job_link: string | null;
  created_at: string;
  updated_at: string;
}

const databasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.resolve('./data.sqlite');

const db = new Database(databasePath);

db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id INTEGER PRIMARY KEY,
    category TEXT,
    exp_levels TEXT NOT NULL DEFAULT '[]',
    is_active INTEGER NOT NULL DEFAULT 1,
    last_job_link TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const userColumns = db.prepare('PRAGMA table_info(users)').all() as Array<{
  name: string;
}>;

if (!userColumns.some((column) => column.name === 'last_job_link')) {
  db.exec('ALTER TABLE users ADD COLUMN last_job_link TEXT');
}

const ensureUserStmt = db.prepare(
  `INSERT OR IGNORE INTO users (chat_id) VALUES (?)`,
);

const getUserStmt = db.prepare(
  `SELECT * FROM users WHERE chat_id = ?`,
) as Database.Statement<[number], UserSettingsRow | undefined>;

const upsertCategoryStmt = db.prepare(
  `
  INSERT INTO users (chat_id, category, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(chat_id) DO UPDATE SET
    category = excluded.category,
    updated_at = CURRENT_TIMESTAMP
`,
);

const upsertExpLevelsStmt = db.prepare(
  `
  INSERT INTO users (chat_id, exp_levels, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(chat_id) DO UPDATE SET
    exp_levels = excluded.exp_levels,
    updated_at = CURRENT_TIMESTAMP
`,
);

const setActiveStmt = db.prepare(
  `UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?`,
);

const setLastJobLinkStmt = db.prepare(
  `UPDATE users SET last_job_link = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?`,
);

const configuredUsersStmt = db.prepare(
  `SELECT * FROM users WHERE is_active = 1 AND category IS NOT NULL`,
);

function mapUser(row: UserSettingsRow): UserSettings {
  let parsedLevels: ExpLevelId[] = [];
  try {
    const raw = JSON.parse(row.exp_levels);
    if (Array.isArray(raw)) {
      parsedLevels = raw.filter(
        (value): value is ExpLevelId => typeof value === 'string',
      );
    }
  } catch {
    parsedLevels = [];
  }

  return {
    chatId: row.chat_id,
    category: row.category,
    expLevels: parsedLevels,
    isActive: row.is_active === 1,
    lastJobLink: row.last_job_link,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ensureUser(chatId: number): void {
  ensureUserStmt.run(chatId);
}

export function getUser(chatId: number): UserSettings | null {
  const row = getUserStmt.get(chatId);
  return row ? mapUser(row) : null;
}

export function saveCategory(chatId: number, category: string): void {
  upsertCategoryStmt.run(chatId, category);
}

export function saveExpLevels(chatId: number, expLevels: ExpLevelId[]): void {
  upsertExpLevelsStmt.run(chatId, JSON.stringify(expLevels));
}

export function setUserActive(chatId: number, isActive: boolean): void {
  setActiveStmt.run(isActive ? 1 : 0, chatId);
}

export function setLastJobLink(
  chatId: number,
  lastJobLink: string | null,
): void {
  setLastJobLinkStmt.run(lastJobLink, chatId);
}

export function getConfiguredUsers(): UserSettings[] {
  const rows = configuredUsersStmt.all() as UserSettingsRow[];
  return rows.map(mapUser).filter((user) => user.category);
}

export function closeDb(): void {
  db.close();
}
