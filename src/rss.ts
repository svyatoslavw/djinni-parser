import { XMLParser } from "fast-xml-parser";
import { decode } from "html-entities";

import { ALL_CATEGORIES_VALUE, type ExpLevelId } from "./constants";

export interface DjinniJob {
  guid: string;
  title: string;
  link: string;
  descriptionText: string;
  pubDate: string;
  category: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true
});

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function stripHtml(input: string): string {
  const withoutTags = input.replace(/<[^>]+>/g, " ");
  const normalized = decode(withoutTags)
    .replace(/\s+/g, " ")
    .trim();
  return normalized;
}

function normalizeCategory(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        return item.trim();
      }
    }
  }

  return "N/A";
}

export function buildRssUrl(category: string | null, expLevels: ExpLevelId[]): string {
  const url = new URL("https://djinni.co/jobs/rss/");
  if (category && category !== ALL_CATEGORIES_VALUE) {
    url.searchParams.set("primary_keyword", category);
  }
  for (const level of expLevels) {
    url.searchParams.append("exp_level", level);
  }
  return url.toString();
}

export async function fetchJobs(category: string | null, expLevels: ExpLevelId[]): Promise<DjinniJob[]> {
  const url = buildRssUrl(category, expLevels);
  const response = await fetch(url, {
    headers: {
      "User-Agent": "djinni-rss-telegram-bot/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`RSS request failed with status ${response.status}`);
  }

  const xml = await response.text();
  const data = parser.parse(xml) as {
    rss?: {
      channel?: {
        item?:
          | {
              title?: string;
              link?: string;
              description?: string;
              pubDate?: string;
              guid?: string;
              category?: string | string[];
            }
          | Array<{
              title?: string;
              link?: string;
              description?: string;
              pubDate?: string;
              guid?: string;
              category?: string | string[];
            }>;
      };
    };
  };

  const items = toArray(data.rss?.channel?.item);

  return items
    .map((item) => {
      const link = item.link ?? "";
      const title = item.title ?? "Без назви";
      const guid = item.guid ?? link ?? `${title}:${item.pubDate ?? ""}`;

      return {
        guid,
        title,
        link,
        descriptionText: stripHtml(item.description ?? ""),
        pubDate: item.pubDate ?? "",
        category: normalizeCategory(item.category)
      } satisfies DjinniJob;
    })
    .filter((item) => item.guid && item.link);
}
