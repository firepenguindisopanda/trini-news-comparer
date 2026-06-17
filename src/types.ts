export interface NewsSourceReport {
  sourceName: string;
  headline: string;
  publishDate: string;
  synopsis: string;
  toneAngle: string;
  detailsEmphasized: string[];
  detailsOmittedOrDownplayed: string[];
  articleUrl?: string;
}

export interface NewsSynthesis {
  overallAnalysis: string;
  keyTakeaway: string;
}

export interface NewsComparisonResult {
  topic: string;
  summary: string;
  lastUpdated: string;
  synthesis: NewsSynthesis;
  sourcesFound: NewsSourceReport[];
}

export interface SearchHistoryItem {
  id: string;
  topic: string;
  timestamp: string;
  summarySnapshot: string;
}

export interface ScrapedArticle {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

