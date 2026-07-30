export class TotalTimeoutError extends Error {
  public override readonly name = "TotalTimeoutError";

  public constructor(timeoutMs: number) {
    super(`Total request deadline expired after ${String(timeoutMs)}ms.`);
  }
}

export class ResponseHeadersTimeoutError extends Error {
  public override readonly name = "ResponseHeadersTimeoutError";

  public constructor(timeoutMs: number) {
    super(`Response headers did not arrive within ${String(timeoutMs)}ms.`);
  }
}

export class RequestDeadline {
  public readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly externalSignal: AbortSignal | undefined;
  private disposed = false;

  public constructor(
    timeoutMs: number,
    externalSignal: AbortSignal | undefined,
  ) {
    this.signal = this.controller.signal;
    this.externalSignal = externalSignal;
    this.timer = setTimeout(() => {
      this.controller.abort(new TotalTimeoutError(timeoutMs));
    }, timeoutMs);
    if (externalSignal?.aborted === true) {
      this.controller.abort(externalSignal.reason);
    } else {
      externalSignal?.addEventListener("abort", this.abortFromExternal, {
        once: true,
      });
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.externalSignal?.removeEventListener(
      "abort",
      this.abortFromExternal,
    );
  }

  public abort(reason?: Error): void {
    if (!this.signal.aborted) this.controller.abort(reason);
  }

  private readonly abortFromExternal = (): void => {
    this.controller.abort(this.externalSignal?.reason);
  };
}

export class PhaseDeadline {
  public readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly parentSignal: AbortSignal;
  private disposed = false;

  public constructor(
    timeoutMs: number,
    parentSignal: AbortSignal,
    timeoutReason: Error,
  ) {
    this.signal = this.controller.signal;
    this.parentSignal = parentSignal;
    this.timer = setTimeout(() => {
      this.controller.abort(timeoutReason);
    }, timeoutMs);
    if (parentSignal.aborted) {
      this.controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", this.abortFromParent, {
        once: true,
      });
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.parentSignal.removeEventListener("abort", this.abortFromParent);
  }

  private readonly abortFromParent = (): void => {
    this.controller.abort(this.parentSignal.reason);
  };
}

export async function awaitWithSignal<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let removeListener = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("The operation was aborted.", {
              cause: signal.reason,
            }),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    removeListener = () => {
      signal.removeEventListener("abort", abort);
    };
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeListener();
  }
}
