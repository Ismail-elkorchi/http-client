import type {
  HttpClientEvent,
  HttpClientObserver,
} from "./types.js";

export function emitHttpClientEvent(
  observer: HttpClientObserver | undefined,
  event: HttpClientEvent,
): void {
  try {
    observer?.onEvent(event);
  } catch {
    // Observers cannot alter request execution.
  }
}
