/**
 * Counts execute-plan calls per request and refuses calls beyond the limit in the signed request
 * context (`max_tool_calls`). The limit is the api's own check: the model and ai-engine cannot raise it.
 * In memory and per process, like the question rate limit; a shared store comes with horizontal scaling.
 */
export class ToolCallBudget {
  private readonly counts = new Map<string, { used: number; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Returns true when the call may proceed. The request's own expiry bounds how long it is remembered. */
  take(requestId: string, limit: number, expiresAt: number): boolean {
    const t = this.now();
    for (const [id, e] of this.counts) if (e.expiresAt <= t) this.counts.delete(id);
    const entry = this.counts.get(requestId) ?? { used: 0, expiresAt };
    if (entry.used >= limit) return false;
    entry.used += 1;
    this.counts.set(requestId, entry);
    return true;
  }
}

export const DEFAULT_MAX_TOOL_CALLS = 6;
