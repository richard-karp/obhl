import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Legacy URLs, redirected in config: redirects run before the filesystem, so they cost no render
   * and add no route that would need a guard (`RUNBOOK.md` → Legacy redirects).
   */
  async redirects() {
    return [
      // ⚠️ Cannot swallow `/manage/office`: the second segment must be the literal `manage`, and
      // `manage` is a reserved league slug (`0030`). Removing the reservation would change that.
      {
        source: "/:league/manage/:rest*",
        destination: "/:league/:rest*",
        permanent: true,
      },
      // `/rules/edit` is now `/rules`, which shows a manager the editor. An old
      // `/<league>/manage/rules/edit` takes both hops, landing here second.
      {
        source: "/:league/rules/edit",
        destination: "/:league/rules",
        permanent: true,
      },
      // `/rosters` is now `/teams`. Only the index is a path rewrite: `/rosters/<uuid>` names a team
      // by id and needs a lookup, and this one-segment source cannot match it.
      {
        source: "/:league/rosters",
        destination: "/:league/teams",
        permanent: true,
      },
      // `/score` is now `/schedule`, and the scoresheet nests under its game. Sources are anchored,
      // so the two-segment and three-segment rules cannot shadow each other.
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
      // ⛔ The destination has three segments on purpose: `:league` eats `manage`, so a
      // `/manage/import` destination would match this rule and redirect to itself forever.
      {
        source: "/:league/import",
        destination: "/manage/leagues/new",
        permanent: true,
      },
      // ⛔ Two explicit rules, not one `/:league/schedule-builder/:rest*`: zero-or-more would also send
      // a bare `/schedule-builder` to `/schedule`, the games list, not the season setup page.
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
    ];
  },
};

export default nextConfig;
