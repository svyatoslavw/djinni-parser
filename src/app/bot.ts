import { GrammyError, HttpError, InlineKeyboard, type Bot, type Context } from "grammy"

import type { DjinniJob } from "@/models"
import { SettingsRepository } from "@/repositories"
import { RssFeedService } from "@/services"
import { Formatter, Logger } from "@/utils"
import {
  ALL_CATEGORIES_LABEL,
  ALL_CATEGORIES_VALUE,
  DJINNI_CATEGORIES,
  EXP_LEVELS,
  type ExpLevelId
} from "../constants"

interface BotAppDependencies {
  bot: Bot
  logger: Logger
  settingsRepository: SettingsRepository
  rssFeedService: RssFeedService
  formatter: Formatter
  pollIntervalMs: number
  categoryPageSize: number
}

export class BotApp {
  private readonly expDrafts = new Map<number, Set<ExpLevelId>>()
  private pollIsRunning = false

  private readonly bot: Bot
  private readonly logger: Logger
  private readonly settingsRepository: SettingsRepository
  private readonly rssFeedService: RssFeedService
  private readonly formatter: Formatter
  private readonly pollIntervalMs: number
  private readonly categoryPageSize: number

  public constructor({
    bot,
    logger,
    settingsRepository,
    rssFeedService,
    formatter,
    pollIntervalMs,
    categoryPageSize
  }: BotAppDependencies) {
    this.bot = bot
    this.logger = logger
    this.settingsRepository = settingsRepository
    this.rssFeedService = rssFeedService
    this.formatter = formatter
    this.pollIntervalMs = pollIntervalMs
    this.categoryPageSize = categoryPageSize
  }

  public start(): void {
    this.registerHandlers()
    this.registerErrorHandler()

    setInterval(() => {
      void this.pollAllUsers()
    }, this.pollIntervalMs)

    void this.pollAllUsers()

    this.bot.start({
      onStart: ({ username }) => {
        this.logger.info(`Bot @${username} started. Poll interval: ${this.pollIntervalMs}ms`)
      }
    })
  }

  private registerHandlers(): void {
    this.bot.command("start", async (ctx) => {
      const chatId = ctx.chat?.id
      if (!chatId) {
        return
      }

      this.settingsRepository.ensureUser(chatId)

      if (!this.hasFullSettings(chatId)) {
        await ctx.reply(
          "Привіт! Я парсю Djinni RSS та надсилаю нові вакансії. Почнемо з вибору категорії.",
          { reply_markup: new InlineKeyboard().text("Оберіть категорію", "cat:open") }
        )
        return
      }

      await this.renderSettings(ctx, true)
    })

    this.bot.command("settings", async (ctx) => {
      const chatId = ctx.chat?.id
      if (!chatId) {
        return
      }

      this.settingsRepository.ensureUser(chatId)
      await this.renderSettings(ctx, true)
    })

    this.bot.callbackQuery("noop", async (ctx) => {
      await ctx.answerCallbackQuery()
    })

    this.bot.callbackQuery("menu:settings", async (ctx) => {
      await ctx.answerCallbackQuery()
      await this.renderSettings(ctx)
    })

    this.bot.callbackQuery("settings:toggle", async (ctx) => {
      const chatId = ctx.chat?.id
      if (!chatId) {
        await ctx.answerCallbackQuery()
        return
      }

      this.settingsRepository.ensureUser(chatId)
      const user = this.settingsRepository.getUser(chatId)
      const next = !(user?.isActive ?? true)
      this.settingsRepository.setUserActive(chatId, next)

      await ctx.answerCallbackQuery({
        text: next ? "Сповіщення увімкнено" : "Сповіщення на паузі"
      })
      await this.renderSettings(ctx)
    })

    this.bot.callbackQuery("poll:now", async (ctx) => {
      const chatId = ctx.chat?.id
      if (!chatId) {
        await ctx.answerCallbackQuery()
        return
      }

      if (!this.hasFullSettings(chatId)) {
        await ctx.answerCallbackQuery({
          text: "Спочатку оберіть категорію",
          show_alert: true
        })
        return
      }

      await ctx.answerCallbackQuery({ text: "Перевіряю RSS..." })

      try {
        const sentCount = await this.processUserFeed(chatId)
        await ctx.reply(
          sentCount > 0 ? `Надіслано вакансій: ${sentCount}` : "Нових вакансій поки немає."
        )
      } catch {
        await ctx.reply("Не вдалося отримати RSS. Спробуйте ще раз пізніше.")
      }
    })

    this.bot.callbackQuery("cat:open", async (ctx) => {
      const chatId = ctx.chat?.id
      if (!chatId) {
        await ctx.answerCallbackQuery()
        return
      }

      this.settingsRepository.ensureUser(chatId)
      await ctx.answerCallbackQuery()
      await this.renderCategoryPicker(ctx, 0)
    })

    this.bot.callbackQuery(/^cat:page:(\d+)$/, async (ctx) => {
      const page = Number.parseInt(String(ctx.match[1]), 10)

      await ctx.answerCallbackQuery()
      await this.renderCategoryPicker(ctx, page)
    })

    this.bot.callbackQuery("cat:set_all", async (ctx) => {
      const chatId = ctx.chat?.id
      if (!chatId) {
        await ctx.answerCallbackQuery()
        return
      }

      this.settingsRepository.saveCategory(chatId, ALL_CATEGORIES_VALUE)
      await ctx.answerCallbackQuery({ text: `Категорія: ${ALL_CATEGORIES_LABEL}` })

      await this.primeCurrentFeed(chatId)
      await this.renderSettings(ctx)
    })

    this.bot.callbackQuery(/^cat:set:(\d+)$/, async (ctx) => {
      const chatId = ctx.chat?.id
      if (!chatId) {
        await ctx.answerCallbackQuery()
        return
      }

      const index = Number.parseInt(ctx.match[1], 10)
      const category = DJINNI_CATEGORIES[index]
      if (!category) {
        await ctx.answerCallbackQuery({
          text: "Категорію не знайдено",
          show_alert: true
        })
        return
      }

      this.settingsRepository.saveCategory(chatId, category)
      await ctx.answerCallbackQuery({
        text: `Категорія: ${this.formatter.formatCategoryLabel(category)}`
      })

      await this.primeCurrentFeed(chatId)
      await this.renderSettings(ctx)
    })

    this.bot.callbackQuery("exp:open", async (ctx) => {
      const chatId = ctx.chat?.id
      if (!chatId) {
        await ctx.answerCallbackQuery()
        return
      }

      this.settingsRepository.ensureUser(chatId)
      this.expDrafts.set(chatId, new Set(this.settingsRepository.getUser(chatId)?.expLevels ?? []))

      await ctx.answerCallbackQuery()
      await this.renderExpPicker(ctx)
    })

    this.bot.callbackQuery(/^exp:toggle:(.+)$/, async (ctx) => {
      const chatId = ctx.chat?.id
      if (!chatId) {
        await ctx.answerCallbackQuery()
        return
      }

      const level = ctx.match[1] as ExpLevelId
      if (!EXP_LEVELS.some((item) => item.id === level)) {
        await ctx.answerCallbackQuery({
          text: "Невідомий тип досвіду",
          show_alert: true
        })
        return
      }

      const draft = this.getDraft(chatId)
      if (draft.has(level)) {
        draft.delete(level)
      } else {
        draft.add(level)
      }

      await ctx.answerCallbackQuery()
      await this.renderExpPicker(ctx)
    })

    this.bot.callbackQuery("exp:all", async (ctx) => {
      const chatId = ctx.chat?.id
      if (!chatId) {
        await ctx.answerCallbackQuery()
        return
      }

      const draft = this.getDraft(chatId)
      draft.clear()
      for (const level of EXP_LEVELS) {
        draft.add(level.id)
      }

      await ctx.answerCallbackQuery({ text: "Вибрано всі значення" })
      await this.renderExpPicker(ctx)
    })

    this.bot.callbackQuery("exp:none", async (ctx) => {
      const chatId = ctx.chat?.id
      if (!chatId) {
        await ctx.answerCallbackQuery()
        return
      }

      const draft = this.getDraft(chatId)
      draft.clear()

      await ctx.answerCallbackQuery({ text: "Вибір очищено" })
      await this.renderExpPicker(ctx)
    })

    this.bot.callbackQuery("exp:save", async (ctx) => {
      const chatId = ctx.chat?.id
      if (!chatId) {
        await ctx.answerCallbackQuery()
        return
      }

      const draft = this.sortExpLevels(this.getDraft(chatId))
      this.settingsRepository.saveExpLevels(chatId, draft)
      this.expDrafts.delete(chatId)

      if (this.hasFullSettings(chatId)) {
        await this.primeCurrentFeed(chatId)
      }

      await ctx.answerCallbackQuery({
        text: draft.length > 0 ? "Налаштування досвіду збережено" : "Фільтр досвіду вимкнено"
      })
      await this.renderSettings(ctx)
    })

    this.bot.on("message:text", async (ctx) => {
      await ctx.reply(
        "Доступні команди:\n/start - старт і швидке налаштування\n/settings - змінити категорію/досвід",
        { reply_markup: this.buildSettingsKeyboard(ctx.chat.id) }
      )
    })
  }

  private registerErrorHandler(): void {
    this.bot.catch((err) => {
      const ctx = err.ctx
      this.logger.error(`Update ID: ${ctx.update.update_id}`)

      const e = err.error
      if (e instanceof GrammyError) {
        this.logger.error(`Grammy error: ${e.description} (${e.error_code})`)
        return
      }

      if (e instanceof HttpError) {
        this.logger.error(e.message)
        return
      }

      this.logger.error(JSON.stringify(e))
    })
  }

  private normalizeLink(link: string): string {
    return link.trim().replace(/\/$/, "")
  }

  private sortExpLevels(levels: Iterable<ExpLevelId>): ExpLevelId[] {
    const set = new Set(levels)
    return EXP_LEVELS.map((item) => item.id).filter((id) => set.has(id))
  }

  private categoryForRss(category: string | null): string | null {
    if (!category || category === ALL_CATEGORIES_VALUE) {
      return null
    }

    return category
  }

  private getDraft(chatId: number): Set<ExpLevelId> {
    const current = this.expDrafts.get(chatId)
    if (current) {
      return current
    }

    const user = this.settingsRepository.getUser(chatId)
    const seed = new Set<ExpLevelId>(user?.expLevels ?? [])
    this.expDrafts.set(chatId, seed)
    return seed
  }

  private hasFullSettings(chatId: number): boolean {
    const user = this.settingsRepository.getUser(chatId)
    return Boolean(user?.category)
  }

  private getLatestLink(jobs: DjinniJob[]): string | null {
    const link = jobs[0]?.link
    return link ? this.normalizeLink(link) : null
  }

  private async renderSettings(ctx: Context, forceReply = false): Promise<void> {
    const chatId = ctx.chat?.id
    if (!chatId) {
      return
    }

    const text = this.buildSettingsText(chatId)
    const keyboard = this.buildSettingsKeyboard(chatId)

    if (!forceReply && ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: keyboard
        })
        return
      } catch (error) {
        if (error instanceof GrammyError && error.description.includes("message is not modified")) {
          return
        }
      }
    }

    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard
    })
  }

  private async renderCategoryPicker(
    ctx: Context,
    page: number,
    forceReply = false
  ): Promise<void> {
    const chatId = ctx.chat?.id
    if (!chatId) {
      return
    }

    const text = this.buildCategoryText(page, chatId)
    const keyboard = this.buildCategoryKeyboard(page, chatId)

    if (!forceReply && ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: keyboard
        })
        return
      } catch (error) {
        if (error instanceof GrammyError && error.description.includes("message is not modified")) {
          return
        }
      }
    }

    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard
    })
  }

  private async renderExpPicker(ctx: Context, forceReply = false): Promise<void> {
    const chatId = ctx.chat?.id
    if (!chatId) {
      return
    }

    const text = this.buildExpText(chatId)
    const keyboard = this.buildExpKeyboard(chatId)

    if (!forceReply && ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: keyboard
        })
        return
      } catch (error) {
        if (error instanceof GrammyError && error.description.includes("message is not modified")) {
          return
        }
      }
    }

    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard
    })
  }

  private buildSettingsText(chatId: number): string {
    const user = this.settingsRepository.getUser(chatId)
    if (!user) {
      return "Налаштування ще не створені."
    }

    const categoryText = this.formatter.formatCategoryLabel(user.category)
    const expText = user.expLevels.length
      ? user.expLevels.map((level) => this.formatter.expLabel(level)).join(", ")
      : "будь-який (без фільтра)"
    const statusText = user.isActive ? "увімкнено" : "на паузі"
    const lastJobLinkText = user.lastJobLink
      ? this.formatter.truncate(user.lastJobLink, 60)
      : "не встановлено"

    return [
      "<b>Налаштування Djinni RSS</b>",
      `Категорія: <b>${this.formatter.escapeHtml(categoryText)}</b>`,
      `Досвід: <b>${this.formatter.escapeHtml(expText)}</b>`,
      `Статус: <b>${statusText}</b>`,
      `Last Link: <b>${this.formatter.escapeHtml(lastJobLinkText)}</b>`
    ].join("\n")
  }

  private buildSettingsKeyboard(chatId: number): InlineKeyboard {
    const user = this.settingsRepository.getUser(chatId)
    const isActive = user?.isActive ?? true

    return new InlineKeyboard()
      .text("Змінити категорію", "cat:open")
      .row()
      .text("Змінити роки досвіду", "exp:open")
      .row()
      .text(isActive ? "Пауза ⏸" : "Увімкнути ▶️", "settings:toggle")
      .text("Перевірити зараз", "poll:now")
  }

  private buildCategoryKeyboard(page: number, chatId: number): InlineKeyboard {
    const totalPages = Math.ceil(DJINNI_CATEGORIES.length / this.categoryPageSize)
    const clampedPage = Math.min(Math.max(page, 0), Math.max(totalPages - 1, 0))
    const selectedCategory = this.settingsRepository.getUser(chatId)?.category

    const start = clampedPage * this.categoryPageSize
    const end = Math.min(start + this.categoryPageSize, DJINNI_CATEGORIES.length)

    const keyboard = new InlineKeyboard()
    const allPrefix = selectedCategory === ALL_CATEGORIES_VALUE ? "✅ " : ""
    keyboard.text(`${allPrefix}${ALL_CATEGORIES_LABEL}`, "cat:set_all").row()

    for (let index = start; index < end; index += 2) {
      keyboard.text(DJINNI_CATEGORIES[index], `cat:set:${index}`)
      if (index + 1 < end) {
        keyboard.text(DJINNI_CATEGORIES[index + 1], `cat:set:${index + 1}`)
      }
      keyboard.row()
    }

    if (totalPages > 1) {
      if (clampedPage > 0) {
        keyboard.text("⬅️", `cat:page:${clampedPage - 1}`)
      }
      keyboard.text(`${clampedPage + 1}/${totalPages}`, "noop")
      if (clampedPage < totalPages - 1) {
        keyboard.text("➡️", `cat:page:${clampedPage + 1}`)
      }
      keyboard.row()
    }

    keyboard.text("⬅️ До налаштувань", "menu:settings")
    return keyboard
  }

  private buildCategoryText(page: number, chatId: number): string {
    const totalPages = Math.ceil(DJINNI_CATEGORIES.length / this.categoryPageSize)
    const currentPage = Math.min(Math.max(page, 0), Math.max(totalPages - 1, 0))
    const user = this.settingsRepository.getUser(chatId)
    const selected = this.formatter.formatCategoryLabel(user?.category ?? null)

    return [
      "<b>Оберіть категорію</b>",
      `Поточна: <b>${this.formatter.escapeHtml(selected)}</b>`,
      `Сторінка: ${currentPage + 1}/${Math.max(totalPages, 1)}`
    ].join("\n")
  }

  private buildExpKeyboard(chatId: number): InlineKeyboard {
    const selected = this.getDraft(chatId)
    const keyboard = new InlineKeyboard()

    for (let index = 0; index < EXP_LEVELS.length; index += 2) {
      const left = EXP_LEVELS[index]
      const leftChecked = selected.has(left.id) ? "✅" : "☑️"
      keyboard.text(`${leftChecked} ${left.label}`, `exp:toggle:${left.id}`)

      if (index + 1 < EXP_LEVELS.length) {
        const right = EXP_LEVELS[index + 1]
        const rightChecked = selected.has(right.id) ? "✅" : "☑️"
        keyboard.text(`${rightChecked} ${right.label}`, `exp:toggle:${right.id}`)
      }

      keyboard.row()
    }

    keyboard
      .text("Обрати всі", "exp:all")
      .text("Очистити", "exp:none")
      .row()
      .text("💾 Зберегти", "exp:save")
      .row()
      .text("⬅️ До налаштувань", "menu:settings")

    return keyboard
  }

  private buildExpText(chatId: number): string {
    const selected = this.sortExpLevels(this.getDraft(chatId))
    const selectedLabels = selected.length
      ? selected.map((level) => this.formatter.expLabel(level)).join(", ")
      : "будь-який (без фільтра)"

    return [
      "<b>Оберіть роки досвіду</b>",
      "Можна вибрати кілька значень.",
      `Вибрано: <b>${this.formatter.escapeHtml(selectedLabels)}</b>`
    ].join("\n")
  }

  private async primeCurrentFeed(chatId: number): Promise<void> {
    const user = this.settingsRepository.getUser(chatId)
    if (!user?.category) {
      return
    }

    try {
      const rssCategory = this.categoryForRss(user.category)
      const rssUrl = this.rssFeedService.buildRssUrl(rssCategory, user.expLevels)
      const jobs = await this.rssFeedService.fetchJobs(rssCategory, user.expLevels)
      const latestLink = this.getLatestLink(jobs)

      if (latestLink) {
        this.settingsRepository.setLastJobLink(chatId, latestLink)
      }

      this.logger.info(
        `prime chat=${chatId} url=${rssUrl} jobs=${jobs.length} latest_link=${latestLink ?? "none"}`
      )
    } catch (error) {
      this.logger.error(`Prime feed failed for chat ${chatId}: ${error}`)
    }
  }

  private async processUserFeed(chatId: number): Promise<number> {
    const user = this.settingsRepository.getUser(chatId)
    if (!user || !user.isActive || !user.category) {
      return 0
    }

    const rssCategory = this.categoryForRss(user.category)
    const rssUrl = this.rssFeedService.buildRssUrl(rssCategory, user.expLevels)
    const jobs = await this.rssFeedService.fetchJobs(rssCategory, user.expLevels)
    const latestLink = this.getLatestLink(jobs)

    if (!latestLink) {
      this.logger.info(`poll chat=${chatId} url=${rssUrl} jobs=0 latest_link=none sent=0`)
      return 0
    }

    const previousLink = user.lastJobLink ? this.normalizeLink(user.lastJobLink) : null
    if (!previousLink) {
      this.settingsRepository.setLastJobLink(chatId, latestLink)
      this.logger.info(
        `poll chat=${chatId} init url=${rssUrl} jobs=${jobs.length} latest_link=${latestLink}`
      )
      return 0
    }

    const anchorIndex = jobs.findIndex((job) => this.normalizeLink(job.link) === previousLink)
    if (anchorIndex === 0) {
      this.logger.info(
        `poll chat=${chatId} url=${rssUrl} jobs=${jobs.length} previous_link=${previousLink} latest_link=${latestLink} sent=0`
      )
      return 0
    }

    if (anchorIndex === -1) {
      this.settingsRepository.setLastJobLink(chatId, latestLink)
      this.logger.info(
        `poll chat=${chatId} url=${rssUrl} anchor_missing previous_link=${previousLink} latest_link=${latestLink} jobs=${jobs.length} sent=0`
      )
      return 0
    }

    const newJobs = jobs.slice(0, anchorIndex).reverse()
    let sent = 0

    for (const job of newJobs) {
      try {
        await this.bot.api.sendMessage(chatId, this.formatter.formatJobMessage(job), {
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
      `poll chat=${chatId} url=${rssUrl} jobs=${jobs.length} previous_link=${previousLink} latest_link=${latestLink} new_jobs=${newJobs.length} sent=${sent}`
    )

    return sent
  }

  private async pollAllUsers(): Promise<void> {
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
}
