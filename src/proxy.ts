import { type NextRequest } from "next/server";
import { updateSession } from "@/utils/supabase/middleware";

// Next 16 renamed the `middleware` file convention to `proxy`. This runs on
// every matched request to keep the Supabase auth session fresh.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Run on all paths except Next internals and static image assets.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
