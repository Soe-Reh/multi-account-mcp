# Install details

The commands below use `npx -y multi-account-mcp`. If you run from a source checkout, use `node dist/cli/index.js` instead.

## Supported AI tools

| AI tool | How to install |
|---|---|
| Claude Desktop | `npx -y multi-account-mcp install claude-desktop` |
| Claude Code | `npx -y multi-account-mcp install claude-code`, or the Claude Code plugin in the README |
| Cursor | `npx -y multi-account-mcp install cursor` |
| VS Code | `npx -y multi-account-mcp install vscode --print`, then paste the output into your user `mcp.json` |
| Gemini CLI | `npx -y multi-account-mcp install gemini-cli --print`, then paste into `~/.gemini/settings.json` |
| Codex CLI | `npx -y multi-account-mcp install codex --print`, then paste into `~/.codex/config.toml` |

ChatGPT isn't supported. It only connects to hosted servers, and this one runs on your computer.

## What `install` changes

`install` adds one entry to your AI tool's settings file and leaves every other server in it alone. Before changing the file, it saves a copy next to it as `<file>.bak` and tells you where. If the file has a JSON error or can't be written, it stops and changes nothing. Running it a second time says "already installed".

For Claude Code, it uses `claude mcp add --scope user` when the `claude` command is available, and otherwise edits `~/.claude.json`. Claude Desktop's settings file is in these places:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Options:

```
--print          Show the settings entry and change nothing
--uninstall      Remove only this server's entry
--npx            Write an entry that runs through npx
--local          Write an entry with the full path to this installation
--secrets-file   Tell the server to read logins from a file instead of the keychain
```

By default the entry matches how you ran the command: through `npx`, or with the full path when you run from a checkout or a global install.

## Uninstall

1. List your accounts with `npx -y multi-account-mcp list` and remove each one with `npx -y multi-account-mcp remove <account>`. This also deletes its saved login.
2. Remove the server from each AI tool with `npx -y multi-account-mcp install <client> --uninstall`. For VS Code, Gemini CLI and Codex, delete the entry you pasted.
3. Delete the `~/.multi-account-mcp` folder and the `.bak` file that `install` created.
4. If you used the Claude Code plugin, run `/plugin uninstall multi-account-mcp@multi-account-mcp`.
