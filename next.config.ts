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
   * home rather than 404ing, which is what it did before.
   */
  async redirects() {
    return [
      {
        source: "/:league/manage/:rest*",
        destination: "/:league/:rest*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
