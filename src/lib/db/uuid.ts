const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An id from the URL is checked before any query: some filters interpolate it into `.or()`
 * strings rather than parameterising it.
 */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
