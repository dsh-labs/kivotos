// A minimal Chrome DevTools Protocol client for the app's WebView pages:
// list the page targets behind an adb forward, and evaluate in one of them.

/** How long one protocol call may take before it fails. */
const CALL_MS = 8000;

export interface PageTarget {
  id: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface Reply {
  id?: number;
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  error?: { message?: string };
}

/** @returns every page target the WebView DevTools socket at `port` lists. */
export async function pageTargets(port: number): Promise<PageTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(CALL_MS),
  });
  const list = (await response.json()) as (PageTarget & { type: string })[];
  return list.filter((target) => target.type === "page");
}

/** One open DevTools session with a page. */
export class Page {
  readonly id: string;
  private readonly ws: WebSocket;
  private next = 0;
  private readonly waiting = new Map<number, (reply: Reply) => void>();
  private closed = false;

  private constructor(target: PageTarget, ws: WebSocket) {
    this.id = target.id;
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const reply = JSON.parse(String(event.data)) as Reply;
      if (reply.id === undefined) return;
      this.waiting.get(reply.id)?.(reply);
      this.waiting.delete(reply.id);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const resolve of this.waiting.values()) {
        resolve({ error: { message: "the DevTools connection closed" } });
      }
      this.waiting.clear();
    });
  }

  static async open(target: PageTarget): Promise<Page> {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const opened = Promise.withResolvers<void>();
    const timer = setTimeout(
      () => opened.reject(new Error(`DevTools: ${target.id} did not open`)),
      CALL_MS,
    );
    ws.addEventListener("open", () => opened.resolve());
    ws.addEventListener("error", () =>
      opened.reject(new Error(`DevTools: cannot connect to ${target.id}`)),
    );
    try {
      await opened.promise;
    } finally {
      clearTimeout(timer);
    }
    return new Page(target, ws);
  }

  get open(): boolean {
    return !this.closed;
  }

  /**
   * Evaluates `expression` (awaiting a promise it returns) and returns its
   * value as JSON. A thrown exception or a call that times out is an error.
   */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    if (this.closed) throw new Error("DevTools: the page connection is closed");
    this.next += 1;
    const id = this.next;
    const answered = Promise.withResolvers<Reply>();
    const timer = setTimeout(() => {
      if (this.waiting.delete(id)) {
        answered.resolve({ error: { message: `no answer in ${CALL_MS} ms` } });
      }
    }, CALL_MS);
    this.waiting.set(id, answered.resolve);
    this.ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
    const reply = await answered.promise;
    clearTimeout(timer);
    if (reply.error !== undefined) throw new Error(`DevTools: ${reply.error.message ?? "error"}`);
    const thrown = reply.result?.exceptionDetails;
    if (thrown !== undefined) {
      throw new Error(`page: ${thrown.exception?.description ?? thrown.text ?? "exception"}`);
    }
    return reply.result?.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}
