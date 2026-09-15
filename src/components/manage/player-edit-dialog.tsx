"use client";

import { useActionState, useState } from "react";
import {
  toggleCaptain,
  transferPlayer,
  updatePlayerName,
  updatePlayerStatus,
  updateRosterPlayer,
  type RosterActionState,
} from "@/lib/actions/rosters";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { NIGHT_LONG } from "@/lib/season/nights";
import { POSITION_LABEL } from "@/lib/players/positions";

export type DialogTeam = { id: string; name: string };

// ⛔ A container, not a write path: every control submits to `lib/actions/rosters.ts`, and nothing here may
// grow a query (`0036`). ⚠️ Rename keeps its own button: a name lives on `players`, reaching every league.
export function PlayerEditDialog({
  rosterId,
  firstName,
  lastName,
  jerseyNumber,
  position,
  nightOfWeek,
  nights,
  isCaptain,
  isRookie,
  isSuspended,
  injuryNotes,
  transferTargets,
}: {
  rosterId: string;
  firstName: string;
  lastName: string;
  jerseyNumber: number | null;
  position: string;
  nightOfWeek: number | null;
  // 0=Sun..6=Sat. Empty offers no control and submits no field, which `updateRosterPlayer` reads as "leave
  // it alone", not "clear it".
  nights: number[];
  isCaptain: boolean;
  isRookie: boolean;
  isSuspended: boolean;
  injuryNotes: string | null;
  transferTargets: DialogTeam[];
}) {
  const [open, setOpen] = useState(false);
  const name = `${firstName} ${lastName}`.trim();

  const [rosterState, rosterAction, rosterPending] = useActionState<
    RosterActionState,
    FormData
  >(updateRosterPlayer, null);
  const [nameState, nameAction, namePending] = useActionState<
    RosterActionState,
    FormData
  >(updatePlayerName, null);
  const [transferState, transferAction, transferPending] = useActionState<
    RosterActionState,
    FormData
  >(transferPlayer, null);

  // ⛔ Status toggles go through `useActionState`: a plain form post revalidates the page and can tear the
  // dialog down mid-edit. ⚠️ Bound directly, never through a wrapper that discards the result.
  const [statusState, statusAction, statusPending] = useActionState<
    RosterActionState,
    FormData
  >(updatePlayerStatus, null);

  // Captaincy: its own action, dispatched the same way.
  const [captainState, captainAction, captainPending] = useActionState<
    RosterActionState,
    FormData
  >(toggleCaptain, null);

  // ⛔ A successful save does not close this: a manager uses several controls in one sitting. ⚠️ A position
  // change or a transfer still does, moving the row out of its table and unmounting the dialog with it.
  const statusForm = (
    field: string,
    value: string,
    label: string,
    pressed: boolean,
  ) => (
    <form action={statusAction} key={field + value}>
      <input type="hidden" name="id" value={rosterId} />
      <input type="hidden" name="field" value={field} />
      <input type="hidden" name="value" value={value} />
      <Button
        type="submit"
        size="sm"
        variant={pressed ? "secondary" : "outline"}
        aria-pressed={pressed}
        disabled={statusPending}
      >
        {label}
      </Button>
    </form>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Edit
        </Button>
      </DialogTrigger>
      {/* Wider than the default so number, position and night share a line; scrollable
          so all of it is reachable at 390px. */}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
        </DialogHeader>

        {/* ── This team, this season ─────────────────────────────────────── */}
        <form action={rosterAction} className="space-y-3">
          <input type="hidden" name="id" value={rosterId} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label
                className="text-muted-foreground block text-xs"
                htmlFor={`num-${rosterId}`}
              >
                Number
              </label>
              <input
                id={`num-${rosterId}`}
                name="jersey_number"
                type="number"
                min={0}
                max={99}
                defaultValue={jerseyNumber ?? ""}
                disabled={rosterPending}
                className="h-9 w-20 rounded-md border px-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label
                className="text-muted-foreground block text-xs"
                htmlFor={`pos-${rosterId}`}
              >
                Position
              </label>
              <select
                id={`pos-${rosterId}`}
                name="position"
                defaultValue={position}
                disabled={rosterPending}
                className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              >
                {(["F", "D", "G"] as const).map((p) => (
                  <option key={p} value={p}>
                    {POSITION_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
            {nights.length > 1 ? (
              <div className="space-y-1">
                <label
                  className="text-muted-foreground block text-xs"
                  htmlFor={`night-${rosterId}`}
                >
                  Night
                </label>
                <select
                  id={`night-${rosterId}`}
                  name="night_of_week"
                  defaultValue={nightOfWeek === null ? "" : String(nightOfWeek)}
                  disabled={rosterPending}
                  className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                >
                  <option value="">No fixed night</option>
                  {nights.map((n) => (
                    <option key={n} value={n}>
                      {NIGHT_LONG[n]}
                    </option>
                  ))}
                  {/* A night the season no longer plays, kept so saving does
                      not silently discard it. */}
                  {nightOfWeek !== null && !nights.includes(nightOfWeek) ? (
                    <option value={nightOfWeek}>
                      {NIGHT_LONG[nightOfWeek]} (not a game night)
                    </option>
                  ) : null}
                </select>
              </div>
            ) : null}
            <Button type="submit" size="sm" disabled={rosterPending}>
              {rosterPending ? "Saving…" : "Save"}
            </Button>
          </div>
          {rosterState ? (
            <p
              role="status"
              className={
                rosterState.ok
                  ? "text-xs text-emerald-600 dark:text-emerald-400"
                  : "text-destructive text-xs"
              }
            >
              {rosterState.message}
            </p>
          ) : null}
        </form>

        {/* ── Standing status ────────────────────────────────────────────── */}
        <div className="space-y-2 border-t pt-3">
          <p className="text-muted-foreground text-xs">Status</p>
          <div className="flex flex-wrap items-center gap-2">
            <form action={captainAction}>
              <input type="hidden" name="id" value={rosterId} />
              <input type="hidden" name="make" value={isCaptain ? "0" : "1"} />
              <Button
                type="submit"
                size="sm"
                variant={isCaptain ? "secondary" : "outline"}
                aria-pressed={isCaptain}
                disabled={captainPending}
              >
                {isCaptain ? "Captain ✓" : "Make captain"}
              </Button>
            </form>
            {statusForm(
              "is_rookie",
              isRookie ? "0" : "1",
              isRookie ? "Rookie ✓" : "Rookie",
              isRookie,
            )}
            {statusForm(
              "is_suspended",
              isSuspended ? "0" : "1",
              isSuspended ? "Suspended ✓" : "Suspend",
              isSuspended,
            )}
          </div>
          <form action={statusAction} className="flex items-end gap-2">
            <input type="hidden" name="id" value={rosterId} />
            <input type="hidden" name="field" value="injury_notes" />
            <div className="space-y-1">
              <label
                className="text-muted-foreground block text-xs"
                htmlFor={`inj-${rosterId}`}
              >
                Injury note
              </label>
              <input
                id={`inj-${rosterId}`}
                name="value"
                defaultValue={injuryNotes ?? ""}
                placeholder="None"
                disabled={statusPending}
                className="h-9 w-56 rounded-md border px-2 text-sm"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={statusPending}
            >
              Set
            </Button>
          </form>
          {/* Failures only: a success shows in the button's pressed state and the row's
              badge, and a refusal has nowhere else to appear. */}
          {[statusState, captainState].map((st, i) =>
            st && !st.ok ? (
              <p key={i} role="status" className="text-destructive text-xs">
                {st.message}
              </p>
            ) : null,
          )}
        </div>

        {/* ── Transfer ───────────────────────────────────────────────────── */}
        {transferTargets.length > 0 ? (
          <form action={transferAction} className="space-y-2 border-t pt-3">
            <input type="hidden" name="id" value={rosterId} />
            <p className="text-muted-foreground text-xs">Transfer</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label
                  className="text-muted-foreground block text-xs"
                  htmlFor={`to-team-${rosterId}`}
                >
                  To team
                </label>
                <select
                  id={`to-team-${rosterId}`}
                  name="to_team_id"
                  required
                  defaultValue=""
                  disabled={transferPending}
                  className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                >
                  <option value="" disabled>
                    Pick a team…
                  </option>
                  {transferTargets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label
                  className="text-muted-foreground block text-xs"
                  htmlFor={`tjersey-${rosterId}`}
                >
                  Jersey number
                </label>
                <input
                  id={`tjersey-${rosterId}`}
                  name="jersey_number"
                  type="number"
                  min={0}
                  defaultValue={jerseyNumber ?? ""}
                  disabled={transferPending}
                  className="h-9 w-20 rounded-md border px-2 text-sm"
                />
              </div>
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                disabled={transferPending}
              >
                {transferPending ? "Transferring…" : "Confirm transfer"}
              </Button>
            </div>
            {transferState && !transferState.ok ? (
              <p role="status" className="text-destructive text-xs">
                {transferState.message}
              </p>
            ) : null}
          </form>
        ) : null}

        {/* ── The person, everywhere ─────────────────────────────────────── */}
        <form action={nameAction} className="space-y-2 border-t pt-3">
          <input type="hidden" name="id" value={rosterId} />
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label
                className="text-muted-foreground block text-xs"
                htmlFor={`first-${rosterId}`}
              >
                First name
              </label>
              <input
                id={`first-${rosterId}`}
                name="first_name"
                defaultValue={firstName}
                disabled={namePending}
                className="h-9 w-36 rounded-md border px-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label
                className="text-muted-foreground block text-xs"
                htmlFor={`last-${rosterId}`}
              >
                Last name
              </label>
              <input
                id={`last-${rosterId}`}
                name="last_name"
                defaultValue={lastName}
                disabled={namePending}
                className="h-9 w-36 rounded-md border px-2 text-sm"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={namePending}
            >
              {namePending ? "Renaming…" : "Rename everywhere"}
            </Button>
          </div>
          {/* Said before the button is pressed: a manager fixing a typo can't tell from
              here that the person also plays in another league. */}
          <p className="text-muted-foreground text-xs">
            A player is one record shared by every league they play in, so this
            renames them everywhere — not just here. If they also play a league
            you do not manage, the change is refused and the League Office can
            make it.
          </p>
          {nameState ? (
            <p
              role="status"
              className={
                nameState.ok
                  ? "text-xs text-emerald-600 dark:text-emerald-400"
                  : "text-destructive text-xs"
              }
            >
              {nameState.message}
            </p>
          ) : null}
        </form>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
