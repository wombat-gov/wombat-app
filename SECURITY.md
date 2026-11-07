# Security policy for wombat-app

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue or pull request.

- Email: **page@wombat-gov.dev**
- Or use GitHub private vulnerability reporting for this repository if enabled.

Include a description, reproduction steps or proof of concept, affected versions/commits, and any suggested mitigation. We aim to acknowledge reports within 5 business days.

## Supported versions

The `main` branch and the latest published release receive security fixes. Older releases are supported on a best-effort basis only.

## In scope

The Electron shell, loopback HTTP proxy, dashboard packaging, device-token storage, update verification, and Windows/macOS/Linux installers.

## Out of scope

- Vulnerabilities in third-party dependencies unless exploitable through this repository's own code.
- Reports that require physical access to an unlocked device or a compromised developer machine.

## Disclosure

Please allow time for a fix before public disclosure. We will coordinate a disclosure date with the reporter.
