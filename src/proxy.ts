import { type NextRequest } from "next/server";
import { updateSession } from "@/utils/supabase/middleware";

// Next 16's name for `middleware`: keeps the Supabase auth session fresh on every matched request.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Run on all paths except Next internals and static image assets.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
