"use client";

import { useActionState, useState } from "react";
import {
  dismissDuplicatePair,
  mergePlayers,
  restoreDuplicatePair,
  type PlayersActionState,
} from "@/lib/actions/players";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** One appearance of one record: a roster row, flattened for display. */
export type Appearance = {
  seasonName: string;
  teamName: string;
  jerseyNumber: number | null;
  position: string;
  leftOn: string | null;
};

/**
 * One `players` record inside a cluster.
 *
 * De-duplicated on the record id by the page, because `findDuplicateClusters`
 * returns one entry per matching ROW — a record on two teams comes back twice,
 * and the merge form has to offer it once.
 */
export type ClusterPlayer = {
  id: string;
  name: string;
  appearances: Appearance[];
};

export type ClusterView = {
  key: string;
  name: string;
  players: ClusterPlayer[];
};

export type DismissedPair = {
  id: string;
  nameA: string;
  nameB: string;
};

const POSITION_LABEL: Record<string, string> = {
  F: "Forward",
  D: "Defence",
  G: "Goalie",
};

function AppearanceLine({ a }: { a: Appearance }) {
  return (
    <li className="text-muted-foreground text-sm">
      <span className="text-foreground font-medium">{a.teamName}</span>
      {" · "}
      {a.seasonName}
      {a.jerseyNumber != null ? ` · #${a.jerseyNumber}` : ""}
      {` · ${POSITION_LABEL[a.position] ?? a.position}`}
      {a.leftOn ? (
        <Badge variant="outline" className="ml-2 font-normal">
          left {a.leftOn}
        </Badge>
      ) : null}
    </li>
  );
}

/**
 * One cluster of same-name records: which to keep, which to fold in, and the
 * per-pair escape hatch for the case where they are simply two people.
 *
 * Its own component so each cluster carries its own action state. A single hook
 * over the whole page would put one cluster's refusal under every other one.
 */
function ClusterCard({
  leagueId,
  cluster,
}: {
  leagueId: string;
  cluster: ClusterView;
}) {
  const [keepId, setKeepId] = useState(cluster.players[0]?.id ?? "");
  const [absorb, setAbsorb] = useState<Record<string, boolean>>({});
  const [merged, mergeAction, merging] = useActionState<
    PlayersActionState,
    FormData
  >(mergePlayers, null);
  const [dismissed, dismissAction, dismissing] = useActionState<
    PlayersActionState,
    FormData
  >(dismissDuplicatePair, null);

  // Default to folding in everything that is not the keeper: the common case is
  // one person imported twice, and asking the operator to tick the box they
  // just implied by picking a keeper is noise. `absorb` only records the
  // exceptions.
  const willAbsorb = (id: string) => id !== keepId && absorb[id] !== false;
  const absorbIds = cluster.players.map((p) => p.id).filter(willAbsorb);

  const pairs: [ClusterPlayer, ClusterPlayer][] = [];
  for (let i = 0; i < cluster.players.length; i++) {
    for (let j = i + 1; j < cluster.players.length; j++) {
      pairs.push([cluster.players[i], cluster.players[j]]);
    }
  }

  const state = merged ?? dismissed;
  const busy = merging || dismissing;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {cluster.name}
          <Badge variant="secondary">{cluster.players.length} records</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form action={mergeAction} className="space-y-4">
          <input type="hidden" name="league_id" value={leagueId} />
          <input type="hidden" name="keep_id" value={keepId} />
          {absorbIds.map((id) => (
            <input key={id} type="hidden" name="merge_id" value={id} />
          ))}

          <ul className="divide-border divide-y">
            {cluster.players.map((p) => (
              <li key={p.id} className="flex flex-wrap items-start gap-4 py-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="radio"
                    name={`keep-${cluster.key}`}
                    value={p.id}
                    checked={keepId === p.id}
                    onChange={() => setKeepId(p.id)}
                    disabled={busy}
                  />
                  Keep
                </label>
                <ul className="min-w-48 flex-1 space-y-1">
                  {p.appearances.map((a, i) => (
                    <AppearanceLine key={i} a={a} />
                  ))}
                </ul>
                {p.id === keepId ? (
                  <span className="text-muted-foreground text-xs">
                    survives
                  </span>
                ) : (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={willAbsorb(p.id)}
                      onChange={(e) =>
                        setAbsorb((prev) => ({
                          ...prev,
                          [p.id]: e.target.checked,
                        }))
                      }
                      disabled={busy}
                    />
                    Merge in
                  </label>
                )}
              </li>
            ))}
          </ul>

          <p className="text-muted-foreground text-sm">
            <strong className="text-destructive">This cannot be undone.</strong>{" "}
            Stat lines are added together and the other records are deleted. If
            you are not sure these are the same person, mark them different
            instead — that is reversible.
          </p>

          <Button type="submit" disabled={busy || absorbIds.length === 0}>
            {merging
              ? "Merging…"
              : `Merge ${absorbIds.length} into this record`}
          </Button>
        </form>

        <div className="flex flex-wrap gap-2 border-t pt-3">
          {pairs.map(([a, b]) => (
            <form key={`${a.id}|${b.id}`} action={dismissAction}>
              <input type="hidden" name="league_id" value={leagueId} />
              <input type="hidden" name="player_a" value={a.id} />
              <input type="hidden" name="player_b" value={b.id} />
              <Button type="submit" variant="outline" size="sm" disabled={busy}>
                {pairs.length === 1
                  ? "These are different people"
                  : `${a.appearances[0]?.teamName ?? "A"} ≠ ${b.appearances[0]?.teamName ?? "B"}`}
              </Button>
            </form>
          ))}
        </div>

        {state ? (
          <p
            role="status"
            className={state.ok ? "text-sm" : "text-destructive text-sm"}
          >
            {state.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The dismissed list, and the undo that is the only way back out of a misclick. */
function DismissedList({
  leagueId,
  pairs,
}: {
  leagueId: string;
  pairs: DismissedPair[];
}) {
  const [state, action, pending] = useActionState<PlayersActionState, FormData>(
    restoreDuplicatePair,
    null,
  );

  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Show dismissed pairs ({pairs.length})
      </summary>
      <p className="text-muted-foreground mt-2 text-sm">
        Pairs marked as different people. They are hidden from the list above
        until you undo them here.
      </p>
      <ul className="mt-3 space-y-2">
        {pairs.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-4 text-sm"
          >
            <span>
              {p.nameA} <span className="text-muted-foreground">≠</span>{" "}
              {p.nameB}
            </span>
            <form action={action}>
              <input type="hidden" name="league_id" value={leagueId} />
              <input type="hidden" name="pair_id" value={p.id} />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                disabled={pending}
              >
                Undo
              </Button>
            </form>
          </li>
        ))}
      </ul>
      {state ? (
        <p
          role="status"
          className={
            state.ok ? "mt-2 text-sm" : "text-destructive mt-2 text-sm"
          }
        >
          {state.message}
        </p>
      ) : null}
    </details>
  );
}

export function DuplicateClusters({
  leagueId,
  clusters,
  dismissed,
}: {
  /** Every action re-checks this league server-side; it is not trusted here. */
  leagueId: string;
  clusters: ClusterView[];
  dismissed: DismissedPair[];
}) {
  return (
    <div className="space-y-4">
      {clusters.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            No same-name records to review.
          </CardContent>
        </Card>
      ) : (
        clusters.map((c) => (
          <ClusterCard key={c.key} leagueId={leagueId} cluster={c} />
        ))
      )}
      {dismissed.length > 0 ? (
        <DismissedList leagueId={leagueId} pairs={dismissed} />
      ) : null}
    </div>
  );
}
