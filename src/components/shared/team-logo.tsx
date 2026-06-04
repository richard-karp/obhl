import { cn } from "@/lib/utils";

function logoUrl(path: string) {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/logos/${path}`;
}

/** A team's logo image, or a colored monogram chip when no logo is set. */
export function TeamLogo({
  name,
  color,
  logoPath,
  className,
}: {
  name: string;
  color?: string | null;
  logoPath?: string | null;
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
    <span
      aria-hidden
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[0.65rem] font-bold text-white shadow-sm ring-1 ring-black/10",
        className,
      )}
      style={{ backgroundColor: color ?? "#64748b" }}
    >
      {initials}
    </span>
  );
}
