# WorkBuddy (Netlify + Supabase, free)

Website that controls your bot. The bot stays on GitHub/your host; the site only starts it.

## Setup (about 20 minutes)
1. **Supabase**: create a free project, open SQL Editor, run `supabase/schema.sql`.
2. **Load token codes**: Table Editor > `codes` > Import CSV, one file at a time from `out/hashes/` (20 files, 100k rows each). Only hashes go online.
3. **Google sign-in**: Google Cloud Console > Credentials > OAuth client ID (Web). Add your Netlify URL under Authorized JavaScript origins. Copy the client ID.
4. **Env vars**: copy `.env.example` into Netlify's environment variables and fill in. Generate secrets with the `openssl` commands shown. Make the emergency-passcode hash with `node tools/hash_passcode.mjs <DELETE_SALT> <your passcode>`; the passcode itself is never stored anywhere in the code.
5. **Deploy**: push this folder to GitHub, connect it in Netlify (build command empty, publish dir `public`). Open `/admin.html`, sign in with the admin Google account, paste the Bot URL and Subscription URL.
6. **Bot**: see `bot-example.py`. The site sends a signed request, the bot fetches the user's SID/SPass for that one running job, does the work, then reports success or failure. Failure refunds the token.

## Rules built in
- Start button is gray at 0 tokens, while the account is paused, or while a run is in progress; the server enforces all of it.
- New users get 1 free token. Each code redeems once and is deleted.
- Weekdays only after the start time you set (default 13:30); weekends any time. "Request an admin" lets you approve one exception.
- Admin can pause, play, revoke. Admin never sees SPass; only the bot secret can fetch it.
- Delete everything: typed confirmation + emergency passcode, emails a backup first (aborts if the email fails), wipes, then locks the site for everyone.

## Prices (set on your payment site)
Based on 2 tokens = 1 month at about 100: 1 month 100 (2 tokens), 3 months 270 (6 tokens), lifetime/one-time 600+.

## Keep safe
The `out/pdf` files are your money: store offline, never commit them to GitHub. `.gitignore` already excludes `out/` and `.env`.
