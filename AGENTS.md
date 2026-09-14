<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

Read RUNBOOK.md → Start here before changing anything; it says which section covers which area.

# Standing gate: a test config may not override a search constant

⛔ A test config may raise a **timeout**. It may never set a constant that shapes a search, a budget or a result.
Evidence: `vitest.config.ts` pinned `OBHL_SLOT_RESTARTS=2000` while production ran 20,000. The clustering tests
passed at 2,000 and failed at 20,000, and the league got 14 -> 13, not 14 -> 4. `assignNights.test.ts` asserts
the variable is unset. Ask of any green suite: is this the program the user runs?
