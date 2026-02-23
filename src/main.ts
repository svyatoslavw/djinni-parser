import "dotenv/config"

import { asClass, asValue, createContainer, InjectionMode } from "awilix"
import { Bot } from "grammy"

import { BotApp } from "@/app"
import { SettingsRepository } from "@/repositories"
import { RssFeedService } from "@/services"
import { Formatter, Logger } from "@/utils"

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required")
}

const pollIntervalMs = Number.parseInt(process.env.POLL_INTERVAL_MS ?? "180000", 10)

const container = createContainer({
  injectionMode: InjectionMode.PROXY
})

container.register({
  bot: asValue(new Bot(token)),
  pollIntervalMs: asValue(pollIntervalMs),
  logger: asClass(Logger).singleton(),
  settingsRepository: asClass(SettingsRepository).singleton(),
  rssFeedService: asClass(RssFeedService).singleton(),
  formatter: asClass(Formatter).singleton(),
  botApp: asClass(BotApp).singleton()
})

container.resolve<BotApp>("botApp").start()
