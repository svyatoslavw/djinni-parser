import { SettingsRepository } from "@/repositories"
import { FeedPollerService, RssFeedService } from "@/services"
import { Formatter, Logger } from "@/utils"
import { asClass, asValue, createContainer, InjectionMode } from "awilix"
import { Bot } from "grammy"
import { BotApp } from "."
import { TELEGRAM_BOT_TOKEN } from "../common"

export const createBaseContainer = () => {
  const container = createContainer({ injectionMode: InjectionMode.PROXY })

  container.register({
    telegramBotToken: asValue(TELEGRAM_BOT_TOKEN),
    logger: asClass(Logger).singleton(),
    settingsRepository: asClass(SettingsRepository).singleton(),
    rssFeedService: asClass(RssFeedService).singleton(),
    formatter: asClass(Formatter).singleton(),
    feedPollerService: asClass(FeedPollerService).singleton()
  })

  return container
}

export const createBotContainer = () => {
  const container = createBaseContainer()
  container.register({
    bot: asValue(new Bot(TELEGRAM_BOT_TOKEN)),
    botApp: asClass(BotApp).singleton()
  })
  return container
}
