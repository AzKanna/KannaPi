export interface RequestLabTab {
  id: string;
  projectId: string;
  name: string;
  sourceSessionId?: string;
  sourceFlowId?: string;
  /** Immutable network boundary derived from the captured request. */
  allowedOrigin: string;
  rawRequest: string;
  createdAt: number;
  updatedAt: number;
}

export interface RequestLabExchange {
  id: string;
  tabId: string;
  requestUrl: string;
  rawRequest: string;
  statusCode?: number;
  statusText?: string;
  responseHeaders: Record<string, string>;
  responseBody: string;
  responseTruncated: boolean;
  durationMs?: number;
  error?: string;
  createdAt: number;
}

export interface RequestLabSendResult {
  tab: RequestLabTab;
  exchange: RequestLabExchange;
}
