# Contributing to wombat-app

WOMBATpass Desktop is the Electron shell around the Wombat dashboard. The dashboard itself lives in `wafpass-dashboard`; the API lives in `wafpass-server`.

## Before you start

- Open an issue for larger changes so the approach can be agreed before implementation.
- Keep pull requests focused and include tests for behaviour changes.
- Sign off your commits with `git commit -s` (Developer Certificate of Origin, see `DCO`).

## Development checks

```bash
npm ci
npm run dashboard:build
npm run check:i18n
npm run test:smoke
npm run test:ui
npm run test:palette
npm run test:tabs
```

Platform packaging:

```bash
npm run package:mac   # macOS
npm run package:win   # Windows
npm run package:linux # Linux
```

## Pull requests

- Describe the problem and the chosen approach.
- Link related issues.
- Update `CHANGELOG.md` when the change is user-visible.
- Keep documentation and examples in sync with the code.
