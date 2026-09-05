import { type NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";

function withAuditSession(response: NextResponse): NextResponse {
  response.cookies.set("audit_session", crypto.randomUUID(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}

/**
 * Completes a magic-link sign-in. Handles both the PKCE code flow
 * (?code=...) and the token_hash flow (?token_hash=...&type=...).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  // Only allow same-origin relative paths (block "//evil.com" and absolute URLs).
  // There is no league-agnostic dashboard any more — the staff tools live
  // under /<league> — and a magic link cannot know which league was meant, so
  // both the default and the sanitising fallback land on the league picker.
  const rawNext = searchParams.get("next") ?? "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return withAuditSession(NextResponse.redirect(`${origin}${next}`));
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return withAuditSession(NextResponse.redirect(`${origin}${next}`));
  }

  return NextResponse.redirect(`${origin}/login?error=link`);
}
