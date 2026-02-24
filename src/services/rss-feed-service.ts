import { XMLParser } from "fast-xml-parser"
import { decode } from "html-entities"

import type { IJob } from "@/models"
import { ALL_CATEGORIES_VALUE, type ExpLevelId } from "../common/constants"

interface RssItem {
  title?: string
  link?: string
  description?: string
  pubDate?: string
  guid?: string
  category?: string | string[]
}

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true
})

export class RssFeedService {
  public buildRssUrl(category: string | null, expLevels: ExpLevelId[]): string {
    const url = new URL("https://djinni.co/jobs/rss/")
    if (category && category !== ALL_CATEGORIES_VALUE) {
      url.searchParams.set("primary_keyword", category)
    }

    for (const level of expLevels) {
      url.searchParams.append("exp_level", level)
    }

    return url.toString()
  }

  public buildRssUrls(categories: string[], expLevels: ExpLevelId[]): string[] {
    return this.categoriesForRequests(categories).map((category) =>
      this.buildRssUrl(category, expLevels)
    )
  }

  public async fetchJobs(category: string | null, expLevels: ExpLevelId[]): Promise<IJob[]> {
    const url = this.buildRssUrl(category, expLevels)
    const response = await fetch(url, {
      headers: {
        "User-Agent": "djinni-rss-telegram-bot/1.0"
      }
    })

    if (!response.ok) {
      throw new Error(`RSS request failed with status ${response.status}`)
    }

    const xml = await response.text()
    const data = parser.parse(xml) as {
      rss?: {
        channel?: {
          item?: RssItem | RssItem[]
        }
      }
    }

    const items = this.toArray(data.rss?.channel?.item)

    return items
      .map((item) => {
        const link = item.link ?? ""
        const title = item.title ?? "Без назви"
        const guid = item.guid ?? link ?? `${title}:${item.pubDate ?? ""}`

        return {
          guid,
          title,
          link,
          descriptionText: this.stripHtml(item.description ?? ""),
          pubDate: item.pubDate ?? "",
          category: this.normalizeCategory(item.category)
        } satisfies IJob
      })
      .filter((item) => item.guid && item.link)
  }

  public async fetchJobsForCategories(
    categories: string[],
    expLevels: ExpLevelId[]
  ): Promise<IJob[]> {
    const requestCategories = this.categoriesForRequests(categories)
    if (requestCategories.length === 0) {
      return []
    }

    const jobsByCategory = await Promise.all(
      requestCategories.map((category) => this.fetchJobs(category, expLevels))
    )

    const uniqueByLink = new Map<string, IJob>()
    for (const job of jobsByCategory.flat()) {
      const key = this.normalizeLink(job.link)
      if (!uniqueByLink.has(key)) {
        uniqueByLink.set(key, job)
      }
    }

    return Array.from(uniqueByLink.values()).sort(
      (left, right) => this.toTimestamp(right.pubDate) - this.toTimestamp(left.pubDate)
    )
  }

  private toArray<T>(value: T | T[] | undefined): T[] {
    if (!value) {
      return []
    }

    return Array.isArray(value) ? value : [value]
  }

  private categoriesForRequests(categories: string[]): Array<string | null> {
    if (categories.length === 0) {
      return []
    }

    if (categories.includes(ALL_CATEGORIES_VALUE)) {
      return [null]
    }

    return categories
  }

  private normalizeLink(link: string): string {
    return link.trim().replace(/\/$/, "")
  }

  private toTimestamp(pubDate: string): number {
    const parsed = new Date(pubDate)
    return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime()
  }

  private stripHtml(input: string): string {
    const withoutTags = input.replace(/<[^>]+>/g, " ")
    return decode(withoutTags).replace(/\s+/g, " ").trim()
  }

  private normalizeCategory(value: unknown): string {
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          return item.trim()
        }
      }
    }

    return "N/A"
  }
}
