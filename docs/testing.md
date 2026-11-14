# How it is tested

`npm test` runs over 300 automated tests. None of them contact a real mail provider: the mail tests start their own IMAP and SMTP servers on your machine.

The tests cover the account store, the mail engine, the six tools, the sign-in page and the install command. Many of them simulate failures, such as a server that hangs, drops the connection or rejects a command, or a process that is killed in the middle of sending. Several tests run multiple processes that try to send the same draft at once and check that it is delivered exactly once.

`scripts/stranger-test.sh` checks the experience of a new user. It packs the package, installs it into an empty folder with an empty home folder, runs `install` for Claude Desktop and Cursor, starts the server the way the AI tool would, and opens the sign-in page.

By hand, sign-in has been checked on real Gmail (app password), Yahoo (app password) and Continue with Google accounts. Outlook, Microsoft sign-in and sending have not been checked on real accounts.
