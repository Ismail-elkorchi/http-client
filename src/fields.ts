import { HttpConfigurationError } from "./errors.ts";
import { isDenseArray } from "./arrays.ts";
import type {
  HttpField,
  HttpFieldInput,
  HttpFieldsInput,
} from "./types.ts";

const FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export class HttpFields implements Iterable<HttpField> {
  readonly #lines: readonly HttpField[];

  public constructor(input: HttpFieldsInput = []) {
    if (!Array.isArray(input) || !isDenseArray(input)) {
      throw new HttpConfigurationError(
        "HTTP fields must be a dense array of name and value objects.",
      );
    }
    this.#lines = Object.freeze(input.map(validateAndCopyField));
    Object.freeze(this);
  }

  public get size(): number {
    return this.#lines.length;
  }

  public has(name: string): boolean {
    const normalized = validatedLookupName(name);
    return this.#lines.some(
      (line) => line.name.toLowerCase() === normalized,
    );
  }

  public first(name: string): string | null {
    const normalized = validatedLookupName(name);
    return (
      this.#lines.find(
        (line) => line.name.toLowerCase() === normalized,
      )?.value ?? null
    );
  }

  public all(name: string): readonly string[] {
    const normalized = validatedLookupName(name);
    return Object.freeze(
      this.#lines
        .filter((line) => line.name.toLowerCase() === normalized)
        .map((line) => line.value),
    );
  }

  public lines(): readonly HttpField[] {
    return this.#lines;
  }

  public toHeaders(): Headers {
    const headers = new Headers();
    for (const { name, value } of this.#lines) headers.append(name, value);
    return headers;
  }

  public [Symbol.iterator](): Iterator<HttpField> {
    return this.#lines[Symbol.iterator]();
  }
}

export function mergeHttpFields(
  ...sources: readonly (HttpFields | HttpFieldsInput | undefined)[]
): HttpFields {
  let merged: HttpField[] = [];
  for (const source of sources) {
    if (source === undefined) continue;
    const fields = source instanceof HttpFields
      ? source
      : new HttpFields(source);
    const replacedNames = new Set(
      fields.lines().map(({ name }) => name.toLowerCase()),
    );
    merged = merged.filter(
      ({ name }) => !replacedNames.has(name.toLowerCase()),
    );
    merged.push(...fields.lines());
  }
  return new HttpFields(merged);
}

export function appendHttpField(
  fields: HttpFields,
  field: HttpFieldInput,
): HttpFields {
  return new HttpFields([...fields.lines(), field]);
}

export function removeHttpFields(
  fields: HttpFields,
  names: ReadonlySet<string>,
): HttpFields {
  return new HttpFields(
    fields.lines().filter(({ name }) => !names.has(name.toLowerCase())),
  );
}

export function httpFieldsFromRaw(
  raw: readonly (string | Uint8Array)[],
): HttpFields {
  if (raw.length % 2 !== 0) {
    throw new Error("The HTTP transport returned incomplete field lines.");
  }
  const fields: HttpField[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const rawName = raw[index];
    const rawValue = raw[index + 1];
    if (rawName === undefined || rawValue === undefined) {
      throw new Error("The HTTP transport returned incomplete field lines.");
    }
    fields.push({
      name: rawFieldText(rawName),
      value: rawFieldText(rawValue),
    });
  }
  return new HttpFields(fields);
}

export function httpFieldsToFlatArray(
  fields: HttpFields,
): string[] {
  return fields.lines().flatMap(({ name, value }) => [name, value]);
}

export function httpFieldsToRecord(
  fields: HttpFields,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    fields.lines().map(({ name, value }) => [name.toLowerCase(), value]),
  );
}

function validateAndCopyField(value: HttpFieldInput): HttpField {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "name" && key !== "value") ||
    typeof value.name !== "string" ||
    typeof value.value !== "string"
  ) {
    throw new HttpConfigurationError(
      "Each HTTP field must contain only string name and value properties.",
    );
  }
  validateFieldName(value.name);
  validateFieldValue(value.value);
  return Object.freeze({ name: value.name, value: value.value });
}

function validatedLookupName(value: string): string {
  if (typeof value !== "string") {
    throw new HttpConfigurationError("HTTP field names must be strings.");
  }
  validateFieldName(value);
  return value.toLowerCase();
}

function validateFieldName(value: string): void {
  if (!FIELD_NAME.test(value)) {
    throw new HttpConfigurationError(`Invalid HTTP field name: ${value}`);
  }
}

function validateFieldValue(value: string): void {
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)) {
    throw new HttpConfigurationError(
      "HTTP field values cannot contain disallowed control characters.",
    );
  }
  if (/^[\t ]|[\t ]$/u.test(value)) {
    throw new HttpConfigurationError(
      "HTTP field values cannot start or end with whitespace.",
    );
  }
  if (/[^\u0000-\u00ff]/u.test(value)) {
    throw new HttpConfigurationError(
      "HTTP field values must contain only Latin-1 characters.",
    );
  }
}

function rawFieldText(value: string | Uint8Array): string {
  return typeof value === "string"
    ? value
    : Buffer.from(value).toString("latin1");
}
