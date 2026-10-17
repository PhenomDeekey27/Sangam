/**
 * Shared HTTP plumbing for the three Sarvam adapters.
 *
 * Every Sarvam call is a single short REST round trip with one auth header
 * (`api-subscription-key`) and a structured error body
 * (`{"error": {"code": "…"}}`). Rather than repeat the abort/timeout, status
 * and quota classification three times, the adapters share this module and
 * only translate the outcome into their own provider error type.
 *
 * Safety rules enforced here:
 * - the key travels only as a request header — never in a URL, log or error;
 *   callers receive failure *kinds* and the documented error enum, not bodies;
 * - every request has a hard deadline enforced with `AbortController`;
 * - `invalid_api_key_error` (permanent) is separated from
 *   `rate_limit_exceeded_error` / `insufficient_quota_error` (retry later)
 *   and from transient `gateway_timeout_error` / 5xx outages.
 */

/** How a Sarvam call failed, normalized across the three APIs. */
export type SarvamFailureKind =
  | "timeout"
  | "network"
  | "rate_limited"
  | "auth"
  | "rejected"
  | "server"
  | "malformed";

/** A safe, log-friendly Sarvam failure. `detail` never holds the key. */
export interface SarvamFailure {
  readonly kind: SarvamFailureKind;
  /** Upstream HTTP status when a response was received. */
  readonly status: number | null;
  /** Bounded, non-sensitive description (status plus documented error enum). */
  readonly detail: string;
  /** True when the account's quota or rate limit is the cause. */
  readonly quota: boolean;
}

export type SarvamResponse =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly failure: SarvamFailure };

export interface SarvamRequest {
  readonly url: string;
  readonly method?: "POST";
  /** Sent only as `api-subscription-key`. */
  readonly apiKey: string;
  readonly body: string | FormData;
  /** Set for multipart uploads; JSON requests default to application/json. */
  readonly contentType?: string;
  readonly timeoutMs?: number;
  /** Injectable HTTP layer; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

/** Deadline for one Sarvam round trip; the caller may override per adapter. */
export const DEFAULT_SARVAM_TIMEOUT_MS = 20_000;

/** Perform one JSON/multipart request and normalize its outcome. */
export async function sarvamRequest(
  request: SarvamRequest,
): Promise<SarvamResponse> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const timeoutMs =
    typeof request.timeoutMs === "number" && request.timeoutMs > 0
      ? Math.floor(request.timeoutMs)
      : DEFAULT_SARVAM_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Never hold the process open for a hung provider call.
  (timer as unknown as { unref?: () => void }).unref?.();
  // Honour an external abort (session closed mid-flight) as well as ours.
  const onExternalAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onExternalAbort);
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method ?? "POST",
      headers: {
        "api-subscription-key": request.apiKey,
        ...(request.body instanceof FormData
          ? {}
          : { "Content-Type": request.contentType ?? "application/json" }),
      },
      body: request.body,
      signal: controller.signal,
    });
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: isAbortError(error) ? "timeout" : "network",
        status: null,
        detail: isAbortError(error)
          ? "request timed out"
          : `request failed: ${errorName(error)}`,
        quota: false,
      },
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onExternalAbort);
  }

  if (!response.ok) {
    const enumCode = await readSarvamErrorCode(response);
    return { ok: false, failure: classify(response.status, enumCode) };
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return {
      ok: false,
      failure: {
        kind: "malformed",
        status: response.status,
        detail: "response was not JSON",
        quota: false,
      },
    };
  }
  return { ok: true, status: response.status, body };
}

/**
 * Documented Sarvam error codes → failure kind. Used both for HTTP status
 * classification and for a response that is 2xx but carries a structured
 * error, so a "200 with an error code" can never be mistaken for success.
 */
const ERROR_CODE_KINDS: Readonly<Record<string, SarvamFailureKind>> = {
  invalid_api_key_error: "auth",
  authentication_error: "auth",
  insufficient_quota_error: "rate_limited",
  rate_limit_exceeded_error: "rate_limited",
  gateway_timeout_error: "timeout",
  model_call_error: "server",
  internal_server_error: "server",
  billing_service_unavailable_error: "server",
  invalid_request_error: "rejected",
  unprocessable_entity_error: "rejected",
  not_found_error: "rejected",
};

/** The documented error enum from a Sarvam error body, or `null`. */
export function sarvamErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  const source =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : (body as { code?: unknown }).code;
  return typeof source === "string" ? source : null;
}

/** Map a documented error enum onto a normalized failure kind. */
export function kindForErrorCode(code: string | null): SarvamFailureKind | null {
  if (code === null) return null;
  return ERROR_CODE_KINDS[code] ?? null;
}

function classify(status: number, enumCode: string | null): SarvamFailure {
  const fromEnum = kindForErrorCode(enumCode);
  const kind: SarvamFailureKind =
    fromEnum ??
    (status === 429
      ? "rate_limited"
      : status === 401 || status === 403
        ? "auth"
        : status === 408 || status === 504
          ? "timeout"
          : status >= 500
            ? "server"
            : "rejected");
  return {
    kind,
    status,
    detail: `status=${status} code=${enumCode ?? "unknown"}`,
    quota: kind === "rate_limited",
  };
}

/** Read the documented error enum without ever surfacing the raw body. */
async function readSarvamErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as unknown;
    return sarvamErrorCode(body);
  } catch {
    return null;
  }
}

/** Node's fetch rejects with a DOMException named `AbortError`. */
export function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

/** Fail-safe JSON object guard shared by the adapters. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
