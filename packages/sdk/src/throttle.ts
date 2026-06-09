/**
 * Client-side rate limiting for replayed requests.
 *
 * A provider can declare `x-mastro-replay.rate_limit.requests_per_minute`. We
 * honor it with a token bucket so a burst (e.g. a workflow `foreach` uploading
 * many photos, or rapid agent calls) is paced to the declared budget rather
 * than hammering the unofficial API — which is both an ethics expectation
 * (see the README) and the surest way to avoid a 429 ban.
 *
 * The bucket refills continuously at `rpm/60` tokens per second and is capped at
 * `rpm` tokens, so a single command after an idle period can still burst up to
 * the per-minute budget, while a sustained stream is paced evenly.
 */
import type { Transport } from "./transport.ts";
import { sleep } from "./util.ts";

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  /** @param ratePerMinute sustained budget; also the burst capacity. */
  constructor(private readonly ratePerMinute: number) {
    // Sub-1 rates are nonsensical for "requests per minute" and would make the
    // first take() stall for minutes — reject early rather than silently hang.
    if (!(ratePerMinute >= 1)) throw new Error(`invalid rate_limit (need >= 1/min): ${ratePerMinute}`);
    this.tokens = ratePerMinute;
    this.lastRefill = Date.now();
  }

  /** Block until a token is available, then consume it. */
  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Wait just long enough for the next token to accrue.
      const perToken = 60_000 / this.ratePerMinute;
      await sleep(Math.ceil((1 - this.tokens) * perToken));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.ratePerMinute, this.tokens + (elapsed / 60_000) * this.ratePerMinute);
    this.lastRefill = now;
  }
}

/**
 * Wrap a transport so every `send()` first waits on a shared token bucket.
 * Returns the transport unchanged when no rate limit is configured, so the
 * common case adds nothing.
 */
export function throttled(transport: Transport, requestsPerMinute: number | undefined): Transport {
  if (!requestsPerMinute || requestsPerMinute <= 0) return transport;
  const bucket = new TokenBucket(requestsPerMinute);
  return {
    name: `${transport.name}+throttle(${requestsPerMinute}/min)`,
    async send(req) {
      await bucket.take();
      return transport.send(req);
    },
  };
}
