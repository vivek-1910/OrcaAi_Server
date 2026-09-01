export class ProviderRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderRequestError";
    this.status = status;
  }
}

function makeSignal(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
  };
}

export async function fetchText(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<{ text: string; response: Response }> {
  const request = makeSignal(init.signal ?? undefined, timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: request.signal });
    const text = await response.text();

    if (!response.ok) {
      throw new ProviderRequestError(
        `${response.status} ${response.statusText || "request failed"}`,
        response.status,
      );
    }

    return { text, response };
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "request failed";
    throw new ProviderRequestError(message);
  } finally {
    request.cleanup();
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<T> {
  const result = await fetchText(url, init, timeoutMs);

  try {
    return JSON.parse(result.text) as T;
  } catch {
    throw new ProviderRequestError("provider returned invalid JSON");
  }
}

export function configured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function unavailable<T>(
  provider: string,
  reason: string,
): import("../types/fishing.js").ProviderResult<T> {
  return {
    provider,
    status: "unavailable",
    warnings: [reason],
    evidence: [
      {
        provider,
        title: `${provider} unavailable`,
        fetchedAt: new Date().toISOString(),
        status: "unavailable",
        stale: true,
      },
    ],
    error: reason,
  };
}
