SkyNot [![NPM Version](https://img.shields.io/npm/v/skynot)](https://www.npmjs.com/package/skynot)
======

Ever tempted to use or try out the infamous `pi-coding-agent` but got put off by its lack of out-of-the-box sandbox?

Some people use and/or develop guardrails extensions or poor-man sandboxing solutions; others just deploy it to their VPS so that any potential damage is contained.

But the virtue is somewhere in the middle:
- No need to go to the extreme of complicated cloud deploys to just try out some clanking business.
- No need to setup potentially-unsafe tweaks or plugins that may give you a false sense of security, or too many permissions issues for your clanker to be productive.

Why not just use the **unix** model? Give Pi a user in your system, a $HOME where to place its git repositories and you're off to the races.

This repository is just a quick `npx` tool that helps you set up this ideal approach: run it with a simple `npx skynot` and it will guide you through the process and ask you for sudo permissions in each step that it requires, informing you of what it is doing at all times.

(This repo is of course opensource too so that you can check that what it says it does is what it really does.)


## Installation Steps (performed automatically under-the-hood by skynot)

1. Check if wget is present; if not: abort suggesting user to install it or use `--npm` flag.
2. Create a user named `aidev`, if missing.
3. Create a group named `aiteam`, if missing.
4. Assign both `aidev` user and current user to group `aiteam`.
5. Create sudoers file so that current user can impersonate `aidev` without needing a (sudo) password.
6. Setup 007 umask and ACLs for `aidev` and current user to share files without issues.
7. Download & install Pi under `aidev` user's home: `~aidev/pi/`.
8. Install the recommended extensions and/or authentication files if user used flags for them.
9. Configure git to be able to share repositores in `~aidev/` dir.
10. Add the agent's binary directory to the `aidev` user's `$PATH` env var.
11. Create a launcher script at `$HOME/bin/spi` for the current user.
12. Create a proper work dir inside `~aidev` named `Work`, owned by `aidev:aiteam`.


## Launch Steps (performed every time you run the launcher script `spi`)

1. Check that all directories of users are not readable or writable by `aidev` user.
2. If any of the user directories are readable or writable, prompt to shield them.
3. Launch Pi with the `aidev` user.


## Usage

```bash
npx skynot [options]
```

The following command‑line flags are available:

| Flag         | Alias  | Description                                                                       |
|--------------|--------|-----------------------------------------------------------------------------------|
|`--help`      | `-h`   | Show the help message with all available options.                                 |
|`--auth`      | `-a`   | Ask about auth details (provider name and API key) to add it to launcher script.  |
|`--extensions`| `-e`   | DEPRECATED: Use `spi install <extension>` instead, after install.                 |
|`--git ["id"]`| `-g[i]`| Set git `user.name`/`user.email` for `aidev`. No arg: copies from current user.   |
|              |        | With arg (e.g. `"Name Surname <user@example.com>"`): uses that instead.           |
|`--npm`       | `-n`   | Install Pi using npm instead of tarball (likely to be slower though).             |
|`--paranoid`  | `-p`   | Never cache the sudo password; ask for it every time it is needed.                |
|`--ssh`       | `-s`   | Copy SSH keys to the `aidev` user for git+ssh (& add GitHub to `known_hosts`).    |
|`--update`    | `-u`   | Wipe any previous existing install of Pi and reinstall, to get the latest version.|
|`--verbose`   | `-v`   | Show more output from install commands (useful for debugging/low-bandwidth).      |
|`--version`   | `-V`   | Output the version number.                                                        |
|`--destroy`   |`--BURN`| Delete the `aidev` user, all its data (in `$HOME`), and the `aiteam` group.       |


Please note, `-u` would technically not wipe or reinstall extensions, as they normally live in a different place (`.pi` subdir under `aidev` user's $HOME, and/or $NPM_CONFIG_PREFIX dir).


## Notes

- The script runs many operations as the `aidev` user via `sudo`. It sets `npm_config_prefix` to `$HOME/.npm-global` to avoid permission errors when installing extensions from NPM.
- To test locally (directly from sources instead of using `npx`), use `npm run exec -- [options]` (e.g. `npm run exec -- -e`).


## Requirements

* Linux or macOS
* NodeJS v22.x
* NPM's `npx` (install with `brew install npm` or `apt install npm`)
