export type SourceEvent =
  | {
      kind: "commit";
      did: string;
      collection: string;
      rkey: string;
      operation: "create" | "update" | "delete";
      payloadBytes?: number;
    }
  | {
      kind: "account";
      did: string;
      active: boolean;
      status?: string;
    }
  | {
      kind: "sync";
      did: string;
    };

export interface SourceBatch {
  events: SourceEvent[];
  checkpoint: number | string | null;
}

export interface SourceLoadOptions {
  signal?: AbortSignal;
}

export interface SourceLoader {
  readonly id: string;
  readonly service: string;
  load(options?: SourceLoadOptions): AsyncIterable<SourceBatch>;
  transportMetrics(): TransportMetrics;
  diagnostics?(): Record<string, unknown>;
}

export interface RequestMetric {
  requests: number;
  errors: number;
  response_bytes: number;
  content_length_bytes: number;
  header_ms: number;
  max_header_ms: number;
  statuses: Record<string, number>;
  content_encodings: Record<string, number>;
}

export interface TransportMetrics {
  requests: number;
  errors: number;
  response_bytes: number;
  content_length_bytes: number;
  by_operation: Record<string, RequestMetric>;
}

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof Request) return new URL(input.url);
    return new URL(String(input));
  } catch {
    return null;
  }
}

function operationFor(
  input: RequestInfo | URL,
  groupByHost: boolean,
): string {
  const url = requestUrl(input);
  if (!url) return "invalid-url";
  const operation = url.pathname.startsWith("/xrpc/")
    ? (url.pathname.split("/").filter(Boolean).at(-1) ?? url.pathname)
    : "did-document";
  return groupByHost ? `${url.host}/${operation}` : operation;
}

function emptyMetric(): RequestMetric {
  return {
    requests: 0,
    errors: 0,
    response_bytes: 0,
    content_length_bytes: 0,
    header_ms: 0,
    max_header_ms: 0,
    statuses: {},
    content_encodings: {},
  };
}

/** Fetch wrapper that counts response-body bytes actually consumed by a source.
 * Jetstream's archive payloads are already block-compressed, so this is also
 * the useful transfer-size measurement for its metered HTTP endpoints. */
export class MeteredFetch {
  private readonly metrics = new Map<string, RequestMetric>();
  private readonly base: typeof fetch;
  private readonly groupByHost: boolean;

  constructor(
    base: typeof fetch = globalThis.fetch,
    options: { groupByHost?: boolean } = {},
  ) {
    this.base = base;
    this.groupByHost = options.groupByHost !== false;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const operation = operationFor(input, this.groupByHost);
    const metric = this.metrics.get(operation) ?? emptyMetric();
    this.metrics.set(operation, metric);
    metric.requests++;
    const start = performance.now();

    let response: Response;
    try {
      response = await this.base(input, init);
    } catch (error) {
      metric.errors++;
      throw error;
    }

    const headerMs = performance.now() - start;
    metric.header_ms += headerMs;
    metric.max_header_ms = Math.max(metric.max_header_ms, headerMs);
    const status = String(response.status);
    metric.statuses[status] = (metric.statuses[status] ?? 0) + 1;
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isSafeInteger(contentLength) && contentLength >= 0) {
      metric.content_length_bytes += contentLength;
    }
    const encoding = response.headers.get("content-encoding") ?? "identity";
    metric.content_encodings[encoding] =
      (metric.content_encodings[encoding] ?? 0) + 1;

    if (!response.body) return response;
    const measured = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          metric.response_bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    );

    return new Response(measured, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  snapshot(): TransportMetrics {
    const byOperation = Object.fromEntries(
      [...this.metrics.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([operation, metric]) => [
          operation,
          {
            ...metric,
            header_ms: Math.round(metric.header_ms * 100) / 100,
            max_header_ms: Math.round(metric.max_header_ms * 100) / 100,
            statuses: { ...metric.statuses },
            content_encodings: { ...metric.content_encodings },
          },
        ]),
    );
    const values = Object.values(byOperation);
    return {
      requests: values.reduce((sum, metric) => sum + metric.requests, 0),
      errors: values.reduce((sum, metric) => sum + metric.errors, 0),
      response_bytes: values.reduce(
        (sum, metric) => sum + metric.response_bytes,
        0,
      ),
      content_length_bytes: values.reduce(
        (sum, metric) => sum + metric.content_length_bytes,
        0,
      ),
      by_operation: byOperation,
    };
  }
}
