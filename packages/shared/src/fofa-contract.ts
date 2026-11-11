export interface FofaConfigPublic {
  configured: boolean;
  endpoint: string;
}

export interface FofaAsset {
  host: string;
  ip: string;
  port: number;
  protocol: string;
  domain?: string;
  title?: string;
  country?: string;
  region?: string;
  city?: string;
  organization?: string;
  server?: string;
  link?: string;
}

export interface FofaSearchResult {
  query: string;
  total: number;
  page: number;
  next?: string;
  assets: FofaAsset[];
  consumedFPoints?: number;
  requiredFPoints?: number;
}
