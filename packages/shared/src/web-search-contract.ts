export type WebSearchMode = "auto" | "web" | "cve";

export interface WebSearchQuery {
  query: string;
  mode?: WebSearchMode;
  maxResults?: number;
}

export interface WebSearchSettings {
  enabled: boolean;
  deepseekKeyConfigured: boolean;
  nvdKeyConfigured: boolean;
}

export interface WebSearchSettingsInput {
  enabled?: boolean;
  deepseekApiKey?: string;
  nvdApiKey?: string;
  clearDeepSeekKey?: boolean;
  clearNvdKey?: boolean;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  published?: string;
  modified?: string;
  status?: string;
  cvss?: { version: string; score: number; severity?: string; vector?: string; source?: string };
  weaknesses?: string[];
  references?: Array<{ url: string; tags: string[] }>;
}

export interface WebSearchResult {
  query: string;
  provider: "nvd" | "deepseek";
  retrievedAt: string;
  cached: boolean;
  totalResults: number;
  results: WebSearchHit[];
  notice: string;
}
