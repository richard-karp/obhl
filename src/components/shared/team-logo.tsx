import { cn } from "@/lib/utils";

function logoUrl(path: string) {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/logos/${path}`;
}

/** A team's logo image, or a colored monogram chip when no logo is set. */
export function TeamLogo({
  name,
  color,
  logoPath,
  textColor,
  className,
}: {
  name: string;
  color?: string | null;
  logoPath?: string | null;
  /**
   * `teams.logo_text_color` — `"dark"` for dark letters, anything else (including
   * the `null` a caller that has not plumbed the column through will pass) for
   * the white ones this always drew. Typed as a loose string rather than the two
   * literals so a row read straight out of the database drops in without a cast.
   */
  textColor?: string | null;
  className?: string;
}) {
  if (logoPath) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl(logoPath)}
        alt=""
        className={cn(
          "size-6 shrink-0 rounded-md object-cover ring-1 ring-black/10",
          className,
        )}
      />
    );
  }

  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    // The chip sits inside links carrying `hover:underline` in half a dozen
    // places — standings, both stats tables, the player pages — and the
    // underline was landing across the monogram: a stray rule under two letters
    // nobody is reading as text.
    //
    // ⛔ `no-underline` (`text-decoration-line: none`) on this span does NOT fix
    // it, and the computed style lies about that — it reads `none` on the chip
    // while the line is still painted. A text decoration set on an ancestor is
    // *propagated* to its in-flow descendants rather than inherited, and CSS
    // gives a descendant no way to switch a propagated decoration back off.
    // Measured in Chrome: `text-decoration:none`, `!important`, a transparent
    // `text-decoration-color`, `display:inline-block`, `position:relative` with
    // a `z-index`, and an inner block wrapper all still draw the line.
    //
    // What the spec does exempt is out-of-flow descendants, so the letters go in
    // an absolutely positioned child and the decoration has no in-flow text left
    // to attach to. That is why this is two spans and not one, and why the outer
    // one must keep an explicit size — with its only child out of flow it has no
    // content to be sized by. Every caller already passes `size-*`.
    //
    // Fixed once here rather than by moving `hover:underline` onto the label at
    // each call site: six copies of a fix is five chances to forget the seventh.
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-6 shrink-0 rounded-md text-[0.65rem] font-bold shadow-sm ring-1 ring-black/10",
        textColor === "dark" ? "text-slate-900" : "text-white",
        className,
      )}
      style={{ backgroundColor: color ?? "#64748b" }}
    >
      <span className="absolute inset-0 flex items-center justify-center">
        {initials}
      </span>
    </span>
  );
}
