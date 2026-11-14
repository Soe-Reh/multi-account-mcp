# Contributing

Bug reports and pull requests are welcome.

## Setup

```sh
npm install
npm run build
npm test
```

The tests start their own mail servers on your machine. No test should ever contact a real mail provider.

## What belongs here

This project is a connector: it gives AI tools access to accounts. A new feature fits if it gives the AI more or better access, such as attachments, folders or a new provider. Features that analyze or summarize mail belong in the AI tool, not here.

## Before you open a pull request

- Add tests for new behavior.
- Never log or return a password or token.
- Keep sending off by default, with its confirmation step.
- Make sure `npm run typecheck` and `npm test` pass.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.
