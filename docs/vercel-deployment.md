# Vercel test deployment

The `goosey` Vercel project is published at https://getgoosey.vercel.app.
Its existing free Neon database is still named `goosey-test`; the domain rename
does not move, replace, or reset that database.

Set production `APP_URL` and `NEXT_PUBLIC_APP_URL` to
`https://getgoosey.vercel.app`. Recovery links derive from this origin unless
explicitly overridden. The former `goosey-test.vercel.app` address redirects
to the new domain, preserving paths and query strings.
Connect the Neon integration using the `NEON` environment-variable prefix.
The runtime accepts `NEON_DATABASE_URL` only with explicit
`DATABASE_PROVIDER=postgresql`; `POSTGRES_DATABASE_URL` takes precedence.
TLS validation remains required in production.

`vercel.json` runs `scripts/vercel-build.mjs`. It maps the protected Neon pooled
and unpooled URLs to Prisma's deployment variables in the build process.
Migrations run only when `GOOSEY_DEPLOY_MIGRATIONS=1` is explicitly configured.
Do not set that flag on previews connected to a shared/live database. This
workflow uses `prisma migrate deploy`, never `db push` or a development reset.

Configure `AUTH_SECRET`, `APP_URL`, `NEXT_PUBLIC_APP_URL`, and
`STARTING_FEATHERS` separately. Keep credentials in protected Vercel variables;
never expose database URLs through Next.js `env` configuration or public vars.
The deployment excludes local development caches, databases and QA output.

Deployment alone does not configure SMTP, bootstrap accounts, import the
synthetic fixture, or supervise the settlement worker. `/api/health` checks the
database; `/api/ready` additionally requires the worker. See
`settlement-worker-operations.md` and `development-sandbox.md` before enabling
those flows. The current fixture importer is for isolated local SQLite only.

GitHub auto-deploy linking was unavailable when this project was created.
Direct CLI deployment remains possible from the linked checkout. Verify the
deployed commit and health before sharing it as a tested release.
