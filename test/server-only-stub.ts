/**
 * Stands in for `server-only` under vitest.
 *
 * `server-only` is not a real dependency — Next resolves it internally, and its
 * whole job is to make a build fail if a module is imported from a client
 * component. Under vitest there is no bundler to enforce that and no package to
 * resolve, so any unit test that reaches a module marked with it dies at import
 * with `Cannot find package 'server-only'`.
 *
 * Aliased in `vitest.config.ts`. ⚠️ This weakens nothing: the guarantee comes
 * from the Next build, which is unaffected, and every module carrying the marker
 * keeps it. Without this, `src/lib/import/esportsdesk.ts`, `auth/membership.ts`,
 * `auth/guards.ts` and `audit.ts` are all untestable in isolation — which is why
 * the import path had no unit coverage while three review rounds found bugs in it.
 */
export {};
