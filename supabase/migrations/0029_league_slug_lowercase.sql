-- League slugs are public URL identifiers: `/harbor/standings` resolves by
-- lower-casing whatever the URL carries, so `/Harbor` and `/harbor` reach the
-- same league (src/lib/league/current.ts, resolveLeagueBySlug).
--
-- That lookup lower-cases the *input*; nothing so far made the *stored* value
-- lower-case. A league inserted as 'Harbor' would therefore be unreachable at
-- every URL — no 404 to debug from, just a league that does not exist as far as
-- the site is concerned. There is no league-creation UI, so leagues arrive by
-- hand-written SQL, which is exactly where a capitalised slug gets typed.
--
-- Enforce the invariant the resolver already assumes.
alter table leagues
  add constraint leagues_slug_lowercase check (slug = lower(slug));
