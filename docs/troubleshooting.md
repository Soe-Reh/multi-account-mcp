# Troubleshooting

## The tools don't show up in my AI tool

Quit the AI tool completely and open it again. Then run `install <client>` again; it should say "already installed". Desktop apps sometimes can't find `npx` when Node was installed with a version manager such as nvm. Installing Node from nodejs.org usually fixes that.

## "is not valid JSON, so it was not changed"

Your AI tool's settings file has a typo in it. Fix the typo, or move the file somewhere else, and run `install` again.

## Gmail or Yahoo rejects the password

Use an app password, not the password you sign in with. Gmail only lets you make one after 2-Step Verification is on. See [accounts.md](accounts.md).

## Gmail stopped working after a week

If you signed in with Continue with Google and your Google app is in "Testing", Google ends the sign-in after 7 days. Run `add` and click Continue with Google again.

## "The system keychain is not available"

Unlock your keychain. On Linux, install and start a Secret Service such as GNOME Keyring. If that isn't possible, set `MULTI_ACCOUNT_MCP_SECRETS=file` to save logins in a file only your user can read, then run `install <client> --secrets-file` so your AI tool uses the same setting.

With this setting, every command starts by printing a warning that the keychain is not in use. That is expected.

## Sending is refused

If the message says sending is off, run `allow-send <account>`; the error shows the exact command. If it says your AI tool can't show a confirmation prompt, use a tool that can, such as Claude Code, or read about `--no-confirm` in the README before using it.
