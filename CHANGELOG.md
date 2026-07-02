# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-07-01

### Added

- Weekly token quota alongside the 5-hour quota in the status bar (e.g. `8% 5h · 15% wk`). Both `TOKENS_LIMIT` entries are now read and disambiguated by the API `unit` field.
- Per-window reset countdowns in the tooltip (`5-hour window: 8% used — resets in 2h30m`)

### Changed

- Peak timing text removed from the inline status bar; urgency is now signaled by background color only (red = in peak, pink = within 30 min, orange = within 1 hour)
- Peak line moved to the tooltip, prefixed with a colored circle emoji (🔴/🩷/🟠/🟢) mirroring the status bar tier
- Cache schema bumped to `2.0` to invalidate entries stored under the previous single-window DTO

## [0.5.0] - 2026-07-01

### Added

- Peak/off-peak indicator in the status bar showing the next boundary in local time (e.g. `· peak at 11:00 PM` when off-peak, `· off-peak at 3:00 AM` during peak)
- Status bar highlights as peak (3x multiplier window, 06:00–10:00 UTC daily) approaches: orange within 1 hour, red within 30 minutes
- `zaiUsage.timezone` setting (IANA identifier, default `America/Los_Angeles`) for DST-accurate local-time display via `Intl.DateTimeFormat`
- Peak-state line in the status bar tooltip

### Changed

- Fork publisher updated to `roryheaney`

## [0.4.0] - 2026-05-22

### Added

- Clickable status bar

### Changed

- Add language detection config
- Fix biome formatting in extension.ts
- Sync package-lock.json version to 0.3.0

## [0.3.0] - 2026-03-16

### Added

- Display mode setting for usage/remaining tokens (`zaiUsage.displayMode`) — choose between percentage, absolute numbers, or both

### Changed

- Update README with displayMode setting documentation
- Add GitHub workflow for adding project to codespaces
- Update README to reference GLM Coding Plan
- Add v0.2.0 changelog entry
- Format codebase

## [0.2.0] - 2026-03-13

### Added

- Configurable status bar priority (`zaiUsage.statusBarPriority`, default 10000) — allows positioning the z.ai Usage item adjacent to vscode-copilot-usage. Change takes effect after reloading the window.

## [0.1.0] - 2026-03-12

### Added

- Initial release
- Display z.ai token usage percentage in the VS Code status bar
- Show time remaining until quota resets (`nextResetTime`) when available
- Secure API key storage via VS Code Secret Storage
- Configurable refresh interval (`zaiUsage.refreshInterval`, default 60s)
- Toggle between z.ai icon and text prefix (`zaiUsage.useIcon`)
- Command: `z.ai Usage: Set API Key` — enter and verify your z.ai API token
- Command: `z.ai Usage: Clear API Key` — remove the stored API token
- Status bar click triggers API key setup dialog when unauthenticated
- Cache invalidation when `nextResetTime` has passed
