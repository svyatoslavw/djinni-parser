import type { IJob } from "@/models"
import {
  ALL_CATEGORIES_LABEL,
  ALL_CATEGORIES_VALUE,
  EXP_LEVELS,
  type ExpLevelId
} from "../common/constants"

export class Formatter {
  private readonly dateFormatter = new Intl.DateTimeFormat("uk-UA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })

  public escapeHtml(input: string): string {
    return input
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")
  }

  public truncate(input: string, maxLength: number): string {
    if (input.length <= maxLength) {
      return input
    }

    return `${input.slice(0, maxLength - 1)}…`
  }

  public formatCategoryLabel(categories: string[]): string {
    if (categories.length === 0) {
      return "не обрано"
    }

    if (categories.includes(ALL_CATEGORIES_VALUE)) {
      return ALL_CATEGORIES_LABEL
    }

    return categories.join(", ")
  }

  public expLabel(level: ExpLevelId): string {
    return EXP_LEVELS.find((item) => item.id === level)?.label ?? level
  }

  public formatPubDate(pubDate: string): string {
    if (!pubDate) {
      return "без дати"
    }

    const parsedDate = new Date(pubDate)
    if (Number.isNaN(parsedDate.getTime())) {
      return pubDate.replace(/\s[+-]\d{4}$/, "").trim()
    }

    return this.dateFormatter.format(parsedDate)
  }

  public formatJobMessage(job: IJob): string {
    const snippet = this.truncate(job.descriptionText, 420)

    return [
      `<b>${this.escapeHtml(job.title)}</b>`,
      `Категорія: ${this.escapeHtml(job.category)}`,
      `Дата: ${this.escapeHtml(this.formatPubDate(job.pubDate))}`,
      "",
      this.escapeHtml(snippet),
      "",
      `<a href=\"${this.escapeHtml(job.link)}\">Відкрити вакансію</a>`
    ].join("\n")
  }
}
