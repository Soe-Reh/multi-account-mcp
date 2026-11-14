# Privacy

multi-account-mcp runs on your computer. There is no server of ours and no analytics, and it collects no data about you.

Your mail travels between your mail provider and your computer. The connector passes it to the AI tool you chose. If that tool runs in the cloud, the mail it reads is sent to the tool's company and handled under that company's privacy policy.

When you add an account with "Other email", the connector looks up its mail server settings the same way Thunderbird does: it asks Thunderbird's public settings database (autoconfig.thunderbird.net) about your email domain, such as `example.com`, and may look up the domain's mail servers in DNS. Your full address and password are not sent.

Your logins are stored in your system keychain, or in a local file if you choose that. They are sent only to your own mail provider when signing in.

If you use Continue with Google, the connector asks for access to your Gmail (`https://mail.google.com/`) and your email address. It uses that access to search, read and draft mail, and to send mail if you turn sending on, all from your computer at your AI tool's request. It shares nothing with anyone else. To remove the access, run `multi-account-mcp remove <account>` and revoke the app at https://myaccount.google.com/permissions.

For questions, open an issue on the repository.
