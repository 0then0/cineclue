# Telegram setup

Use one BotFather bot for CineClue's Main Mini App and website sign-in. Start with a test bot and a disposable PostgreSQL database behind a test HTTPS origin.

1. In **BotFather → My Bots → your bot → Bot Settings → Configure Mini App**, enable the Main Mini App and set its URL to `https://<site>/telegram`. Use generic CineClue copy and artwork for the bot profile and Mini App preview. [Main Mini App documentation](https://core.telegram.org/bots/webapps#launching-the-main-mini-app)
2. In the same bot's **Login Widget** settings, add the exact site origin `https://<site>` and callback `https://<site>/api/auth/telegram/callback` to **Allowed URLs**. Keep the default RS256 signing algorithm. Copy the Client ID and Client Secret from BotFather. [Telegram Login documentation](https://core.telegram.org/bots/telegram-login#registering-your-allowed-urls)
3. Apply the database migrations before starting the updated API. Configure these variables in the server environment, or in Netlify's **Functions** scope for the matching deployment context.
   - `PUBLIC_ORIGIN` is the exact HTTPS origin with no trailing slash.
   - `TELEGRAM_BOT_USERNAME` is the bot username without `@`.
   - `TELEGRAM_BOT_TOKEN` is the BotFather API token for the same bot.
   - `TELEGRAM_OIDC_CLIENT_ID` and `TELEGRAM_OIDC_CLIENT_SECRET` are the Login Widget credentials.

Keep the token and client secret in server settings. Leave the Telegram variables unset for a guest-only installation. See the [Netlify and standalone deployment guide](DEPLOYMENT.md) for database, catalog and hosting settings.

`https://t.me/<bot>?startapp` opens Daily. A Challenge link uses `https://t.me/<bot>?startapp=challenge_<UUID>`. CineClue accepts that ASCII form within Telegram's 512-character limit and opens `/challenge/<UUID>`. The URL and previews use generic game metadata. Android and iOS use the Telegram native Mini App bridge. The ordinary website uses the system share sheet or clipboard.

## Test acceptance

Telegram Login documents numeric `profile.id`. The Mini App supplies `WebAppUser.id`. CineClue checks the signed values and uses the numeric user ID in both paths. Before enabling shared Daily for users, confirm the numeric values match in a live login with the same test account, that the OIDC token includes the requested nonce, and that a second test account has an independent ID and board. Synthetic fixtures cover these paths locally. [OIDC claims](https://core.telegram.org/bots/telegram-login#available-scopes) · [Mini App user ID](https://core.telegram.org/bots/webapps#webappuser)

- Start a guest Daily. Sign in on the site, check the guest-game notice and make a guess in the account Daily. Continue with the same Telegram account in the Mini App. Confirm the same Daily and guess, then sign out and confirm the original guest game. Check cancellation, expiry and reusing the browser callback.
- Send a Challenge link to the test chat. On Telegram for Android and iOS, verify the preview, search with the keyboard open, choose a film, close and reopen the Mini App, finish the game, share the spoiler-free result and return to Daily. Record the clients and versions actually used.
- Test guest Daily, Challenge and result sharing in a regular browser. Confirm that current Daily guesses and hints follow a signed-in account while local history, streaks and history exports are specific to the browser or Mini App.
