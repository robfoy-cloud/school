# school

Prototype schools app that ties in with Maths Garden.

- `public/index.html` — the whole app (static page, served by Cloudflare Workers via `wrangler.jsonc`)
- Data lives in Supabase (currently in the learn-spanish project). All permissions are enforced by row-level security.

## Homework loop

1. Class teacher picks a topic; Claude drafts questions (`/api/generate`). Teacher edits and approves.
2. Each pupil gets a private family link (`/h.html?t=…`) and a printable sheet with a QR code.
3. Families answer online or upload photos/scans of the paper sheet.
4. Claude marks each answer with a confidence score (`/api/mark`); low-confidence answers are flagged.
5. Teacher reviews flagged answers (or bulk-approves unflagged ones); results feed each pupil's progress.

The Worker (`src/worker.js`) needs one secret, `ANTHROPIC_API_KEY`, set in the Cloudflare dashboard.
It calls Supabase as the signed-in teacher, so row-level security applies to everything it does.

## Releasing a new version

Bump `VERSION` in `public/sw.js` with every release. Open copies of the app then show
"Version N is ready" with an Update button, and "Success! Updated to version N" afterwards.
The version button in the top bar shows the current version and checks for updates.

## Signing in (prototype)

Sign in with a developer account (listed in `school_dev_testers`), then pick any staff ID to act as that person.

| Access level | Role | Can |
|---|---|---|
| 0 | LA admin | add schools and roles |
| 1–2 | Headteacher, deputies | set year groups, classes, teachers and TAs; view staff below them and registers |
| 3 | Head of key stage | (not defined yet) |
| 4 | Teacher | see their class, take the register |
| 5 | Teaching assistant | see their class |
