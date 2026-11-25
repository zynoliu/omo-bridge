/**
 * The correlator for host `extension_request` round trips.
 *
 * A request is written by the launcher, answered by the host with one `extension_response`-shaped
 * frame carrying the same id, and nothing else may resolve it: an unknown id, a duplicate answer and
 * a late answer after a timeout are all reported, never silently accepted. The module carries no
 * payload knowledge - it never encodes a host frame - so it cannot invent a request the host does
 * not document.
 */
export type ExtensionRequester = {
  /** Registers the id, writes one frame, and resolves with the matching answer or rejects. */
  readonly request: (id: string, frame: unknown) => Promise<unknown>
  /** Delivers one answer frame. Returns what happened so the caller can log a stray answer. */
  readonly accept: (id: string, answer: unknown) => "resolved" | "unknown" | "duplicate"
  /** Rejects every pending request, for example when the transport closes. */
  readonly failAll: (reason: string) => number
  readonly pending: () => readonly string[]
}

export type ExtensionRequesterOptions = {
  readonly write: (frame: unknown) => void
  readonly timeoutMs?: number
  readonly setTimer?: (run: () => void, ms: number) => { readonly cancel: () => void }
}

const DEFAULT_TIMEOUT_MS = 30_000

export class ExtensionRequestError extends Error {
  readonly code: "timeout" | "duplicate_id" | "transport" | "write_failed"
  constructor(code: ExtensionRequestError["code"], message: string) {
    super(message)
    this.code = code
    this.name = "ExtensionRequestError"
  }
}

export function createExtensionRequester(options: ExtensionRequesterOptions): ExtensionRequester {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = options.setTimer ?? ((run, ms) => {
    const handle = setTimeout(run, ms)
    return { cancel: () => clearTimeout(handle) }
  })
  const answered = new Set<string>()
  const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; cancel: () => void }>()

  return {
    request(id, frame) {
      if (waiting.has(id)) return Promise.reject(new ExtensionRequestError("duplicate_id", "request id already pending: " + id))
      return new Promise<unknown>((resolve, reject) => {
        const cancel = timer(() => {
          waiting.delete(id)
          reject(new ExtensionRequestError("timeout", "no answer for request " + id + " within " + String(timeoutMs) + "ms"))
        }, timeoutMs).cancel
        waiting.set(id, { resolve: resolve, reject: reject, cancel: cancel })
        try {
          options.write(frame)
        } catch (cause) {
          waiting.delete(id)
          cancel()
          reject(new ExtensionRequestError("write_failed", "the request frame could not be written: " + describe(cause)))
        }
      })
    },
    accept(id, answer) {
      const entry = waiting.get(id)
      if (entry === undefined) return answered.has(id) ? "duplicate" : "unknown"
      waiting.delete(id)
      entry.cancel()
      answered.add(id)
      if (answered.size > 256) {
        const oldest = answered.values().next()
        if (!oldest.done) answered.delete(oldest.value)
      }
      entry.resolve(answer)
      return "resolved"
    },
    failAll(reason) {
      const ids = [...waiting.keys()]
      for (const id of ids) {
        const entry = waiting.get(id)
        if (entry === undefined) continue
        waiting.delete(id)
        entry.cancel()
        entry.reject(new ExtensionRequestError("transport", reason))
      }
      return ids.length
    },
    pending() {
      return [...waiting.keys()]
    },
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
