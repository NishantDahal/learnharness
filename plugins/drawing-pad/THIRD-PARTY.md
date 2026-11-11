# Attribution and licenses

## Handwriting contribution (adapted mechanics)

Pressure-sensitive strokes, whole-stroke segment-distance erasing, undo history,
mouse/stylus pointer handling, and frozen background composition are adapted from:

- Repository: https://github.com/hrdkj/learnharness
- Branch: `codex/handwriting-contribution`
- Reviewed commit: `48dd022`
- Files: `src/core/question-writing.ts`, `components/question-writing.tsx`,
  `components/question-writing-capture.ts`
- License: AGPL-3.0-only, the same license as LearnHarness and this plugin.

This is plugin-owned code using public host capabilities, not a copy of the
contribution's private native UI integration. The plugin adds per-session lifetime,
settings, submission interception, and practice-specific acceptance/reset behavior.

## html-to-image 1.11.13

https://github.com/bubkoo/html-to-image

MIT licensed. Bundled solely to capture plugin-owned rendered reference DOM; the
package license is copied to `dist/licenses/html-to-image-LICENSE` during build.

## ws 8.22.1

https://github.com/websockets/ws

MIT licensed. Bundled into `backend.cjs` for the opt-in iPad companion's WebSocket
server; its license is copied to `dist/licenses/ws-LICENSE` during build. The optional
native accelerators (`bufferutil`, `utf-8-validate`) are not bundled.

## qrcode-generator 2.0.4

https://github.com/kazuhikoarase/qrcode-generator

MIT licensed (Copyright (c) 2009 Kazuhiko Arase). Bundled into `backend.cjs` to encode
the companion pairing link as a QR code; the notice is kept in
`licenses/qrcode-generator-LICENSE` and copied to `dist/licenses/` during build.
"QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
