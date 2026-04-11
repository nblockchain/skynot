SkyNot
=======

Ever tempted to use or try out the infamous `pi-coding-agent` but got put off by its lack of out-of-the-box sandbox?

Some people use and/or develop guardrails extensions or poor-man sandboxing solutions; others just deploy it to their VPS so that any potential damage is contained.

But the virtue is somewhere in the middle:
- No need to go to the extreme of complicated cloud deploys to just try out some clanking business.
- No need to setup complicated tweaks or plugins that may give you a false sense of security, or too many permissions issues for your clanker to be productive.

Why not just use the unix model? Give pi a user profile in your system, a $HOME where to place its git repositories and you're off to the races.

This repository is just a quick NPX tool that helps you set up this ideal approach: run it with a simple `npx skynot` and it will guide you through the process and ask you for sudo permissions in each step that it requires, informing you of what it is doing at all times.

(This repo is of course opensource too so that you can check that what it says it does is what it really does.)

## Usage

```bash
npx skynot [options]
```

The following command‑line flags are available:

| Flag | Description |
|------|-------------|
| `-u, --update` | Wipe any existing installation of `pi-coding-agent` and reinstall the latest version. |
| `-e, --extensions` | After installing `pi-coding-agent`, also install recommended extensions. |
| `-h, --help` | Show the help message with all available options. |
| `-V, --version` | Show the version number. |

## Installation Steps (performed automatically)

1. Ensure a `pi` user exists (created if missing).
2. Install `@mariozechner/pi-coding-agent` under `~pi/pi/`.
3. Optionally install the recommended extensions.
4. Add the agent's binary directory to the `pi` user's `$PATH`.
5. Create a launcher script at `$HOME/bin/pi` for the current user.
6. Launch the agent.

## Notes

- The script runs many operations as the `pi` user via `sudo`. It sets `npm_config_prefix` to `$HOME/.npm-global` to avoid permission errors when installing extensions.
- To test locally before publishing, use `npm run run -- [options]` (e.g. `npm run run -- -e`).
