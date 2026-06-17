import axios from "axios";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import {
  getCachedArticles,
  setCachedArticles,
  getCachedAllArticles,
  setCachedAllArticles,
  invalidateArticleCaches,
} from "./server/services/cache.js";

export interface ScrapedArticle {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

const parser = new Parser();

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const axiosInstance = axios.create({
  timeout: 10000,
  headers: {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Connection": "keep-alive"
  }
});

// Helper to parse RSS using rss-parser with axios content fetching (which succeeds where rss-parser directly gets 403 on Cloudflare)
export async function fetchRssFeed(url: string): Promise<any[]> {
  try {
    const response = await axiosInstance.get(url, {
      headers: {
        "Referer": "https://www.google.com/"
      }
    });
    const feed = await parser.parseString(response.data);
    return (feed.items || []).map(item => ({
      title: item.title?.trim() || "No Title",
      link: item.link?.trim() || url,
      pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
      excerpt: item.contentSnippet || item.content || ""
    }));
  } catch (err: any) {
    // Suppress verbose 403 warning logs. Cloudflare or Wordfence may block in serverless environments; fail silently.
    if (err.message?.includes("403")) {
      return [];
    }
    
    // Fallback directly to parser if axios gets blocked for any reason
    try {
      const feed = await parser.parseURL(url);
      return (feed.items || []).map(item => ({
        title: item.title?.trim() || "No Title",
        link: item.link?.trim() || url,
        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
        excerpt: item.contentSnippet || item.content || ""
      }));
    } catch (err2: any) {
      return [];
    }
  }
}

// 1. Trinidad Express Scraper
export async function fetchExpress(): Promise<ScrapedArticle[]> {
  try {
    const url = "https://trinidadexpress.com/news/local/";
    const response = await axiosInstance.get(url);
    const $ = cheerio.load(response.data);
    const articles: ScrapedArticle[] = [];
    const seen = new Set<string>();

    $("a").each((i, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      // Filter local news articles
      if (href.includes("/article_") && href.endsWith(".html")) {
        // Exclude social sharing links (e.g., wa.me, facebook, twitter)
        if (href.includes("sharer.php") || href.includes("twitter.com/intent") || href.includes("wa.me")) {
          return;
        }

        const fullUrl = href.startsWith("http") ? href : `https://trinidadexpress.com${href}`;
        const title = $(el).text().trim().replace(/\s+/g, " ");

        if (title && title.length > 10 && !seen.has(fullUrl)) {
          seen.add(fullUrl);
          articles.push({
            title,
            link: fullUrl,
            pubDate: new Date().toISOString(), // Express doesn't show date in local list, default to current/scraped date
            source: "Trinidad Express"
          });
        }
      }
    });

    return articles;
  } catch (err: any) {
    console.error("[Scraper Error] Failed to scrape Trinidad Express:", err.message);
    return [];
  }
}

// 2. Trinidad Guardian Scraper
export async function fetchGuardian(): Promise<ScrapedArticle[]> {
  try {
    const url = "https://www.guardian.co.tt/";
    const response = await axiosInstance.get(url);
    const $ = cheerio.load(response.data);
    const articles: ScrapedArticle[] = [];
    const seen = new Set<string>();

    $("a").each((i, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      // Filter relative news, business, sports, opinion, article links
      const isArticleUrl = (
        href.startsWith("/news/") || 
        href.startsWith("/article/") || 
        href.startsWith("/business/") || 
        href.startsWith("/sports/") || 
        href.startsWith("/opinion/")
      ) && href.includes("-6.2.");

      if (isArticleUrl) {
        const fullUrl = `https://www.guardian.co.tt${href}`;
        
        let title = "";
        // Look for internal heading classes or tags
        const headlineEl = $(el).find(".headline, .title, h1, h2, h3, h4");
        if (headlineEl.length > 0) {
          title = $(headlineEl[0]).text().trim().replace(/\s+/g, " ");
        } else {
          title = $(el).text().trim().replace(/\s+/g, " ");
        }

        // Clean up title from common noise (e.g. if it concatenated author name or "by ...")
        title = title.replace(/\s+/g, " ");

        if (title && title.length > 12 && !seen.has(fullUrl)) {
          seen.add(fullUrl);
          articles.push({
            title,
            link: fullUrl,
            pubDate: new Date().toISOString(), // Scraped date
            source: "Trinidad Guardian"
          });
        }
      }
    });

    return articles;
  } catch (err: any) {
    console.error("[Scraper Error] Failed to scrape Trinidad Guardian:", err.message);
    return [];
  }
}

// 3. Newsday Scraper (Historical Archive - ceased January 2026)
export async function fetchNewsday(): Promise<ScrapedArticle[]> {
  try {
    const url = "https://newsday.co.tt/";
    const response = await axiosInstance.get(url);
    const $ = cheerio.load(response.data);
    const articles: ScrapedArticle[] = [];
    const seen = new Set<string>();

    $("a").each((i, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      // Match newsday date articles (e.g. https://newsday.co.tt/2026/01/31/slug/)
      const match = href.match(/^https:\/\/newsday\.co\.tt\/(\d{4})\/(\d{2})\/(\d{2})\/([^\/]+)\/?$/);
      if (match) {
        const titleText = $(el).text().trim().replace(/\s+/g, " ");
        let title = titleText;

        const headingEl = $(el).find("h1, h2, h3, h4, h5, h6, .headline, .title");
        if (headingEl.length > 0) {
          title = $(headingEl[0]).text().trim().replace(/\s+/g, " ");
        }

        if (title && title.length > 10 && !seen.has(href)) {
          seen.add(href);
          
          // Formulate the date from URL match
          const year = match[1];
          const month = match[2];
          const day = match[3];
          const pubDate = new Date(`${year}-${month}-${day}T12:00:00Z`).toISOString();

          articles.push({
            title,
            link: href,
            pubDate,
            source: "Newsday"
          });
        }
      }
    });

    return articles;
  } catch (err: any) {
    console.error("[Scraper Error] Failed to scrape Newsday Archive:", err.message);
    return [];
  }
}

// 4. CNC3 News Feed (RSS)
export async function fetchCNC3(): Promise<ScrapedArticle[]> {
  const items = await fetchRssFeed("https://www.cnc3.co.tt/feed/");
  return items.map(item => ({
    title: item.title,
    link: item.link,
    pubDate: item.pubDate,
    source: "CNC3 News"
  }));
}

// 5. TTT News Feed (RSS)
export async function fetchTTT(): Promise<ScrapedArticle[]> {
  const items = await fetchRssFeed("https://ttt.live/feed/");
  return items.map(item => ({
    title: item.title,
    link: item.link,
    pubDate: item.pubDate,
    source: "TTT News"
  }));
}

// 6. Wired868 Feed (RSS)
export async function fetchWired868(): Promise<ScrapedArticle[]> {
  const items = await fetchRssFeed("https://wired868.com/feed/");
  return items.map(item => ({
    title: item.title,
    link: item.link,
    pubDate: item.pubDate,
    source: "Wired868"
  }));
}

// Aggregates all news from all sources in parallel
export async function fetchAllNews(): Promise<ScrapedArticle[]> {
  const [express, guardian, cnc3, ttt, wired868, newsday] = await Promise.all([
    fetchExpress(),
    fetchGuardian(),
    fetchCNC3(),
    fetchTTT(),
    fetchWired868(),
    fetchNewsday()
  ]);

  return [
    ...express,
    ...guardian,
    ...cnc3,
    ...ttt,
    ...wired868,
    ...newsday
  ];
}

//
// Cached variants
//

/**
 * Like `fetchAllNews()` but checks the Upstash Redis cache first.
 *
 * Cache HIT  to returns cached data immediately (< 10 ms)
 * Cache MISS to runs the live scraper, seeds the cache, returns fresh data
 *
 * Accepts an optional `force` flag to bypass the cache (e.g. user clicked refresh).
 */
export async function fetchAllNewsCached(force = false): Promise<ScrapedArticle[]> {
  if (!force) {
    const cached = await getCachedAllArticles();
    if (cached) {
      console.log("[Scraper] Cache HIT for aggregated articles");
      return cached as ScrapedArticle[];
    }
  }

  console.log("[Scraper] Cache MISS - scraping live…");
  const fresh = await fetchAllNews();

  // Seed the aggregated cache
  await setCachedAllArticles(fresh);

  // Also seed per‑source caches
  const bySource = new Map<string, ScrapedArticle[]>();
  for (const article of fresh) {
    const arr = bySource.get(article.source) || [];
    arr.push(article);
    bySource.set(article.source, arr);
  }
  for (const [source, articles] of bySource) {
    await setCachedArticles(articles, source);
  }

  return fresh;
}

/**
 * Force-refresh the cache by re-scraping all sources and re-seeding.
 * Useful for the manual "Recrawl" button in the UI.
 */
export async function refreshAllNews(): Promise<ScrapedArticle[]> {
  await invalidateArticleCaches();
  return fetchAllNewsCached(false); // will now miss and re-scrape
}

// Simple text-matching search to compare framing across headlines
export function searchHeadlines(articles: ScrapedArticle[], query: string): ScrapedArticle[] {
  if (!query) return articles;
  const lowercaseQuery = query.toLowerCase();
  
  // Custom ranker: Exact match in title gets highest rank, then keyword matches
  return articles
    .filter(article => article.title.toLowerCase().includes(lowercaseQuery))
    .sort((a, b) => {
      const aExact = a.title.toLowerCase() === lowercaseQuery;
      const bExact = b.title.toLowerCase() === lowercaseQuery;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return 0;
    });
}
