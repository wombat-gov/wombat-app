# Changelog

All notable changes to WOMBATpass Desktop are documented here. This project
adheres to [Semantic Versioning](https://semver.org/) and
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-11-07

### Added

- Local shell state hub, live theme system, en/de localization and shell accessibility foundations.
- Context/account chips, environment kinds, production guardrails and tabbed Settings.
- Async scan center, global IaC drop, toasts and per-user notification center.
- Run context bar, command palette prefixes/recents/favorites and run actions.
- Device authorization with encrypted per-environment tokens and browser-session management.
- Offline/error recovery, diagnostics bundles, checksum-verified update downloads.
- Cross-platform tab strip, onboarding/What's New, local crash reports and support bundles.
- GitHub Actions builds for macOS (DMG/ZIP), Windows (NSIS/ZIP) and Linux (AppImage/DEB).
- Tag-driven GitHub Releases with all platform installers, CycloneDX/JSON SBOMs and SHA-256 checksums.

### Security

- Redacted diagnostics, clipboard-scan consent, external-link confirmations and optional local crash reports.
- No plaintext device tokens in renderer code or config.

## [0.x]

Earlier 0.x releases delivered the original Electron shell, tray widgets,
scanning, Help/SBOM, device auth and the U0–U8 UI hardening series.
