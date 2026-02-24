import { GrammyError, HttpError, InlineKeyboard, type Bot, type Context } from "grammy"

import { SettingsRepository } from "@/repositories"
import { FeedPollerService } from "@/services"
import { Formatter, Logger } from "@/utils"
import {
  ALL_CATEGORIES_LABEL,
  ALL_CATEGORIES_VALUE,
  CATEGORY_PAGE_SIZE,
  DJINNI_CATEGORIES,
  EXP_LEVELS,
  type ExpLevelId
} from "../common/constants"

interface BotAppDependencies {
  bot: Bot
  logger: Logger
  settingsRepository: SettingsRepository
  feedPollerService: FeedPollerService
  formatter: Formatter
}

interface CategoryPageState {
  totalPages: number
  currentPage: number
  start: number
  end: number
}

export class BotApplication {
  private readonly expDrafts = new Map<number, Set<ExpLevelId>>()
  private readonly categoryDrafts = new Map<number, Set<string>>()

  private readonly bot: Bot
  private readonly logger: Logger
  private readonly settingsRepository: SettingsRepository
  private readonly feedPollerService: FeedPollerService
  private readonly formatter: Formatter

  public constructor({
    bot,
    logger,
    settingsRepository,
    feedPollerService,
    formatter
  }: BotAppDependencies) {
    this.bot = bot
    this.logger = logger
    this.settingsRepository = settingsRepository
    this.feedPollerService = feedPollerService
    this.formatter = formatter
  }

  public start(): void {
    this.registerHandlers()
    this.registerErrorHandler()

    this.bot.start({
      onStart: ({ username }) => {
        this.logger.info(`Bot @${username} started`)
      }
    })
  }

  private registerHandlers(): void {
    this.registerCommandHandlers()
    this.registerSettingsCallbacks()
    this.registerCategoryCallbacks()
    this.registerExpCallbacks()
    this.registerTextFallbackHandler()
  }

  private registerCommandHandlers(): void {
    this.bot.command("start", (ctx) => this.handleStartCommand(ctx))
    this.bot.command("settings", (ctx) => this.handleSettingsCommand(ctx))
  }

  private registerSettingsCallbacks(): void {
    this.bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery())
    this.bot.callbackQuery("menu:settings", (ctx) => this.handleSettingsMenu(ctx))
    this.bot.callbackQuery("settings:toggle", (ctx) => this.handleSettingsToggle(ctx))
    this.bot.callbackQuery("poll:now", (ctx) => this.handlePollNow(ctx))
  }

  private registerCategoryCallbacks(): void {
    this.bot.callbackQuery("cat:open", (ctx) => this.handleCategoryOpen(ctx))
    this.bot.callbackQuery(/^cat:page:(\d+)$/, (ctx) => this.handleCategoryPage(ctx))
    this.bot.callbackQuery("cat:set_all", (ctx) => this.handleCategorySetAll(ctx))
    this.bot.callbackQuery(/^cat:set:(\d+)$/, (ctx) => this.handleCategorySet(ctx))
    this.bot.callbackQuery("cat:clear", (ctx) => this.handleCategoryClear(ctx))
    this.bot.callbackQuery("cat:save", (ctx) => this.handleCategorySave(ctx))
  }

  private registerExpCallbacks(): void {
    this.bot.callbackQuery("exp:open", (ctx) => this.handleExpOpen(ctx))
    this.bot.callbackQuery(/^exp:toggle:(.+)$/, (ctx) => this.handleExpToggle(ctx))
    this.bot.callbackQuery("exp:all", (ctx) => this.handleExpSetAll(ctx))
    this.bot.callbackQuery("exp:none", (ctx) => this.handleExpClear(ctx))
    this.bot.callbackQuery("exp:save", (ctx) => this.handleExpSave(ctx))
  }

  private registerTextFallbackHandler(): void {
    this.bot.on("message:text", (ctx) => this.handleTextMessage(ctx))
  }

  private async handleStartCommand(ctx: Context): Promise<void> {
    const chatId = this.getChatId(ctx)
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
  }

  private async handleSettingsCommand(ctx: Context): Promise<void> {
    const chatId = this.getChatId(ctx)
    if (!chatId) {
      return
    }

    this.settingsRepository.ensureUser(chatId)
    await this.renderSettings(ctx, true)
  }

  private async handleSettingsMenu(ctx: Context): Promise<void> {
    await ctx.answerCallbackQuery()
    await this.renderSettings(ctx)
  }

  private async handleSettingsToggle(ctx: Context): Promise<void> {
    const chatId = await this.getCallbackChatId(ctx)
    if (!chatId) {
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
  }

  private async handlePollNow(ctx: Context): Promise<void> {
    const chatId = await this.getCallbackChatId(ctx)
    if (!chatId) {
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
      const sentCount = await this.feedPollerService.processUserFeed(chatId)
      await ctx.reply(
        sentCount > 0 ? `Надіслано вакансій: ${sentCount}` : "Нових вакансій поки немає."
      )
    } catch {
      await ctx.reply("Не вдалося отримати RSS. Спробуйте ще раз пізніше.")
    }
  }

  private async handleCategoryOpen(ctx: Context): Promise<void> {
    const chatId = await this.getCallbackChatId(ctx)
    if (!chatId) {
      return
    }

    this.settingsRepository.ensureUser(chatId)
    this.categoryDrafts.set(
      chatId,
      new Set(this.sortCategories(this.settingsRepository.getUser(chatId)?.categories ?? []))
    )

    await ctx.answerCallbackQuery()
    await this.renderCategoryPicker(ctx, 0)
  }

  private async handleCategoryPage(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? ""
    const match = data.match(/^cat:page:(\d+)$/)
    if (!match) {
      await ctx.answerCallbackQuery()
      return
    }

    const page = Number.parseInt(match[1], 10)
    await ctx.answerCallbackQuery()
    await this.renderCategoryPicker(ctx, page)
  }

  private async handleCategorySetAll(ctx: Context): Promise<void> {
    const chatId = await this.getCallbackChatId(ctx)
    if (!chatId) {
      return
    }

    const draft = this.getCategoryDraft(chatId)
    draft.clear()
    draft.add(ALL_CATEGORIES_VALUE)

    await ctx.answerCallbackQuery({ text: `Вибрано: ${ALL_CATEGORIES_LABEL}` })
    await this.renderCategoryPicker(ctx, this.getCurrentCategoryPage(ctx))
  }

  private async handleCategorySet(ctx: Context): Promise<void> {
    const chatId = await this.getCallbackChatId(ctx)
    if (!chatId) {
      return
    }

    const data = ctx.callbackQuery?.data ?? ""
    const match = data.match(/^cat:set:(\d+)$/)
    if (!match) {
      await ctx.answerCallbackQuery({
        text: "Категорію не знайдено",
        show_alert: true
      })
      return
    }

    const index = Number.parseInt(match[1], 10)
    const category = DJINNI_CATEGORIES[index]
    if (!category) {
      await ctx.answerCallbackQuery({
        text: "Категорію не знайдено",
        show_alert: true
      })
      return
    }

    const draft = this.getCategoryDraft(chatId)
    if (draft.has(ALL_CATEGORIES_VALUE)) {
      draft.delete(ALL_CATEGORIES_VALUE)
    }

    const added = !draft.has(category)
    if (added) {
      draft.add(category)
    } else {
      draft.delete(category)
    }

    await ctx.answerCallbackQuery({
      text: added ? `Додано: ${category}` : `Прибрано: ${category}`
    })

    await this.renderCategoryPicker(ctx, this.getPageByCategoryIndex(index))
  }

  private async handleCategoryClear(ctx: Context): Promise<void> {
    const chatId = await this.getCallbackChatId(ctx)
    if (!chatId) {
      return
    }

    const draft = this.getCategoryDraft(chatId)
    draft.clear()

    await ctx.answerCallbackQuery({ text: "Вибір очищено" })
    await this.renderCategoryPicker(ctx, this.getCurrentCategoryPage(ctx))
  }

  private async handleCategorySave(ctx: Context): Promise<void> {
    const chatId = await this.getCallbackChatId(ctx)
    if (!chatId) {
      return
    }

    const categories = this.sortCategories(this.getCategoryDraft(chatId))
    this.settingsRepository.saveCategories(chatId, categories)
    this.categoryDrafts.delete(chatId)

    if (this.hasFullSettings(chatId)) {
      await this.feedPollerService.refreshLastPublication(chatId)
    }

    await ctx.answerCallbackQuery({
      text: categories.length > 0 ? "Категорії збережено" : "Фільтр категорій очищено"
    })
    await this.renderSettings(ctx)
  }

  private async handleExpOpen(ctx: Context): Promise<void> {
    const chatId = await this.getCallbackChatId(ctx)
    if (!chatId) {
      return
    }

    this.settingsRepository.ensureUser(chatId)
    this.expDrafts.set(chatId, new Set(this.settingsRepository.getUser(chatId)?.expLevels ?? []))

    await ctx.answerCallbackQuery()
    await this.renderExpPicker(ctx)
  }

  private async handleExpToggle(ctx: Context): Promise<void> {
    const chatId = await this.getCallbackChatId(ctx)
    if (!chatId) {
      return
    }

    const data = ctx.callbackQuery?.data ?? ""
    const match = data.match(/^exp:toggle:(.+)$/)
    if (!match) {
      await ctx.answerCallbackQuery({
        text: "Невідомий тип досвіду",
        show_alert: true
      })
      return
    }

    const level = match[1]
    if (!this.isKnownExpLevel(level)) {
      await ctx.answerCallbackQuery({
        text: "Невідомий тип досвіду",
        show_alert: true
      })
      return
    }

    const draft = this.getExpDraft(chatId)
    if (draft.has(level)) {
      draft.delete(level)
    } else {
      draft.add(level)
    }

    await ctx.answerCallbackQuery()
    await this.renderExpPicker(ctx)
  }

  private async handleExpSetAll(ctx: Context): Promise<void> {
    const chatId = await this.getCallbackChatId(ctx)
    if (!chatId) {
      return
    }

    const draft = this.getExpDraft(chatId)
    draft.clear()
    for (const level of EXP_LEVELS) {
      draft.add(level.id)
    }

    await ctx.answerCallbackQuery({ text: "Вибрано всі значення" })
    await this.renderExpPicker(ctx)
  }

  private async handleExpClear(ctx: Context): Promise<void> {
    const chatId = await this.getCallbackChatId(ctx)
    if (!chatId) {
      return
    }

    const draft = this.getExpDraft(chatId)
    draft.clear()

    await ctx.answerCallbackQuery({ text: "Вибір очищено" })
    await this.renderExpPicker(ctx)
  }

  private async handleExpSave(ctx: Context): Promise<void> {
    const chatId = await this.getCallbackChatId(ctx)
    if (!chatId) {
      return
    }

    const draft = this.sortExpLevels(this.getExpDraft(chatId))
    this.settingsRepository.saveExpLevels(chatId, draft)
    this.expDrafts.delete(chatId)

    if (this.hasFullSettings(chatId)) {
      await this.feedPollerService.refreshLastPublication(chatId)
    }

    await ctx.answerCallbackQuery({
      text: draft.length > 0 ? "Налаштування досвіду збережено" : "Фільтр досвіду вимкнено"
    })
    await this.renderSettings(ctx)
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    const chatId = this.getChatId(ctx)
    if (!chatId) {
      return
    }

    await ctx.reply(
      "Доступні команди:\n/start - старт і швидке налаштування\n/settings - змінити категорію/досвід",
      { reply_markup: this.buildSettingsKeyboard(chatId) }
    )
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

  private getChatId(ctx: Context): number | null {
    return ctx.chat?.id ?? null
  }

  private async getCallbackChatId(ctx: Context): Promise<number | null> {
    const chatId = this.getChatId(ctx)
    if (!chatId) {
      await ctx.answerCallbackQuery()
      return null
    }

    return chatId
  }

  private isKnownExpLevel(level: string): level is ExpLevelId {
    return EXP_LEVELS.some((item) => item.id === level)
  }

  private isMessageNotModified(error: unknown): boolean {
    return error instanceof GrammyError && error.description.includes("message is not modified")
  }

  private sortExpLevels(levels: Iterable<ExpLevelId>): ExpLevelId[] {
    const set = new Set(levels)
    return EXP_LEVELS.map((item) => item.id).filter((id) => set.has(id))
  }

  private sortCategories(categories: Iterable<string>): string[] {
    const set = new Set(
      Array.from(categories)
        .map((value) => value.trim())
        .filter(Boolean)
    )

    if (set.has(ALL_CATEGORIES_VALUE)) {
      return [ALL_CATEGORIES_VALUE]
    }

    return DJINNI_CATEGORIES.filter((category) => set.has(category))
  }

  private getExpDraft(chatId: number): Set<ExpLevelId> {
    const current = this.expDrafts.get(chatId)
    if (current) {
      return current
    }

    const user = this.settingsRepository.getUser(chatId)
    const seed = new Set<ExpLevelId>(user?.expLevels ?? [])
    this.expDrafts.set(chatId, seed)
    return seed
  }

  private getCategoryDraft(chatId: number): Set<string> {
    const current = this.categoryDrafts.get(chatId)
    if (current) {
      return current
    }

    const user = this.settingsRepository.getUser(chatId)
    const seed = new Set<string>(this.sortCategories(user?.categories ?? []))
    this.categoryDrafts.set(chatId, seed)
    return seed
  }

  private hasFullSettings(chatId: number): boolean {
    const user = this.settingsRepository.getUser(chatId)
    return Boolean(user && user.categories.length > 0)
  }

  private getPageByCategoryIndex(index: number): number {
    return Math.floor(index / CATEGORY_PAGE_SIZE)
  }

  private getCurrentCategoryPage(ctx: Context): number {
    const data = ctx.callbackQuery?.data ?? ""

    const pageMatch = data.match(/^cat:page:(\d+)$/)
    if (pageMatch) {
      return Number.parseInt(pageMatch[1], 10)
    }

    const setMatch = data.match(/^cat:set:(\d+)$/)
    if (setMatch) {
      return this.getPageByCategoryIndex(Number.parseInt(setMatch[1], 10))
    }

    return 0
  }

  private getCategoryPageState(page: number): CategoryPageState {
    const totalPages = Math.max(Math.ceil(DJINNI_CATEGORIES.length / CATEGORY_PAGE_SIZE), 1)
    const currentPage = Math.min(Math.max(page, 0), totalPages - 1)

    const start = currentPage * CATEGORY_PAGE_SIZE
    const end = Math.min(start + CATEGORY_PAGE_SIZE, DJINNI_CATEGORIES.length)

    return { totalPages, currentPage, start, end }
  }

  private async renderInteractiveMessage(
    ctx: Context,
    text: string,
    keyboard: InlineKeyboard,
    forceReply = false
  ): Promise<void> {
    if (!forceReply && ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: keyboard
        })
        return
      } catch (error) {
        if (this.isMessageNotModified(error)) {
          return
        }
      }
    }

    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard
    })
  }

  private async renderSettings(ctx: Context, forceReply = false): Promise<void> {
    const chatId = this.getChatId(ctx)
    if (!chatId) {
      return
    }

    await this.renderInteractiveMessage(
      ctx,
      this.buildSettingsText(chatId),
      this.buildSettingsKeyboard(chatId),
      forceReply
    )
  }

  private async renderCategoryPicker(
    ctx: Context,
    page: number,
    forceReply = false
  ): Promise<void> {
    const chatId = this.getChatId(ctx)
    if (!chatId) {
      return
    }

    await this.renderInteractiveMessage(
      ctx,
      this.buildCategoryText(page, chatId),
      this.buildCategoryKeyboard(page, chatId),
      forceReply
    )
  }

  private async renderExpPicker(ctx: Context, forceReply = false): Promise<void> {
    const chatId = this.getChatId(ctx)
    if (!chatId) {
      return
    }

    await this.renderInteractiveMessage(
      ctx,
      this.buildExpText(chatId),
      this.buildExpKeyboard(chatId),
      forceReply
    )
  }

  private buildSettingsText(chatId: number): string {
    const user = this.settingsRepository.getUser(chatId)
    if (!user) {
      return "Налаштування ще не створені."
    }

    const categoryText = this.formatter.formatCategoryLabel(user.categories)
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
    const { totalPages, currentPage, start, end } = this.getCategoryPageState(page)
    const selectedCategories = this.getCategoryDraft(chatId)
    const allSelected = selectedCategories.has(ALL_CATEGORIES_VALUE)

    const keyboard = new InlineKeyboard()
    const allPrefix = allSelected ? "✅ " : "☑️ "
    keyboard.text(`${allPrefix}${ALL_CATEGORIES_LABEL}`, "cat:set_all").row()

    for (let index = start; index < end; index += 1) {
      const category = DJINNI_CATEGORIES[index]
      const checked = !allSelected && selectedCategories.has(category) ? "✅" : "☑️"
      keyboard.text(`${checked} ${category}`, `cat:set:${index}`)
      keyboard.row()
    }

    if (totalPages > 1) {
      if (currentPage > 0) {
        keyboard.text("⬅️", `cat:page:${currentPage - 1}`)
      }
      keyboard.text(`${currentPage + 1}/${totalPages}`, "noop")
      if (currentPage < totalPages - 1) {
        keyboard.text("➡️", `cat:page:${currentPage + 1}`)
      }
      keyboard.row()
    }

    keyboard
      .text("Очистити", "cat:clear")
      .text("💾 Зберегти", "cat:save")
      .row()
      .text("⬅️ До налаштувань", "menu:settings")

    return keyboard
  }

  private buildCategoryText(page: number, chatId: number): string {
    const { totalPages, currentPage } = this.getCategoryPageState(page)
    const selected = this.formatter.formatCategoryLabel(
      this.sortCategories(this.getCategoryDraft(chatId))
    )

    return [
      "<b>Оберіть категорії</b>",
      "Можна вибрати кілька значень.",
      `Вибрано: <b>${this.formatter.escapeHtml(selected)}</b>`,
      `Сторінка: ${currentPage + 1}/${totalPages}`
    ].join("\n")
  }

  private buildExpKeyboard(chatId: number): InlineKeyboard {
    const selected = this.getExpDraft(chatId)
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
    const selected = this.sortExpLevels(this.getExpDraft(chatId))
    const selectedLabels = selected.length
      ? selected.map((level) => this.formatter.expLabel(level)).join(", ")
      : "будь-який (без фільтра)"

    return [
      "<b>Оберіть роки досвіду</b>",
      "Можна вибрати кілька значень.",
      `Вибрано: <b>${this.formatter.escapeHtml(selectedLabels)}</b>`
    ].join("\n")
  }
}
