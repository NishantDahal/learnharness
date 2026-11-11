# iPad drawing companion (Drawing Pad)

Use an iPad with Apple Pencil, in Safari, as a live drawing surface for the Drawing Pad's
**Draw** panel. Lessons and chat stay on the computer. Every stroke appears live in the
Draw panel and is sent with your next answer through Drawing Pad's existing submission
path, exactly like ink drawn with a mouse. Nothing is exported, uploaded or sent to the
AI automatically.

- Free, local-first, no cloud service, no iPad app, no screen mirroring.
- Both devices edit **one** drawing: pen, whole-stroke eraser, undo, redo, clear and
  brush size synchronize in both directions.
- The iPad reaches only a small drawing server. It cannot reach LearnHarness's API,
  chats, settings, provider credentials or any other data.

## 1. Requirements

- LearnHarness 0.6.0 or newer on Windows (the same steps work on macOS/Linux).
- iPad with Safari (iPadOS 15 or newer) and Apple Pencil. A finger works too when no
  pencil has been used on that iPad.
- Both devices on the **same local network** (same Wi-Fi; guest networks and "client
  isolation" usually block device-to-device traffic).

## 2. Get the feature

The companion is part of the Drawing Pad plugin. Pick one:

### A. Running LearnHarness from source (this branch)

PowerShell, in the repository root:

```powershell
npm ci
npm run plugins:setup        # installs each plugin's SDK types + dependencies
npm run dev                  # builds core plugins, then serves http://localhost:3000
```

In a second PowerShell window, for the desktop window (instead of `npm run desktop:dev`,
whose POSIX `VAR=value` syntax does not run in PowerShell):

```powershell
$env:LH_DEV_URL = 'http://localhost:3000'; npx electron .
```

(Or just open http://localhost:3000 in a desktop browser.) After changing Drawing Pad
source, stop and re-run `npm run dev`: plugin backends are not hot-reloaded.

To build a packaged Windows app from source, follow
[desktop-release.md](desktop-release.md) (`npm run build`, `node scripts/build-server.mjs`,
`npx electron-builder --win --x64 --publish never`).

### B. Installed Windows release (no app rebuild)

An installed release ships its own copy of the Core Drawing Pad, which cannot be
replaced in place. Install this build as a separate **Community** plugin instead:

```powershell
cd plugins\drawing-pad
npm run sdk; npm ci           # first time only (needs a root `npm ci` for the SDK types)
npm run build:community
```

This creates `plugins\drawing-pad\dist-community\drawing-pad-companion\`. Then in
LearnHarness:

1. **Settings → Core plugins**: turn **Drawing Pad** off (otherwise you get two Draw
   buttons and duplicate shortcuts).
2. **Settings → Community plugins**: copy the plugins directory path, and copy the whole
   `drawing-pad-companion` folder into it, so that
   `<plugins directory>\drawing-pad-companion\dist\manifest.json` exists.
3. Refresh the list, enable **Drawing Pad (iPad companion)**, and restart LearnHarness.

The Community copy keeps its own settings and paired devices under
`<plugins directory>\drawing-pad-companion\data\`. To go back, disable it and re-enable
the Core Drawing Pad. App updates do not update this copy; rebuild it from a matching
LearnHarness source version.

## 3. Pair the iPad (once)

1. Open a lesson or practice session and click **Draw** (Ctrl+Shift+D).
2. In the Draw toolbar, click the **tablet icon** ("iPad companion").
3. Turn **iPad companion** on. The first time, Windows Defender Firewall asks whether
   LearnHarness may communicate on networks: allow **Private networks** only. (In a
   source checkout the prompt names `node.exe`.)
4. Click **Show pairing QR code** and scan it with the iPad camera; open the link in
   **Safari**. The code works once and expires after 10 minutes.
5. Optional: in Safari choose **Share → Add to Home Screen** for a full-screen drawing app.

The iPad stays paired (it remembers a device key; the computer stores only its hash).
Next time, just open the saved page or Home Screen icon. Revoke a device, or all devices,
in the same dialog at any time; a revoked iPad is disconnected immediately.

If the QR code does not connect, the dialog lists the computer's other network addresses;
try each. The Wi-Fi network must be set to **Private** in Windows (Settings → Network &
Internet → Wi-Fi → your network → Network profile type), and the firewall must allow
LearnHarness on Private networks. Manual firewall rule (Administrator PowerShell; adjust
the port if you changed it):

```powershell
New-NetFirewallRule -DisplayName "LearnHarness iPad drawing companion" -Direction Inbound -Protocol TCP -LocalPort 47821 -Profile Private -Action Allow
```

## 4. Everyday use

1. Start LearnHarness. The companion starts automatically if it was on last time.
2. In the lesson, click **Draw**. The iPad switches to that session's sheet and shows the
   same question reference as the Draw panel.
3. Write with Apple Pencil. Ink appears live in the Draw panel on the computer.
4. Answer as usual in LearnHarness. **Draw (unsent)** shows that ink will be attached to
   your next submission; nothing is submitted from the iPad.

iPad controls: Pen · Eraser (removes whole strokes, like the desktop eraser) · four brush
sizes · Undo · Redo · Clear (asks first) · Reset view · Ink (auto / black on light /
white on dark) · connection status. Use one or two fingers to move and zoom the view;
after the iPad has seen Apple Pencil once, fingers never draw (palm rejection).

Status dot: green **Live**; yellow **Waiting** (open Draw on the computer) or
**Connecting**; red **Offline** (strokes you draw are queued and sent once reconnected)
or **Not paired**. The tablet icon in the Draw toolbar shows the computer-side status.

## 5. How it behaves

- **Which drawing the iPad edits:** the sheet of the session where you most recently
  opened Draw (in this app window). Opening Draw in another session moves the iPad to
  that session's sheet. Strokes made for an older sheet are never redirected to the new
  one; the iPad reports them as not added.
- **Closing Draw** to read the question: while an iPad is connected, the iPad keeps
  writing into that session's sheet, even if nothing was drawn yet. Reopen Draw any time
  to see the ink on the computer. If the session has no sheet (for example after a new
  practice problem or an answered teaching question), the iPad gets a blank sheet without
  the question picture; reopening Draw on an untouched sheet captures the new question.
  Without a connected iPad, Draw behaves exactly as before.
- **Submitting:** in teaching sessions an accepted submission clears the sheet on both
  devices; in practice the drawing stays (existing rules). A new practice problem resets
  the sheet; open Draw again for the new problem.
- **Updates:** when LearnHarness serves a newer drawing page (after a plugin update), an
  open iPad page reloads itself once on reconnect.
- **Reconnection:** after Wi-Fi drops, sleep, or switching apps, the iPad reconnects by
  itself, receives the complete current drawing, and resends any strokes that did not
  arrive. Strokes are identified by id, so none are duplicated.
- **Coordinates:** both devices store ink in the Drawing Pad's world space (CSS pixels
  around the question reference), so handwriting keeps its size and position regardless
  of screen size or orientation. Moving/zooming the iPad view is never a drawing edit.
- **Theme:** the computer always shows ink in its configured light/dark ink color. The
  iPad's ink button only changes how the iPad displays it.

## 6. Architecture (short)

```
iPad Safari ──WebSocket (LAN, token)──▶ companion server ──ctx.events (SSE)──▶ Draw panel window
  page/app.ts                           (Drawing Pad backend,                 (Sheets = source of truth,
  page/document.ts                       node:http + ws,                       existing submission
  page/connection.ts  ◀──── ops ────────  mirror of the sheet) ◀── ctx.call ──  interceptor unchanged)
```

- `src/companion/protocol.ts`: shared message types and strict validators.
- `src/companion/server.ts`, `pairing.ts`, `backend.ts`: opt-in LAN server inside the
  plugin backend. It serves only `/`, `/app.js`, `/app.css` and an authenticated `/ws`.
- `src/companion/host.ts`: runs in the LearnHarness window. It diffs every committed
  change of the targeted sheet into ordered `push`/`pop`/`reset` operations, and applies
  iPad strokes/undo/redo/clear through the same `Sheets` methods the desktop uses.
- `src/companion/page/`: the Safari drawing surface.
- `src/companion/panel.ts`: the pairing dialog (QR code, enable/port, devices).

Why the core Drawing Pad was changed instead of writing a separate plugin: drawings
live only in the Drawing Pad window's memory, and the public plugin API offers no way for
another plugin to read or change them or to add ink to its submission. Changes to existing
Drawing Pad files are small: optional stroke `id`/`size`, a redo stack, live previews in
`state.ts`; a Redo button, a tablet button and live-preview painting in `sheet.ts`; and
wiring in `main.ts`/`backend.ts`. The existing submission interceptor is untouched.

## 7. Security

- Off by default; runs only while you have it turned on (and LearnHarness is running).
- Pairing: single-use code (256-bit, 10 minutes) in the QR link's `#fragment`, which is
  never sent in HTTP requests and is removed from the iPad's history after use. It is
  exchanged for a random device key; the computer stores only a SHA-256 hash.
- Every WebSocket must authenticate in its first message within 5 s; failed attempts are
  rate-limited per address. Origin and Host headers are checked (blocks other web pages
  and DNS rebinding). Strict CSP, `no-store`, no CORS.
- Messages are validated (shape, numeric ranges, sizes, rates) before reaching drawing
  state. At most 4 devices connect at once.
- The LAN server never proxies to LearnHarness's API and has no access path to chats,
  settings, provider keys or files.
- **Limitation:** traffic is plain HTTP/WebSocket on your LAN (no TLS), so someone able
  to watch your Wi-Fi traffic could see drawings and the device key. Use it on a network
  you trust, and revoke devices you no longer use.

## 8. Limitations

- Apple Pencil hover, double-tap/squeeze gestures and the Scribble feature are not
  available to web pages. Tilt/azimuth are not used.
- Pressure comes from Safari's `PointerEvent.pressure`; where it is not provided, strokes
  use the Drawing Pad's normal medium width.
- The eraser removes whole strokes (Drawing Pad behavior), not parts of strokes.
- Clear is not undoable (existing Drawing Pad behavior), so the iPad asks first.
- Unsent drawings live in the LearnHarness window's memory, as before: reloading or
  restarting LearnHarness loses unsent ink on both devices.
- Desktop strokes appear on the iPad when each stroke ends; iPad strokes appear on the
  computer while they are being drawn.
- If the computer's IP address changes, the saved iPad page points at the old address;
  scan a new QR code (the iPad must pair again because the browser treats the new
  address as a different site).
- The companion follows the most recently used LearnHarness window if several are open.
- iPadOS Safari may suspend the page in the background; it reconnects when shown again.
