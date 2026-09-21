# Security policy

## Reporting a vulnerability

Report vulnerabilities in this project privately through
[GitHub's private vulnerability reporting](https://github.com/karimaounn/angular-capacitor-workspace/security/advisories/new).
Please do not open a public issue for them.

In scope:

- the code in `angular-capacitor-workspace` or
  `create-angular-capacitor-workspace`
- something they generate that is unsafe, such as a CI workflow, an
  `allowScripts` entry or a configuration default

Include the affected version, how to reproduce it, and what an attacker gains.
Fixes ship as patch releases. If the fix changes generated files, the release
notes say what to change in workspaces that already exist.

## Advisories in dependencies

A known advisory in a package that a generated workspace installs is already
public, so report it as a normal issue, or open a pull request with a policy
entry (see [CONTRIBUTING.md](CONTRIBUTING.md#patching-the-dependency-policy)).
Include the output of `npx angular-capacitor-workspace audit`. It names the
advisory and the dependency path, and suggests a remedy.

The nightly advisory sweep opens an issue when a new advisory affects a
generated workspace, so check whether one exists before opening another.

## Supported versions

Fixes go to the latest release of the current Angular major's line (22.x for
Angular 22), and to the maintenance branch of the previous major while it is
maintained.
