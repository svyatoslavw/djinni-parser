import "dotenv/config"

export type AppMode = "BOT" | "WORKER"

const getRequired = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }

  return value
}

const getNumber = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (!raw) return fallback

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback

  return parsed
}

export const TELEGRAM_BOT_TOKEN = getRequired("TELEGRAM_BOT_TOKEN")
export const APP_MODE: AppMode = process.env.APP_MODE === "WORKER" ? "WORKER" : "BOT"
export const POLL_INTERVAL_MS = getNumber("POLL_INTERVAL_MS", 180000)
export const WORKER_RESTART_DELAY_MS = getNumber("WORKER_RESTART_DELAY_MS", 3000)
