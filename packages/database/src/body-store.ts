/**
 * Content-addressed body storage (ADR-005): raw bytes deduplicated by sha256 in
 * the `blobs` table; flows reference them by hash via BodyRef columns.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BodyRef } from "@kanna/shared";
import { OUTPUT_LIMITS } from "@kanna/shared";

export interface StoredBody {
  hash: string;
  size: number;
  truncated: boolean;
}

export class BodyStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Store raw body bytes (dedup by sha256) and return the BodyRef fields. */
  put(bytes: Uint8Array, options?: { mimeType?: string; truncated?: boolean }): StoredBody {
    const hash = createHash("sha256").update(bytes).digest("hex");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO blobs (hash, size, mime_type, data) VALUES (?, ?, ?, ?)",
      )
      .run(hash, bytes.byteLength, options?.mimeType ?? null, bytes);
    return { hash, size: bytes.byteLength, truncated: options?.truncated ?? false };
  }

  get(hash: string): Uint8Array | undefined {
    const row = this.db.prepare("SELECT data FROM blobs WHERE hash = ?").get(hash) as
      | { data: Uint8Array }
      | undefined;
    return row?.data;
  }

  has(hash: string): boolean {
    const row = this.db.prepare("SELECT 1 AS ok FROM blobs WHERE hash = ?").get(hash) as
      | { ok: number }
      | undefined;
    return row !== undefined;
  }

  /** Decode bytes to displayable text (lossy, control chars stripped) for previews. */
  static textPreview(bytes: Uint8Array, limit = OUTPUT_LIMITS.textPreviewChars): string | undefined {
    if (bytes.byteLength === 0) return undefined;
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, limit * 4));
    const cleaned = decoded.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, limit);
    return cleaned.length > 0 ? cleaned : undefined;
  }

  /** Build a full BodyRef (store + preview). */
  putRef(bytes: Uint8Array, options?: { mimeType?: string; truncated?: boolean }): BodyRef {
    const stored = this.put(bytes, options);
    return {
      blobHash: stored.hash,
      size: stored.size,
      mimeType: options?.mimeType,
      truncated: stored.truncated,
      textPreview: BodyStore.textPreview(bytes),
    };
  }
}
