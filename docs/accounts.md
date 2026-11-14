# Adding accounts

Run `npx -y multi-account-mcp add`. A page opens in your browser, served from your own computer (`127.0.0.1`). Pick your provider, or type your email address and the page picks it for you. The page tests the login before saving it. Add as many accounts as you like, then click Done.

## Gmail with an app password

Some Google accounts don't allow app passwords. For those, use Continue with Google.

1. Turn on 2-Step Verification for your Google account. Google requires it for app passwords.
2. Open https://myaccount.google.com/apppasswords, type a name such as "multi-account-mcp" and click Create.
3. Paste the 16-letter password into the page along with your Gmail address.

## Yahoo with an app password

1. Open https://login.yahoo.com/account/security.
2. Click "Generate app password", type a name such as "multi-account-mcp" and click Generate.
3. Paste the password into the page along with your Yahoo address.

## Continue with Google

The Google button appears only after you set up a Google sign-in client, because none ships with the project yet. It is free and takes about 10 minutes:

1. In Google Cloud, create a project and enable the Gmail API.
2. Under Google Auth Platform, set the audience to External and add your own address as a test user.
3. Create an OAuth client of type "Desktop app".
4. Save the client ID and secret as `~/.multi-account-mcp/oauth.json`:

```json
{ "google": { "clientId": "....apps.googleusercontent.com", "clientSecret": "..." } }
```

While the Google app stays in "Testing", Google asks you to sign in again every 7 days. Run `add` and click Continue with Google to renew it. App passwords don't expire.

Without a client, the Gmail button asks for an app password instead.

## Outlook.com and Hotmail

Not supported yet. Microsoft turned off app passwords for these accounts, so they need Microsoft sign-in. You can save a Microsoft client ID in the same file as `"microsoft": { "clientId": "..." }`, but this path hasn't been tested with a real account.

## iCloud Mail

1. Open https://account.apple.com and sign in.
2. Go to Sign-In and Security, then App-Specific Passwords, and create one named "multi-account-mcp".
3. Click iCloud Mail on the page and paste the password with your iCloud address.

## Other email

Choose "Other email" for any other provider, such as a business address. Use the password your provider issues for mail apps. Server settings fill in automatically for common providers, and you can type them in for the rest.
