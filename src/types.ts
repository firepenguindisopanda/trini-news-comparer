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

export interface ClaimRef {
  claim: string;
  sourceName: string;
  articleUrl?: string;
}

export interface NewsSynthesis {
  overallAnalysis: string;
  keyTakeaway: string;
  claims?: ClaimRef[];
}

export interface NewsComparisonResult {
  topic: string;
  summary: string;
  lastUpdated: string;
  synthesis: NewsSynthesis;
  sourcesFound: NewsSourceReport[];
  verificationStatus: "verified" | "flagged";
  verificationIssues: string[];
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

// Phase 1: Daily news brief
export interface BriefStory {
  storyTitle: string;
  framingDivergence: string;
  perSourceAngles: Array<{ sourceName: string; angle: string; articleUrl?: string }>;
  sourceAgreementLevel: "high" | "medium" | "low";
}

export interface MarketBrief {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  topStories: BriefStory[];
  editorNote: string;
}

// Phase 2: Financial brief types
export interface FinancialMetric {
  metric: string;
  value: string;
  period: string;
}

export interface FinancialSourceReport {
  sourceName: string;
  headline: string;
  marketSentiment: "bullish" | "bearish" | "neutral" | "mixed";
  keyMetrics: FinancialMetric[];
  sourceAuthority: "official" | "analyst" | "media" | "rumor";
  dataDiscrepancies: string[];
  articleUrl: string;
}

