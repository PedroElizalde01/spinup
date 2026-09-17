# Security policy

## Supported versions

Only the latest release receives fixes. Upgrade with `spinup --update` or the
installer before reporting.

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on
[PedroElizalde01/spinup](https://github.com/PedroElizalde01/spinup/security/advisories/new).
Do not open a public issue.

Include the spinup version, your OS and architecture, and the smallest steps that
reproduce the problem. You will get an acknowledgement within 7 days and a fix or
decision within 30.

## Scope

spinup runs the commands in a project's `.spinup.yml` with your privileges. A
config is trusted code, like a Makefile; running a malicious config is not a
vulnerability in spinup. These are in scope:

- Writing or deleting files outside what spinup owns: its registry, the generated
  commands in the shim directory, and the project config you asked it to write.
- Acting on a tmux session or process group spinup did not create.
- Printing environment values or other secrets into terminals, logs or errors.
- Installing or updating to a binary whose checksum does not match the release.

## Verifying a release

Every release publishes `SHA256SUMS` and GitHub build provenance for each asset.
The installer and `spinup --update` check the checksum before replacing anything.
To verify provenance yourself:

```bash
gh attestation verify spinup-linux-x64 --repo PedroElizalde01/spinup
```
