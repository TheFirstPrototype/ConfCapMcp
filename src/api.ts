import { Config, redact } from "./config.js";

export class ApiError extends Error {
  constructor(message: string, public status: number, public retryable: boolean) {
    super(message);
  }
}

export interface Response2 {
  status: number;
  body: any;
  /** True when the server answered 304 and `body` is the previously stored copy. */
  notModified: boolean;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Per-stream minimum gap for the caption endpoint: the rate of one attendee page. */
export const CAPTION_INTERVAL_MS = 1000;
const GLOBAL_PER_SECOND = 5;
const MAX_TRIES = 3;

type Credential = "none" | "key";

/**
 * A read-only client for the ConferenceCaptioning API: it can only issue GET. It keeps ETags per URL, spaces calls to
 * one stream at 1/s and all calls at 5/s, retries 5xx with backoff, and honours 429 Retry-After. There is no
 * module-level state, so two clients (two credentials) never share cached text.
 */
export class ApiClient {
  private etags = new Map<string, { etag: string; body: any }>();
  private lastCall = new Map<string, number>();
  private recent: number[] = [];

  constructor(private config: Config, private fetchImpl: typeof fetch = fetch, private clock: Clock = realClock) {}

  async get(path: string, query: Record<string, string | number | boolean | undefined>, opts: { credential?: Credential; streamKey?: string } = {}): Promise<Response2> {
    const url = new URL(this.config.baseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const cacheKey = url.toString();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.credential === "key" && this.config.key) headers.Authorization = `Bearer ${this.config.key}`;
    // The credential decides what the server returns, so it is part of the cache identity.
    const identity = (headers.Authorization ? "key:" : "anon:") + cacheKey;

    if (opts.streamKey) {
      const last = this.lastCall.get(opts.streamKey);
      const cached = this.etags.get(identity);
      if (last !== undefined && this.clock.now() - last < CAPTION_INTERVAL_MS && cached) {
        return { status: 200, body: cached.body, notModified: true };
      }
      if (last !== undefined) {
        const wait = CAPTION_INTERVAL_MS - (this.clock.now() - last);
        if (wait > 0) await this.clock.sleep(wait);
      }
    }
    const cached = this.etags.get(identity);
    if (cached) headers["If-None-Match"] = cached.etag;

    let lastError: ApiError | undefined;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      await this.throttle();
      let res: globalThis.Response;
      try {
        res = await this.fetchImpl(cacheKey, { method: "GET", headers });
      } catch (err) {
        lastError = new ApiError(redact(`Could not reach the API: ${(err as Error).message}`, this.config), 0, true);
        if (attempt < MAX_TRIES) { await this.clock.sleep(250 * 2 ** (attempt - 1)); continue; }
        throw lastError;
      }
      if (opts.streamKey) this.lastCall.set(opts.streamKey, this.clock.now());
      if (res.status === 304 && cached) return { status: 200, body: cached.body, notModified: true };
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After")) || 1;
        lastError = new ApiError("The API asked us to slow down (429).", 429, true);
        if (attempt < MAX_TRIES) { await this.clock.sleep(Math.min(retryAfter, 30) * 1000); continue; }
        throw lastError;
      }
      if (res.status >= 500) {
        lastError = new ApiError(`The API had a problem (${res.status}).`, res.status, true);
        if (attempt < MAX_TRIES) { await this.clock.sleep(250 * 2 ** (attempt - 1)); continue; }
        throw lastError;
      }
      const text = await res.text();
      let body: any = text;
      try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      const etag = res.headers.get("ETag");
      if (res.status === 200 && etag) this.etags.set(identity, { etag, body });
      return { status: res.status, body, notModified: false };
    }
    throw lastError ?? new ApiError("Request failed.", 0, true);
  }

  private async throttle() {
    const now = this.clock.now();
    this.recent = this.recent.filter((t) => now - t < 1000);
    if (this.recent.length >= GLOBAL_PER_SECOND) {
      const wait = 1000 - (now - this.recent[0]);
      if (wait > 0) await this.clock.sleep(wait);
    }
    this.recent.push(this.clock.now());
  }
}
