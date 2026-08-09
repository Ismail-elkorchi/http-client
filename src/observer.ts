import type {
  HttpClientEvent,
  HttpClientObserver,
} from "./types.ts";

export function emitHttpClientEvent(
  observer: HttpClientObserver | undefined,
  event: HttpClientEvent,
): void {
  try {
    const result = observer?.onEvent(event);
    if (result !== undefined) {
      void Promise.resolve(result).catch(ignoreFailure);
    }
  } catch {
    // Observers cannot alter request execution.
  }
}

function ignoreFailure(): void {}
