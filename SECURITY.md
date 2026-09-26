# Security Policy

## Supported versions

Security fixes are applied to the latest published extension release on the `master` branch. Older store builds may not receive backports.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Use GitHub's private vulnerability reporting for this repository:

**[Report a vulnerability](https://github.com/Fooftilly/kokoro-extension/security/advisories/new)**

If private reporting is not yet enabled on the repository, contact the maintainer privately (for example via a GitHub Security Advisory request once enabled, or another private channel they publish) and do not include exploit details in public issues or PRs.

Include:

- Affected browser(s) and extension version
- A clear description of the impact
- Steps to reproduce (or a minimal proof of concept)
- Any suggested remediation

You should receive an acknowledgment when the report is reviewed. Please allow reasonable time for investigation and a fix before any public disclosure.

## Scope notes

- The extension sends selected or extracted text to the **user-configured** Kokoro-FastAPI endpoint. Misconfiguration of a remote endpoint is a user trust decision, not automatic exfiltration by a hardcoded third party.
- Permission or host-permission changes in PRs are sensitive; reviewers should treat unexpected broadening as a security concern.
