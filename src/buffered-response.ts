import { BodyStorageError } from "./body-collector.js";
import {
  disposeResponseBody,
  storeResponseBody,
} from "./body.js";
import type { ResolvedRequestOptions } from "./configuration.js";
import { HttpClientError } from "./errors.js";
import {
  clientError,
  failureFromResponse,
} from "./outcomes.js";
import type {
  BufferedHttpResponse,
  BufferedHttpResult,
  StreamingHttpResult,
} from "./types.js";

export async function bufferResult(
  result: StreamingHttpResult,
  options: ResolvedRequestOptions,
): Promise<BufferedHttpResult> {
  if (result.kind === "failure") return result;
  let body;
  try {
    body = await storeResponseBody(result.body, options.responseStorage);
  } catch (caught) {
    if (caught instanceof HttpClientError) {
      const completion = await result.completion;
      return failureFromResponse(
        result,
        completion.kind === "failure" ? completion.error : caught,
        completion.transfer,
      );
    }
    result.cancel(
      caught instanceof Error ? caught : new Error("Body storage failed."),
    );
    const completion = await result.completion;
    if (completion.kind === "failure") {
      return failureFromResponse(
        result,
        completion.error,
        completion.transfer,
      );
    }
    const error = clientError(
      "FILESYSTEM_FAILURE",
      caught instanceof BodyStorageError
        ? caught.message
        : "Response body storage failed.",
      result.finalUrl,
      caught,
    );
    return failureFromResponse(result, error, completion.transfer);
  }

  const completion = await result.completion;
  if (completion.kind !== "complete") {
    await disposeResponseBody(body);
    const error =
      completion.kind === "failure"
        ? completion.error
        : clientError(
            "REQUEST_ABORTED",
            "Response body collection was cancelled.",
            result.finalUrl,
          );
    return failureFromResponse(result, error, completion.transfer);
  }
  const buffered: BufferedHttpResponse = {
    kind: "response",
    statusCode: result.statusCode,
    statusMessage: result.statusMessage,
    finalUrl: result.finalUrl,
    headers: result.headers,
    redirects: result.redirects,
    connection: result.connection,
    headTimings: result.headTimings,
    body,
    transfer: completion.transfer,
  };
  return buffered;
}
