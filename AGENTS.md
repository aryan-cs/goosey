<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Synthetic development data

The user explicitly requested fictional historical data for team and agent testing.
Use the isolated sandbox described in `docs/development-sandbox.md` for this work.
Run `npm run data:dev -- serve` and use the accounts in the ignored, private
`output/development-sandbox/team/credentials.json`. Real UI/API actions in that
sandbox may contribute persistent test activity. Do not insert arbitrary prices,
balances, or fills directly; exercise the real services so accounting reconciles.
Do not reset an active team session or point this tooling at production. Stop the
sandbox before `npm run data:dev -- reset`; it archives the previous dataset.
Never copy synthetic data or development credentials into a live deployment.
