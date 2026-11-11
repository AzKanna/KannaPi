/** FlowFilter shape mirror — structural type shared with @kanna/database. */
import type { FlowSource } from "@kanna/shared";

export interface FlowFilter {
  host?: string;
  pathPrefix?: string;
  method?: string;
  statusCode?: number;
  actionId?: string;
  source?: FlowSource;
  sinceTs?: number;
  limit: number;
  offset: number;
}
