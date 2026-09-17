# Installation

spinup is a single binary for Linux (x64, arm64, glibc or musl) and macOS (Intel or
Apple Silicon). On Windows, use it inside WSL.

## Install script

```bash
curl -fsSL https://raw.githubusercontent.com/PedroElizalde01/spinup/main/install.sh | bash
```

The script picks the right binary for your OS, architecture and C library,
verifies it against the release's `SHA256SUMS`, confirms it runs and reports the
expected version, and only then moves it into place. If anything fails, an existing
spinup is left exactly as it was.

| Option | Effect |
|---|---|
| `--version v0.5.0` | Install a specific release instead of the latest |
| `--bin-dir PATH` | Install somewhere other than `~/.local/bin` |

If `spinup` is not found afterwards, add the directory to your `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

The man page is installed to `~/.local/share/man/man1/spinup.1`; `man spinup` finds
it on most systems.

## Verify a download yourself

Every release publishes `SHA256SUMS` and signed build provenance for each file.

```bash
curl -fsSLO https://github.com/PedroElizalde01/spinup/releases/latest/download/spinup-linux-x64
curl -fsSLO https://github.com/PedroElizalde01/spinup/releases/latest/download/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS      # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
gh attestation verify spinup-linux-x64 --repo PedroElizalde01/spinup
```

## Update

```bash
spinup --update            # latest release
spinup --update v0.5.0     # a specific version, including an older one
```

The update applies the same checks as the installer and replaces the binary with a
single rename. It refuses to move to an older latest release unless you name the
version.

## Requirements

- **tmux 3.0 or newer** only for actions with `mode: tmux`.
- **Docker with the Compose plugin** only for projects that run Compose.

`spinup <alias> --check` reports what a project's selected action actually needs.

## Shell completion

```bash
eval "$(spinup --completion bash)"      # add to ~/.bashrc
eval "$(spinup --completion zsh)"       # add to ~/.zshrc
spinup --completion fish | source       # add to ~/.config/fish/config.fish
```

Completion covers registered aliases, flags, action names after `--action` and
service names after `--restart`, for `spinup` and for every alias command.

## Uninstall

```bash
spinup <alias> --remove                 # for each registered project
rm ~/.local/bin/spinup ~/.local/share/man/man1/spinup.1
rm -r ~/.config/spinup ~/.local/state/spinup
```
