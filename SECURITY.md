# Security

This project handles email logins, so security reports are welcome.

To report a problem privately, use "Report a vulnerability" under the repository's Security tab. Please don't open a public issue for it. Include the version or commit, your operating system and the steps to reproduce.

## What the project protects

- Logins are stored in the system keychain. They go in a file only if you set `MULTI_ACCOUNT_MCP_SECRETS=file`.
- The sign-in page listens only on `127.0.0.1`, uses a random address, and closes when you are done.
- Sending is off for every account until you turn it on, and each send asks you first.
- Email content reaches your AI tool marked as untrusted.

## What it can't protect against

- Your AI tool sees the mail it reads, and what it does with that mail is up to the tool.
- A program running as your user on your computer can read your keychain entries.
