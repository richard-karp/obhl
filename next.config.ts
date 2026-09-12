import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The staff tools used to sit behind a `/manage/` prefix, which existed only
   * because `manage` was a plain directory next to the `(public)` route group.
   * The directory is now `(manage)` and the prefix is gone from every page at
   * once, so every link anyone has already shared or bookmarked names a URL
   * that no longer resolves. This is what keeps them working.
   *
   * A config redirect rather than the `[...rest]` catch-all page the design
   * sketched: redirects are checked BEFORE the filesystem, so this costs no
   * render, answers every method rather than just a page GET, and adds no route
   * directory that would itself need a guard. Query strings are carried across.
   *
   * ⚠️ This cannot swallow the League Office at `/manage/office`. That path's
   * first segment is `manage` and its second is `office`, and the source below
   * requires the SECOND segment to be the literal `manage` — `/:league` eats the
   * first. `manage` is a reserved league slug (0030), so no real league can make
   * that ambiguous either. Removing the reservation would.
   *
   * `:rest*` is zero-or-more, so a bare `/<league>/manage` lands on the league
   * home rather than 404ing as it used to — there was never a page at that path.
   * Still a 404 for a league that is not published, since the home page it lands
   * on applies the visibility gate like any other public page.
   */
  async redirects() {
    return [
      {
        source: "/:league/manage/:rest*",
        destination: "/:league/:rest*",
        permanent: true,
      },
      // `/rules/edit` merged INTO `/rules`, which now shows a manager an editor
      // and everyone else the published page. Ordering with the rule above is
      // not a concern: an old `/<league>/manage/rules/edit` takes both hops,
      // landing on `/<league>/rules/edit` and then here.
      {
        source: "/:league/rules/edit",
        destination: "/:league/rules",
        permanent: true,
      },
      // `/rosters` merged into `/teams`. Only the INDEX is a path rewrite:
      // `/rosters/<uuid>` names a team by an id the new URL replaces with a
      // slug, so it needs a lookup and lives at
      // `src/app/[league]/rosters/[teamId]/page.tsx` — in NEITHER route group,
      // deliberately; that file's docblock says why, and putting it under
      // `(manage)` is the trap it warns about. A source of
      // `/:league/rosters` matches that one segment only, so the two do not
      // overlap.
      {
        source: "/:league/rosters",
        destination: "/:league/teams",
        permanent: true,
      },
      // `/score` merged into `/schedule` — the same games, with a button on each
      // row for whoever may open a scoresheet — and the scoresheet itself nested
      // under the game it scores. Both are pure path rewrites: unlike
      // `/rosters/<uuid>`, the game is named by the same id at either URL.
      //
      // These two cannot shadow each other in either order, for the same reason
      // the `/rosters` pair above cannot: `:gameId` is a required single
      // segment and sources are anchored at both ends, so `/:league/score`
      // matches two segments only and `/:league/score/:gameId` three. The
      // specific one is written first anyway, as documentation of intent.
      {
        source: "/:league/score/:gameId",
        destination: "/:league/games/:gameId/score",
        permanent: true,
      },
      {
        source: "/:league/score",
        destination: "/:league/schedule",
        permanent: true,
      },
      // The importer moved OUT of `[league]` entirely: it never imported *into*
      // the league in its URL, it creates a new one, so it now lives beside the
      // League Office at a path that belongs to no league.
      //
      // ⛔ THE DESTINATION HAS THREE SEGMENTS ON PURPOSE, AND `/manage/import`
      // WOULD LOOP. This source matches any two-segment `/<x>/import`, and
      // `:league` happily eats `manage` — so a destination of `/manage/import`
      // would match the rule that produced it and redirect to itself forever.
      // `/manage/leagues/new` cannot be matched by a two-segment anchored
      // source, which makes the loop impossible rather than merely avoided.
      // (Same family as the `/manage/office` note on the first rule above; that
      // one is safe because the SECOND segment must be the literal `manage`.)
      //
      // Ordering against the five rules above does not matter: none of their
      // sources matches `/<x>/import`.
      {
        source: "/:league/import",
        destination: "/manage/leagues/new",
        permanent: true,
      },
      // The builder's two IN-SEASON tools moved under `/schedule`, which is
      // where a manager looks at games. The builder itself did not move — it
      // stopped being a place at all (2026-09-11): it is one step of creating a
      // season, so it renders on that season's setup page, and the bare
      // `/schedule-builder` URL is a redirect PAGE rather than an entry here,
      // because only a page can look up which season to land on.
      //
      // ⛔ TWO EXPLICIT RULES, NOT ONE `/:league/schedule-builder/:rest*`.
      // `:rest*` is zero-or-more, so the wildcard would also match the bare
      // `/schedule-builder` and send it to `/schedule` — the games list, not
      // the season setup page the redirect page picks. That is the same
      // zero-or-more behaviour the `/manage/` rule at the top of this file
      // documents as deliberate; here it would be wrong.
      //
      // No ordering hazard against the rules above: every one of their sources
      // is anchored at both ends and none begins `/:league/schedule-builder`.
      {
        source: "/:league/schedule-builder/repair",
        destination: "/:league/schedule/repair",
        permanent: true,
      },
      {
        source: "/:league/schedule-builder/one-off",
        destination: "/:league/schedule/one-off",
        permanent: true,
      },
      // The scorekeeper's page moved out of /manage/ (0048 reserves `tonight`).
      // Every other move in this file left a redirect behind; this one is
      // unreleased, so nothing has the old address bookmarked — but the
      // consistency is worth more than the two lines it costs, and a link pasted
      // into a chat during testing should not 404.
      {
        source: "/manage/tonight",
        destination: "/tonight",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
