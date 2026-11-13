const DEFAULT_USER_AGENT = "israel-job-discovery-poc/0.1 (personal research; public job boards only)";

let attemptBudget = null;

export class HttpError extends Error {
  constructor(message, { status = 0, retryable = false, url = "" } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryable = retryable;
    this.url = url;
  }
}

export function configureHttpAttemptBudget(maxAttempts) {
  const parsed = Number(maxAttempts);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`HTTP attempt budget must be a positive integer, received: ${maxAttempts}`);
  }
  attemptBudget = { max_attempts: parsed, attempts: 0, blocked_attempts: 0 };
  return httpAttemptBudgetSnapshot();
}

export function httpAttemptBudgetSnapshot() {
  return attemptBudget ? { ...attemptBudget } : null;
}

export function clearHttpAttemptBudget() {
  attemptBudget = null;
}

function consumeHttpAttempt(url) {
  if (!attemptBudget) return;
  if (attemptBudget.attempts >= attemptBudget.max_attempts) {
    attemptBudget.blocked_attempts += 1;
    throw new HttpError(`HTTP attempt budget exhausted before requesting ${url}`, {
      retryable: false,
      url,
    });
  }
  attemptBudget.attempts += 1;
}
function retryDelay(response, attempt, baseMs) {
  const retryAfter = response?.headers?.get("retry-after");
  if (retryAfter && Number.isFinite(Number(retryAfter))) return Math.min(Number(retryAfter) * 1000, 30_000);
  return Math.min(baseMs * (2 ** attempt), 10_000) + Math.floor(Math.random() * 150);
}

export async function request(url, {
  method = "GET",
  body,
  headers = {},
  timeoutMs = 20_000,
  retries = 2,
  retryBaseMs = 600,
  responseType = "json",
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      consumeHttpAttempt(url);
      response = await fetch(url, {
        method,
        body,
        headers: {
          accept: responseType === "json" ? "application/json" : "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "user-agent": DEFAULT_USER_AGENT,
          ...headers,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        const error = new HttpError(`HTTP ${response.status} from ${url}`, { status: response.status, retryable, url });
        if (!retryable || attempt === retries) throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt, retryBaseMs)));
        continue;
      }
      const data = responseType === "json" ? await response.json() : await response.text();
      return { data, status: response.status, finalUrl: response.url, headers: response.headers };
    } catch (error) {
      const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      const wrapped = error instanceof HttpError
        ? error
        : new HttpError(isTimeout ? `Timeout fetching ${url}` : `Request failed for ${url}: ${error.message}`, {
          retryable: true,
          url,
        });
      lastError = wrapped;
      if (!wrapped.retryable || attempt === retries) throw wrapped;
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt, retryBaseMs)));
    }
  }
  throw lastError;
}

export async function mapBounded(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}
