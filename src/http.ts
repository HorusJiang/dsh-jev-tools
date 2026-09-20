/**
 * HTTP transport with the retry policy the API contract implies.
 *
 * The official SDK retries with backoff and honours `retry-after`; a direct
 * HTTP client has to implement that itself. The classification is not
 * "retry 5xx": `401` and `422` are permanent (a bad key and a bad body do not
 * become good on the second try), while `429` and `529` are transient by
 * definition and must back off.
 *
 * `fetchImpl` and `sleep` are injectable so the policy is testable without a
 * network and without real timers.
 *
 * @module dsh-jev-tools/http
 */

/** Why a request did not produce a usable response. */
export type HttpProblem =
  | 'unauthorized' | 'bad-request' | 'rate-limited' | 'overloaded'
  | 'server' | 'network' | 'aborted'

/** A usable response. */
export interface HttpOk {
  readonly kind: 'ok'
  readonly status: number
  readonly body: unknown
}

/** A failed request. */
export interface HttpError {
  readonly kind: 'error'
  readonly problem: HttpProblem
  readonly message: string
  readonly status?: number
  readonly attempt: number
}

/** The outcome of one request, retries included. */
export type HttpOutcome = HttpOk | HttpError

/** Injectable transport dependencies. */
export interface HttpDeps {
  readonly fetchImpl?: typeof fetch
  /** Sleep that rejects on abort, so a cancelled call stops immediately. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** One POST to attempt. */
export interface PostRequest {
  readonly url: string
  readonly body: unknown
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly timeoutMs: number
}

/** Extra retries allowed per problem, after the first attempt. */
const RETRY_LIMIT: Readonly<Record<string, number>> = {
  'rate-limited': 3,
  overloaded: 3,
  server: 3,
  network: 2,
}

/** Base delay for exponential backoff, in milliseconds. */
const BASE_DELAY_MS = 250

/** Ceiling for a single backoff delay, in milliseconds. */
const MAX_DELAY_MS = 4_000

/** Default sleep that rejects when the signal aborts. */
function defaultSleep (ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    function onAbort (): void {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Read a `retry-after` header.
 *
 * Only the delta-seconds form is honoured; the HTTP-date form is rare here and
 * silently guessing a date would be worse than falling back to backoff.
 *
 * @param headers - the response headers.
 * @returns the delay in milliseconds, or `undefined` when absent or unusable.
 */
export function parseRetryAfter (headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (raw === null) return undefined
  const seconds = Number(raw.trim())
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.min(seconds * 1_000, MAX_DELAY_MS)
}

/** Classify a non-2xx status. */
function problemFor (status: number): HttpProblem {
  if (status === 401) return 'unauthorized'
  if (status === 422) return 'bad-request'
  if (status === 429) return 'rate-limited'
  if (status === 529) return 'overloaded'
  return 'server'
}

/**
 * POST JSON, retrying only what retrying can fix.
 *
 * @param request - the request to send.
 * @param deps - injectable transport pieces.
 * @returns a usable body, or the classification of the failure.
 */
export async function postJson (request: PostRequest, deps: HttpDeps = {}): Promise<HttpOutcome> {
  const doFetch = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  let attempt = 0
  let last: HttpError | undefined

  for (;;) {
    if (request.signal.aborted) {
      return { kind: 'error', problem: 'aborted', message: '请求已取消', attempt }
    }
    attempt += 1

    // A per-attempt timeout that also honours the caller's cancellation.
    const timeout = AbortSignal.timeout(request.timeoutMs)
    const combined = AbortSignal.any([request.signal, timeout])

    let response: Response
    try {
      response = await doFetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...request.headers },
        body: JSON.stringify(request.body),
        signal: combined,
      })
    } catch (error) {
      if (request.signal.aborted) {
        return { kind: 'error', problem: 'aborted', message: '请求已取消', attempt }
      }
      last = { kind: 'error', problem: 'network', message: `网络错误：${String(error)}`, attempt }
      const limit = RETRY_LIMIT.network ?? 0
      if (attempt > limit) return last
      await backoff(sleep, attempt, undefined, request.signal)
      continue
    }

    if (response.ok) {
      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        return { kind: 'error', problem: 'server', message: `响应不是合法 JSON：${String(error)}`, status: response.status, attempt }
      }
      return { kind: 'ok', status: response.status, body }
    }

    const problem = problemFor(response.status)
    const detail = await readErrorDetail(response)
    last = {
      kind: 'error',
      problem,
      message: detail === '' ? `HTTP ${response.status}` : `HTTP ${response.status}：${detail}`,
      status: response.status,
      attempt,
    }

    const limit = RETRY_LIMIT[problem]
    if (limit === undefined || attempt > limit) return last
    await backoff(sleep, attempt, parseRetryAfter(response.headers), request.signal)
  }
}

/** Read a failing response's body for the field the server objected to. */
async function readErrorDetail (response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.slice(0, 400)
  } catch {
    return ''
  }
}

/** Wait before the next attempt: an explicit `retry-after` wins over backoff. */
async function backoff (
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  attempt: number,
  retryAfterMs: number | undefined,
  signal: AbortSignal
): Promise<void> {
  const delay = retryAfterMs ?? Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS)
  try {
    await sleep(delay, signal)
  } catch {
    // The sleep rejected because the caller aborted; the next loop turn sees
    // the aborted signal and returns the `aborted` classification.
  }
}
