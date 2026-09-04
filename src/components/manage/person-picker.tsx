"use client";

import { useId, useMemo, useRef, useState, useTransition } from "react";
import { archivePlayer, restorePlayer } from "@/lib/actions/rosters";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";

export type PersonOption = {
  id: string;
  name: string;
  /** Archived out of THIS league (0040). Never a global fact about the person. */
  archived: boolean;
  /** Currently on some team in THIS league — so archiving them is refused. */
  rostered: boolean;
};

/** Rendering every person in the instance is a scroll nobody reads. */
const MAX_VISIBLE = 40;

/**
 * The "existing person" field: a filtered combobox over every person in the
 * database, plus the archive controls for this league.
 *
 * ⛔ REPLACES A `<select>`, AND DOES NOT KEEP ONE. `players` is global and
 * unfiltered here on purpose — reusing a person who plays in another league is
 * the whole point of the field — so the list grows with the instance and a
 * native select becomes a scroll through hundreds of names. A hidden `<select>`
 * kept alongside this to satisfy an old test would be two fields that can
 * disagree about who is selected, and the one the operator cannot see would win.
 *
 * Built on `Input` + `Popover` rather than a combobox dependency: `cmdk` is not
 * installed and one field does not justify adding it.
 *
 * ⚠️ THE ARCHIVE CONTROLS LIVE HERE, not on an admin screen of their own. This
 * is the one surface where somebody looking for a person who has gone missing
 * will actually be, and restoring them is then one click from adding them.
 */
export function PersonPicker({
  people,
  leagueId,
  disabled,
  onSelectedChange,
}: {
  people: PersonOption[];
  /** The league the archive is scoped to. Never omitted — see 0040. */
  leagueId: string;
  disabled?: boolean;
  onSelectedChange?: (id: string | null) => void;
}) {
  // Fixed rather than `useId()`: there is one picker on the page, and a stable
  // id keeps the label association readable in the DOM and in a test failure.
  const inputId = "existing_person";
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<PersonOption | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [active, setActive] = useState(0);
  const [pending, startTransition] = useTransition();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter(
      (p) => (showArchived || !p.archived) && (!q || p.name.toLowerCase().includes(q)),
    );
  }, [people, query, showArchived]);
  const visible = matches.slice(0, MAX_VISIBLE);
  const archivedCount = people.filter((p) => p.archived).length;

  function choose(p: PersonOption | null) {
    setSelected(p);
    setQuery(p ? p.name : "");
    setOpen(false);
    setActive(0);
    onSelectedChange?.(p?.id ?? null);
  }

  function run(action: () => Promise<{ ok: boolean; message: string } | null>) {
    startTransition(async () => {
      try {
        const result = await action();
        setNotice(result ?? null);
      } catch (err) {
        // ⛔ Same shape as the constraints card: `redirect()` and `notFound()`
        // work BY THROWING, and both archive actions reach `redirect("/")`
        // through `requireLeagueManager`, so swallowing a "NEXT_" digest would
        // turn a refusal into a notice and strand the manager on the page they
        // were being sent away from. Everything else is reported, because a
        // bare await left a failed archive looking exactly like a dead button.
        const digest = (err as { digest?: unknown } | null)?.digest;
        if (typeof digest === "string" && digest.startsWith("NEXT_")) throw err;
        setNotice({
          ok: false,
          message: "That didn't go through — check your connection and try again.",
        });
      }
    });
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={inputId}>Existing person (optional)</Label>

      {/* The id the server reads. The visible field carries a NAME; this
          carries the identity, and it is cleared whenever the text stops
          matching the person it was chosen for — two fields that can disagree
          is the failure a combobox invites. */}
      <input type="hidden" name="player_id" value={selected?.id ?? ""} />

      <Popover open={open && !disabled} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div className="flex items-center gap-2 sm:max-w-xs">
            <Input
              id={inputId}
              ref={inputRef}
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              autoComplete="off"
              disabled={disabled}
              placeholder="Type a name, or leave blank for a new person"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
                // Typing after a pick means they are picking again.
                if (selected) {
                  setSelected(null);
                  onSelectedChange?.(null);
                }
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setOpen(false);
                  return;
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setOpen(true);
                  if (visible.length === 0) return;
                  setActive((i) =>
                    e.key === "ArrowDown"
                      ? Math.min(i + 1, visible.length - 1)
                      : Math.max(i - 1, 0),
                  );
                  return;
                }
                // ⛔ Enter inside an open combobox must not submit the add form.
                // The operator is picking from the list, and the form's own
                // submit would fire with no player selected — an accidental
                // "new person" with a half-typed name.
                if (e.key === "Enter" && open) {
                  e.preventDefault();
                  if (visible[active]) choose(visible[active]);
                }
              }}
            />
            {selected ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline"
                onClick={() => {
                  choose(null);
                  inputRef.current?.focus();
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
        </PopoverAnchor>

        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) min-w-72 p-0"
          // Focus stays in the field: this is a list to look at while typing,
          // not a dialog to move into.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
            </label>
            <span className="text-muted-foreground text-xs">
              {archivedCount} archived
            </span>
          </div>

          <div id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1">
            {visible.length === 0 ? (
              <p className="text-muted-foreground px-3 py-2 text-xs">
                {archivedCount > 0 && !showArchived
                  ? "Nobody matches. Some people are archived — tick “Show archived”."
                  : "Nobody matches. Leave the field blank to add a new person."}
              </p>
            ) : (
              visible.map((p, i) => (
                // The whole row picks, not just the text. `flex-1` on the name
                // is what makes that true for a click landing anywhere in the
                // middle of the row, which is where a pointer usually lands and
                // where a test driver aims.
                <div
                  key={p.id}
                  role="option"
                  aria-selected={selected?.id === p.id}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(p)}
                  className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm ${
                    i === active ? "bg-muted" : ""
                  }`}
                >
                  <span className="flex-1 truncate">
                    {p.name}
                    {p.archived ? (
                      <Badge variant="outline" className="ml-2 px-1.5 py-0 text-[0.65rem]">
                        Archived
                      </Badge>
                    ) : null}
                  </span>
                  {/* ⛔ `stopPropagation`, or archiving also selects the person
                      the row is about — the click would bubble to the row above
                      and close the list on the way. */}
                  {p.archived ? (
                    <button
                      type="button"
                      disabled={pending}
                      className="shrink-0 text-xs underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        run(() => restorePlayer(p.id, leagueId));
                      }}
                    >
                      Restore
                    </button>
                  ) : p.rostered ? (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      On a roster
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={pending}
                      className="text-destructive shrink-0 text-xs underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        run(() => archivePlayer(p.id, leagueId));
                      }}
                    >
                      Archive
                    </button>
                  )}
                </div>
              ))
            )}
            {matches.length > visible.length ? (
              <p className="text-muted-foreground px-3 py-2 text-xs">
                {matches.length - visible.length} more — keep typing to narrow it down.
              </p>
            ) : null}
          </div>

          <p className="text-muted-foreground border-t px-3 py-2 text-xs">
            Archiving takes someone out of <strong>this league&rsquo;s</strong> lists only.
            Their games, stats and other leagues are untouched.
          </p>
        </PopoverContent>
      </Popover>

      <p className="text-muted-foreground text-xs">
        Pick someone who already plays in another league to reuse their profile, or
        leave this blank and enter a name below.
      </p>
      {notice ? (
        <p
          role="status"
          className={
            notice.ok
              ? "text-xs text-emerald-600 dark:text-emerald-400"
              : "text-destructive text-xs"
          }
        >
          {notice.message}
        </p>
      ) : null}
    </div>
  );
}
