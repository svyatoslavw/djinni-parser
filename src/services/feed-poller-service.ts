import { Api, GrammyError } from "grammy"

import { SettingsRepository } from "@/repositories"
import { Formatter, Logger } from "@/utils"
import { RssFeedService } from "./rss-feed-service"

interface FeedPollerServiceDependencies {
  logger: Logger
  settingsRepository: SettingsRepository
  rssFeedService: RssFeedService
  formatter: Formatter
  telegramBotToken: string
}

export class FeedPollerService {
  private readonly logger: Logger
  private readonly settingsRepository: SettingsRepository
  private readonly rssFeedService: RssFeedService
  private readonly formatter: Formatter
  private readonly telegramApi: Api

  private pollIsRunning = false

  public constructor({
    logger,
    settingsRepository,
    rssFeedService,
    formatter,
    telegramBotToken
  }: FeedPollerServiceDependencies) {
    this.logger = logger
    this.settingsRepository = settingsRepository
    this.rssFeedService = rssFeedService
    this.formatter = formatter
    this.telegramApi = new Api(telegramBotToken)
  }

  public async refreshLastPublication(chatId: number): Promise<void> {
    const user = this.settingsRepository.getUser(chatId)
    if (!user || user.categories.length === 0) {
      return
    }

    try {
      const rssUrls = this.rssFeedService.buildRssUrls(user.categories, user.expLevels)
      const jobs = await this.rssFeedService.fetchJobsForCategories(user.categories, user.expLevels)
      const latestLink = this.getLatestLink(jobs)

      if (latestLink) {
        this.settingsRepository.setLastJobLink(chatId, latestLink)
      }

      this.logger.info(
        `prime chat=${chatId} urls=${rssUrls.join(",")} jobs=${jobs.length} latest_link=${latestLink ?? "none"}`
      )
    } catch (error) {
      this.logger.error(`Prime feed failed for chat ${chatId}: ${error}`)
    }
  }

  public async processUserFeed(chatId: number): Promise<number> {
    const user = this.settingsRepository.getUser(chatId)
    if (!user || !user.isActive || user.categories.length === 0) {
      return 0
    }

    const rssUrls = this.rssFeedService.buildRssUrls(user.categories, user.expLevels)
    const jobs = await this.rssFeedService.fetchJobsForCategories(user.categories, user.expLevels)
    const latestLink = this.getLatestLink(jobs)

    if (!latestLink) {
      this.logger.info(`poll chat=${chatId} urls=${rssUrls.join(",")} jobs=0 latest_link=none sent=0`)
      return 0
    }

    const previousLink = user.lastJobLink ? this.normalizeLink(user.lastJobLink) : null
    if (!previousLink) {
      this.settingsRepository.setLastJobLink(chatId, latestLink)
      this.logger.info(
        `poll chat=${chatId} init urls=${rssUrls.join(",")} jobs=${jobs.length} latest_link=${latestLink}`
      )
      return 0
    }

    const anchorIndex = jobs.findIndex((job) => this.normalizeLink(job.link) === previousLink)
    if (anchorIndex === 0) {
      this.logger.info(
        `poll chat=${chatId} urls=${rssUrls.join(",")} jobs=${jobs.length} previous_link=${previousLink} latest_link=${latestLink} sent=0`
      )
      return 0
    }

    if (anchorIndex === -1) {
      this.settingsRepository.setLastJobLink(chatId, latestLink)
      this.logger.info(
        `poll chat=${chatId} urls=${rssUrls.join(",")} anchor_missing previous_link=${previousLink} latest_link=${latestLink} jobs=${jobs.length} sent=0`
      )
      return 0
    }

    const newJobs = jobs.slice(0, anchorIndex).reverse()
    let sent = 0

    for (const job of newJobs) {
      try {
        await this.telegramApi.sendMessage(chatId, this.formatter.formatJobMessage(job), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true }
        })
        sent += 1
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 403) {
          this.settingsRepository.setUserActive(chatId, false)
        }
        throw error
      }
    }

    this.settingsRepository.setLastJobLink(chatId, latestLink)
    this.logger.info(
      `poll chat=${chatId} urls=${rssUrls.join(",")} jobs=${jobs.length} previous_link=${previousLink} latest_link=${latestLink} new_jobs=${newJobs.length} sent=${sent}`
    )

    return sent
  }

  public async pollAllUsers(): Promise<void> {
    if (this.pollIsRunning) {
      this.logger.info("poll tick skipped: previous cycle is still running")
      return
    }

    this.pollIsRunning = true
    try {
      const users = this.settingsRepository.getConfiguredUsers()
      this.logger.info(`poll tick started: users=${users.length}`)

      for (const user of users) {
        try {
          await this.processUserFeed(user.chatId)
        } catch (error) {
          this.logger.error(`Polling failed for chat ${user.chatId}: ${error}`)
        }
      }

      this.logger.info("poll tick finished")
    } finally {
      this.pollIsRunning = false
    }
  }

  private normalizeLink(link: string): string {
    return link.trim().replace(/\/$/, "")
  }

  private getLatestLink(jobs: Array<{ link: string }>): string | null {
    const link = jobs[0]?.link
    return link ? this.normalizeLink(link) : null
  }
}
