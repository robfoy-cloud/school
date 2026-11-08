# school

Prototype schools app that ties in with Maths Garden.

- `public/index.html` — the whole app (static page, served by Cloudflare Workers via `wrangler.jsonc`)
- Data lives in Supabase (currently in the learn-spanish project). All permissions are enforced by row-level security.

## Signing in (prototype)

Sign in with a developer account (listed in `school_dev_testers`), then pick any staff ID to act as that person.

| Access level | Role | Can |
|---|---|---|
| 0 | LA admin | add schools and roles |
| 1–2 | Headteacher, deputies | set year groups, classes, teachers and TAs; view staff below them and registers |
| 3 | Head of key stage | (not defined yet) |
| 4 | Teacher | see their class, take the register |
| 5 | Teaching assistant | see their class |
