import type { Scope } from "@kanna/shared";
import { urlInScope } from "@kanna/shared";

export class ScopeManager {
  constructor(readonly scope: Scope) {}
  check(url: string): { ok: true } | { ok: false; reason: string } {
    return urlInScope(this.scope, url);
  }
  assert(url: string): void {
    const result = this.check(url);
    if (!result.ok) throw new Error(`Scope denied: ${result.reason}`);
  }
}
