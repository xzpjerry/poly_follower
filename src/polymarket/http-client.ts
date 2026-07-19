import type { Logger } from "pino";

export class HttpRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number | null,
    public readonly url: string,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

export class JsonHttpClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
    private readonly maxAttempts = 3,
  ) {}

  public async get(pathname: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const url = new URL(pathname, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return this.request(url);
  }

  private async request(url: URL): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text();
          const error = new HttpRequestError(
            `GET ${url.toString()} failed with ${response.status}: ${body.slice(0, 500)}`,
            response.status,
            url.toString(),
          );
          if (response.status !== 429 && response.status < 500) {
            throw error;
          }
          lastError = error;
        } else {
          return await response.json();
        }
      } catch (error) {
        if (error instanceof HttpRequestError && error.status !== 429 && error.status !== null && error.status < 500) {
          throw error;
        }
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }

      if (attempt < this.maxAttempts) {
        const delayMs = 250 * 2 ** (attempt - 1);
        this.logger.warn({ url: url.toString(), attempt, delayMs, error: String(lastError) }, "HTTP request retry");
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new HttpRequestError(`GET ${url.toString()} failed`, null, url.toString());
  }
}
