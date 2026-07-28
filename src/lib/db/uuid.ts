const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value is a canonical UUID.
 *
 * Route params reach PostgREST filters — some of them interpolated into `.or()`
 * strings rather than parameterised — so an id from the URL has to be checked
 * before it gets near a query.
 */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
