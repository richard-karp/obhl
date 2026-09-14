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
  // `"dark"` for dark letters; anything else, null included, for white. A loose string, so a database row
  // drops in without a cast.
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
    // ⛔ Two spans, not one with `no-underline`: an ancestor's `hover:underline` propagates to in-flow text and
    // can't be switched off, so the letters sit out of flow, and the outer span needs its explicit `size-*`.
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
