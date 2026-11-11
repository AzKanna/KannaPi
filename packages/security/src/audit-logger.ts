import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent } from "@kanna/shared";
import { newId } from "@kanna/shared";
import { SecretRedactor } from "./redactor.js";

export interface AuditWriter {
  append(event: AuditEvent): void;
}
export type AuditInput = Omit<AuditEvent, "id" | "timestamp"> & Partial<Pick<AuditEvent, "id" | "timestamp">>;

export class AuditLogger {
  constructor(
    private readonly writer: AuditWriter,
    private readonly jsonlPath?: string,
    private readonly redactor = new SecretRedactor(),
  ) {}

  async log(input: AuditInput): Promise<AuditEvent> {
    const event: AuditEvent = this.redactor.redact({
      ...input,
      id: input.id ?? newId("aud"),
      timestamp: input.timestamp ?? Date.now(),
    }) as AuditEvent;
    this.writer.append(event);
    if (this.jsonlPath) {
      await mkdir(dirname(this.jsonlPath), { recursive: true });
      await appendFile(this.jsonlPath, `${JSON.stringify(event)}\n`, "utf8");
    }
    return event;
  }
}
