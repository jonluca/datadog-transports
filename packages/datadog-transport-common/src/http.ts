import pako from "pako";

import {
  type HttpLibrary,
  type RequestContext,
  ResponseContext,
  type ZstdCompressorCallback,
} from "@datadog/datadog-api-client/dist/packages/datadog-api-client-common";
import { logger } from "@datadog/datadog-api-client";
/* eslint-disable node/no-deprecated-api */

const isModern =
  typeof Buffer !== "undefined" &&
  typeof Buffer.alloc === "function" &&
  typeof Buffer.allocUnsafe === "function" &&
  typeof Buffer.from === "function";

function isArrayBuffer(input) {
  return Object.prototype.toString.call(input).slice(8, -1) === "ArrayBuffer";
}

function fromArrayBuffer(obj, byteOffset = 0, length?: number) {
  byteOffset >>>= 0;

  const maxLength = obj.byteLength - byteOffset;

  if (maxLength < 0) {
    throw new RangeError("'offset' is out of bounds");
  }

  if (length === undefined) {
    length = maxLength;
  } else {
    length >>>= 0;

    if (length > maxLength) {
      throw new RangeError("'length' is out of bounds");
    }
  }

  return isModern
    ? Buffer.from(obj.slice(byteOffset, byteOffset + length))
    : new Buffer(new Uint8Array(obj.slice(byteOffset, byteOffset + length)));
}

function fromString(string, encoding) {
  if (typeof encoding !== "string" || encoding === "") {
    encoding = "utf8";
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('"encoding" must be a valid string encoding');
  }

  return isModern
    ? Buffer.from(string, encoding)
    : new Buffer(string, encoding);
}

function bufferFrom(value, encodingOrOffset?: number, length?: number) {
  if (typeof value === "number") {
    throw new TypeError('"value" argument must not be a number');
  }

  if (isArrayBuffer(value)) {
    return fromArrayBuffer(value, encodingOrOffset, length);
  }

  if (typeof value === "string") {
    return fromString(value, encodingOrOffset);
  }

  return isModern ? Buffer.from(value) : new Buffer(value);
}

export class IsomorphicFetchHttpLibrary implements HttpLibrary {
  public debug = false;
  public zstdCompressorCallback: ZstdCompressorCallback | undefined;
  public enableRetry!: boolean;
  public maxRetries!: number;
  public backoffBase!: number;
  public backoffMultiplier!: number;

  public send(request: RequestContext): Promise<ResponseContext> {
    if (this.debug) {
      this.logRequest(request);
    }
    const method = request.getHttpMethod().toString();
    let body = request.getBody();

    let compress = request.getHttpConfig().compress;
    if (compress === undefined) {
      compress = true;
    }

    const headers = request.getHeaders();

    if (typeof body === "string") {
      if (headers["Content-Encoding"] === "gzip") {
        body = bufferFrom(pako.gzip(body).buffer);
      } else if (headers["Content-Encoding"] === "deflate") {
        body = bufferFrom(pako.deflate(body).buffer);
      } else if (headers["Content-Encoding"] === "zstd1") {
        if (this.zstdCompressorCallback) {
          body = this.zstdCompressorCallback(body);
        } else {
          throw new Error("zstdCompressorCallback method missing");
        }
      }
    }

    if (!headers["Accept-Encoding"]) {
      if (compress) {
        headers["Accept-Encoding"] = "gzip,deflate";
      } else {
        // We need to enforce it otherwise node-fetch will set a default
        headers["Accept-Encoding"] = "identity";
      }
    }

    return this.executeRequest(request, body, 0, headers);
  }

  private async executeRequest(
    request: RequestContext,
    body: any,
    currentAttempt: number,
    headers: { [key: string]: string }
  ): Promise<ResponseContext> {
    const fetchOptions = {
      method: request.getHttpMethod().toString(),
      body: body,
      headers: headers,
      signal: request.getHttpConfig().signal,
    };
    try {
      const resp = await fetch(request.getUrl(), fetchOptions);
      const responseHeaders: { [name: string]: string } = {};
      resp.headers.forEach((value: string, name: string) => {
        responseHeaders[name] = value;
      });

      const responseBody = {
        text: () => resp.text(),
        binary: async () => {
          const arrayBuffer = await resp.arrayBuffer();
          return Buffer.from(arrayBuffer);
        },
      };

      const response = new ResponseContext(
        resp.status,
        responseHeaders,
        responseBody
      );

      if (this.debug) {
        this.logResponse(response);
      }

      if (
        this.shouldRetry(
          this.enableRetry,
          currentAttempt,
          this.maxRetries,
          response.httpStatusCode
        )
      ) {
        const delay = this.calculateRetryInterval(
          currentAttempt,
          this.backoffBase,
          this.backoffMultiplier,
          responseHeaders
        );
        currentAttempt++;
        await this.sleep(delay * 1000);
        return this.executeRequest(request, body, currentAttempt, headers);
      }
      return response;
    } catch (error) {
      logger.error("An error occurred during the HTTP request:", error);
      const responseBody = {
        text: async () => "ok",
        binary: async () => {
          return Buffer.from("ok");
        },
      };
      return new ResponseContext(200, {}, responseBody);
    }
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }

  private shouldRetry(
    enableRetry: boolean,
    currentAttempt: number,
    maxRetries: number,
    responseCode: number
  ): boolean {
    return (
      (responseCode === 429 || responseCode >= 500) &&
      maxRetries > currentAttempt &&
      enableRetry
    );
  }

  private calculateRetryInterval(
    currentAttempt: number,
    backoffBase: number,
    backoffMultiplier: number,
    headers: { [name: string]: string }
  ): number {
    if ("x-ratelimit-reset" in headers) {
      const rateLimitHeaderString = headers["x-ratelimit-reset"];
      const retryIntervalFromHeader = Number.parseInt(
        rateLimitHeaderString,
        10
      );
      return retryIntervalFromHeader;
    }
    return backoffMultiplier ** currentAttempt * backoffBase;
  }

  private logRequest(request: RequestContext): void {
    const headers: { [key: string]: string } = {};
    const originalHeaders = request.getHeaders();
    for (const header in originalHeaders) {
      headers[header] = originalHeaders[header];
    }
    if (headers["DD-API-KEY"]) {
      headers["DD-API-KEY"] = headers["DD-API-KEY"].replace(/./g, "x");
    }
    if (headers["DD-APPLICATION-KEY"]) {
      headers["DD-APPLICATION-KEY"] = headers["DD-APPLICATION-KEY"].replace(
        /./g,
        "x"
      );
    }

    const headersJSON = JSON.stringify(headers, null, 2).replace(/\n/g, "\n\t");
    const method = request.getHttpMethod().toString();
    const url = request.getUrl().toString();
    const body = request.getBody()
      ? JSON.stringify(request.getBody(), null, 2).replace(/\n/g, "\n\t")
      : "";
    const compress = request.getHttpConfig().compress ?? true;

    logger.debug(
      "\nrequest: {\n",
      `\turl: ${url}\n`,
      `\tmethod: ${method}\n`,
      `\theaders: ${headersJSON}\n`,
      `\tcompress: ${compress}\n`,
      `\tbody: ${body}\n}\n`
    );
  }

  private logResponse(response: ResponseContext): void {
    const httpStatusCode = response.httpStatusCode;
    const headers = JSON.stringify(response.headers, null, 2).replace(
      /\n/g,
      "\n\t"
    );
    logger.debug(
      "response: {\n",
      `\tstatus: ${httpStatusCode}\n`,
      `\theaders: ${headers}\n`
    );
  }
}
