# Felix Canvas: UX and visual design brief

This brief turns a study of Figma and FigJam, tldraw, Excalidraw, Miro, Whimsical, Apple Freeform, Linear and Replit's file history into concrete decisions for Felix Canvas. It assumes the product design in [design.md](design.md): rooms, LWW shape edits keyed on log offset, an ephemeral presence stream, a time scrubber over the op log, a catching-up state after an offset gap, snapshots, and a status view of offsets and latency.

## What the best products agree on

1. **The work is the interface.** Figma's UI3 moved the toolbar to a slim bar at the bottom "to free up the top, creating a roomier feel overall", with panels "only appearing when needed" ([Figma, behind UI3](https://www.figma.com/blog/behind-our-redesign-ui3/)). FigJam floats its panels by default and every Figma product floats its toolbar at the bottom ([Figma, UI3 guide](https://www.figma.com/blog/making-the-move-to-ui3-a-guide-to-figmas-next-chapter/)). tldraw and Excalidraw do the same with small floating islands at the corners.
2. **Single-letter tool keys, mostly shared.** V select, H hand, R rectangle, O ellipse, L line, T text, P pen are the same in Figma, Excalidraw and Miro ([Excalidraw](https://shortcutref.com/en/excalidraw/win/), [Figma](https://www.skillademia.com/shortcuts/figma-shortcuts/), [Miro](https://help.miro.com/hc/en-us/articles/360017731033-Shortcuts-and-hotkeys)). Breaking these costs every user muscle memory.
3. **Neutral surfaces, one accent.** Linear cut its theme to three inputs (base, accent, contrast), generated in LCH, and deliberately limited how much accent leaks into the neutrals for "a more neutral and timeless appearance" ([Linear](https://linear.app/now/how-we-redesigned-the-linear-ui)).
4. **Presence is a coloured arrow plus a name pill**, with a colour that matches the person's avatar everywhere it appears (tldraw's cursor layer, [tldraw cursors](https://tldraw.dev/sdk-features/cursors); Freeform's colour bar beside each participant, [Apple](https://support.apple.com/guide/freeform/collaborate-on-a-shared-board-frfm4e6e2c9a6/mac)).
5. **Remote cursors are interpolated, never teleported** ([Liveblocks](https://liveblocks.io/blog/how-to-animate-multiplayer-cursors), [perfect-cursors](https://github.com/steveruizok/perfect-cursors)).
6. **Edits are optimistic.** Figma applies property changes immediately and discards incoming server values that conflict with its own unacknowledged changes, so the user's latest action never flickers ([Figma, multiplayer](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)).
7. **Sync status is quiet until it matters.** Figma shows a small toolbar icon with a tooltip when it is retrying or offline, and only raises a bottom notification when there are unsaved changes ([Figma, offline](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma)).
8. **History is a list of checkpoints in most products, which is the weak spot.** Figma, Miro and Notion show timestamped versions in a side list ([Figma](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history), [Miro](https://community.miro.com/product-news-31/board-history-now-available-on-team-business-consultant-enterprise-and-education-plans-5294)). Miro users have asked for a time-lapse for years ([Miro community](https://community.miro.com/ideas/time-lapse-recording-of-activity-on-board-2065)). Replit's playback, a scrollbar you drag to "watch your file change over time like a movie", is the closer model ([Replit](https://blog.replit.com/history2-release)). This is the opening for Felix: a continuous scrubber is what a log makes cheap.

## Layout and chrome

Five floating islands over a full-bleed canvas. No permanent side panels.

| Position | Contents | Reference |
|---|---|---|
| Top left | Felix cat mark (24 px, opens the app menu), room name (click to rename), workspace as muted text before it | Figma's main menu sits on the logo |
| Top right | Avatar stack, sync status chip, Share button (the only filled accent button on screen) | Figma, Miro |
| Bottom centre | Tool bar, one row, 44 px tall | Figma UI3, FigJam, tldraw |
| Bottom right | Zoom out, zoom percentage (click for menu: fit, 100%, selection), zoom in, minimap toggle | Miro's canvas controls |
| Bottom left | History button that turns the bottom bar into the scrubber | Miro puts history in its bottom-left bar ([Miro](https://www.guideflow.com/tutorial/how-to-view-board-history-in-miro)) |

- Islands sit 12 px from the viewport edge, use the panel surface, and never overlap.
- A contextual style bar (fill, stroke, width, label) floats 8 px above the selection's bounding box, flipping below when there is no room, as in Whimsical and FigJam ([Whimsical](https://whimsical.com/blog/contextual-toolbars-deep-dive)).
- Avatar stack: 28 px circles, 2 px ring in the panel colour, overlap by 8 px, at most four then a "+N" pill. Hover shows name and "Following" or "Away · 2m". Click opens the people list (see Presence); following comes later.
- Minimap is off by default; a 200 x 140 px panel above the zoom controls when on, showing the viewport rectangle in the accent and other users' viewports as thin outlines in their colour.
- `Cmd+\` hides all chrome except the status chip, matching Figma's hide-UI shortcut.
- At phone width the tool bar stays bottom centre and scrolls horizontally inside itself; the room name truncates; the zoom island collapses to the percentage button.

## Tools and interaction

- **Selection**: 1.5 px accent outline. Eight 8 x 8 px handles, white fill, 1.5 px accent border, 16 px hit area. Rotation by hovering 12 px outside a corner. Marquee in accent at 8% fill.
- **Snapping**: snap to edges and centres of nearby shapes within 6 screen px. Guides are 1 px in a warm colour (`hsl(345, 80%, 58%)`) so they never read as selection, with distance labels in JetBrains Mono 11 px.
- **Drag feel**: start a drag after 3 px of movement so clicks never nudge. Shapes follow the pointer exactly with no easing. Shift constrains to axis or 15 degree steps; Alt duplicates on drag.
- **Context menu**: right-click opens a 220 px menu with the shortcut right-aligned in muted mono beside every item, Linear-style. Groups: edit (cut, copy, paste, duplicate, delete), arrange (front, back), and a history group ("Show edit history for this shape", "Copy link to this version").
- **Undo**: per-user. `Cmd+Z` undoes only your own ops, emitted as new inverse ops on the log, so undo never rewrites history and other people's work is never reverted by you. This matches Figma's multiplayer undo rules ([Figma](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)).
- **Command menu**: `Cmd+K` opens a searchable list of every action and room, which is Linear's single most important affordance ([Linear shortcuts](https://shortcut.fyi/linear-shortcuts)).

## Shortcuts

| Key | Action | Convention |
|---|---|---|
| V | Select | Figma, Excalidraw, Miro |
| H, or hold Space | Hand | All |
| R | Rectangle | Figma, Excalidraw, Miro |
| O | Ellipse | Figma, Excalidraw |
| L | Line | Figma, Excalidraw |
| P (D also works) | Pen stroke | P in Excalidraw and Miro, D in tldraw |
| T | Text label | All |
| I | Image placeholder | No convention; show it in the tooltip |
| Esc | Back to select, deselect | All |
| Cmd+Z, Shift+Cmd+Z | Undo, redo (own ops) | All |
| Cmd+D, Backspace | Duplicate, delete | Figma |
| [ and ] | Send backward, bring forward | tldraw, Figma |
| Arrows, Shift+arrows | Nudge 1 px, 10 px | Figma |
| Shift+1, Shift+2, Shift+0 | Zoom to fit, to selection, to 100% | Figma |
| Cmd+K | Command menu | Linear |
| Cmd+Shift+H | Toggle history scrubber | New |
| ? | Shortcut sheet | Miro, Linear |

Tool tooltips appear after 500 ms on first hover and instantly when moving between adjacent tools, and always show the key.

## Presence

- **Cursor**: a 16 px arrow filled with the user's colour, 1.5 px white outline (it reads on both themes), and a name pill 12 px right and 12 px below the tip: user colour background, white Inter 11 px semibold, 4 px x 6 px padding, 6 px radius.
- **Colour assignment**: hash the session id into an eight-colour palette, then walk to the next free colour if someone in the room already has it. Keep hue 170 to 210 out of the palette so cyan stays Felix's own. tldraw ships a twelve-colour list for the same job ([tldraw](https://tldraw.dev/sdk-features/cursors)).

  | Name | Value |
  |---|---|
  | Coral | `hsl(4, 82%, 60%)` |
  | Orange | `hsl(26, 92%, 54%)` |
  | Amber | `hsl(42, 95%, 48%)` |
  | Green | `hsl(142, 58%, 42%)` |
  | Blue | `hsl(222, 84%, 62%)` |
  | Violet | `hsl(262, 72%, 64%)` |
  | Magenta | `hsl(312, 68%, 58%)` |
  | Rose | `hsl(344, 78%, 60%)` |

- **Smoothing**: publish at most once per frame as the design says, then render remote cursors with a critically damped spring (about 80 ms to settle). Springs give the best balance of speed and smoothness; splines are more accurate but wait for extra points ([Liveblocks](https://liveblocks.io/blog/how-to-animate-multiplayer-cursors)). If a cursor jumps more than 800 screen px, snap instead of animating across the canvas.
- **Others' selections**: 1.5 px outline in their colour, plus a small name tag on the top-left corner of the bounding box. Shapes another user is dragging get the same outline, so it is always clear whose hand is on what.
- **Off-screen users**: a small arrow in their colour pinned to the viewport edge, pointing at their cursor, as tldraw does. Click it to jump there.
- **Follow**: click an avatar. The camera eases toward their viewport, fast at first, then locks once within 2 px, as tldraw's follow chase does; follow chains resolve to the leader; any canvas interaction stops following ([tldraw following](https://tldraw.dev/sdk-features/user-following)). While following, a 2 px border in the leader's colour frames the viewport with "Following Ana · Esc to stop" in a pill at top centre.
- **Idle**: no pointer movement for 10 s fades the cursor and pill to 0 over 400 ms and dims the avatar to 50%. The label is "Away", with the time once it passes a minute ("Away · 2m"); a tab in the background reads the same way.
- **People list**: clicking the avatar stack opens a 280 px popover titled "3 people here" (or "Just you here"): you first with your name editable in place, then everyone else with a green dot and "Active", or "Away". Until follow exists, this is what the click does. Membership expiry (the 30 s TTL in the design) removes the avatar with a 200 ms shrink. Freeform announces joins and leaves ([Apple](https://support.apple.com/guide/freeform/collaborate-on-a-shared-board-frfm4e6e2c9a6/mac)); do that with a 2 s toast only while the room has fewer than ten people.
- A "Hide cursors" toggle lives in the view menu, per user, as in Miro ([Miro](https://community.miro.com/ask-the-community-45/hide-collaborators-cursors-moved-18024)).

## History scrubber

History mode replaces the bottom tool bar with a full-width timeline (inset 12 px, 64 px tall). Entering it is 200 ms; the canvas keeps its zoom and position.

- **Track**: the x axis is the room's change count (its log offset), not wall time, labelled with both ("Change 18,422 · 14:03"). Above the track, a 16 px density histogram of ops per bucket, each bar tinted by the dominant author's colour, so bursts of work and who did them are visible at a glance.
- **Markers**: snapshot positions as small diamonds; the retention floor as a hatched region at the left end labelled "History starts at change 4,100".
- **Playhead**: a 2 px accent line with a mono change-number readout. Drag to scrub; the canvas re-renders every frame from the nearest snapshot plus ops.
- **Controls**: play or pause (Space), speed 1x, 4x, 16x, step one op (left and right arrows, as in Replit's history), step 100 ops with Shift.
- **Live edge**: the right end shows a "Live" pill. While you scrub, others keep editing; the track grows and the pill shows "+37 new". Click it or press `L` to return.
- **While scrubbing**: shapes are read-only, remote cursors hide, a 1 px inset accent border tells you the canvas is not live. Hovering a shape shows "Created by Ana at change 1,204, last edited at change 18,390".
- **Restore to here** writes new ops that set the room to the scrubbed state. History is appended, never rewritten, which is the same promise Figma makes when restoring adds new checkpoints ([Figma](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)).

## Sync states

One status chip in the top-right island: an 8 px dot and a short label. It changes text, not size: the label slot has a fixed minimum width and numbers use tabular figures.

| State | Trigger | Chip | Elsewhere |
|---|---|---|---|
| Live | Subscribed, no gap, acks flowing | Green dot, "Live", plus own round trip ("Live · 23 ms") | Nothing |
| Saving | Unacked local ops for more than 300 ms | Dot pulses, "Saving 3" | Nothing |
| Catching up | Offset gap detected, re-subscribing from last applied offset | Amber dot, "Catching up" and a thin determinate bar under the chip from gap start to tail | Canvas stays interactive; local edits still queue |
| Reconnecting | Socket lost, retrying | Amber dot, "Reconnecting" after an 800 ms grace period | Nothing for brief drops, as the design promises |
| Offline | Retries exhausted or browser offline | Grey dot, "Offline · 5 edits queued" | Bottom toast only if edits are queued, Figma-style |
| Rejoining | Offset below retention, snapshot rejoin | Amber dot, "Rebuilding" | Canvas dims to 60% with a centred card: "Loading the canvas: 422 recent changes" |
| Converged | After catching up or rejoining | Green check for 2 s, "Up to date" | Nothing |
| No access | The signed-in person is not a member of the room | None: the chrome hides | The dimmed canvas behind one card with the cat mark and a lock: "You don't have access to this canvas", who to ask, "Switch account", "Go to the lobby", and "Signed in as Ana" |
| Signed out | The sign-in ended or did not finish | None: the chrome hides | The same card: "Sign in to open this canvas" and a "Sign in" button |

The transitions are where trust comes from: the user should see the gap named, the progress counted, and a clear "Up to date" at the end. Never show a spinner without a number.

## Visual tokens

Define these on `:root`, with dark overrides under `prefers-color-scheme: dark` guarded by `:root:not([data-theme="light"])` and again under `:root[data-theme="dark"]`.

| Token | Light | Dark |
|---|---|---|
| `--canvas` | `hsl(220, 16%, 97%)` | `hsl(222, 14%, 8%)` |
| `--canvas-dot` (24 px grid) | `hsl(220, 12%, 84%)` | `hsl(222, 10%, 20%)` |
| `--panel` | `#ffffff` | `hsl(222, 12%, 12%)` |
| `--panel-raised` (menus) | `#ffffff` | `hsl(222, 11%, 15%)` |
| `--border` | `hsl(220, 13%, 89%)` | `hsl(222, 10%, 21%)` |
| `--text` | `hsl(222, 22%, 11%)` | `hsl(220, 14%, 93%)` |
| `--text-muted` | `hsl(220, 9%, 45%)` | `hsl(220, 8%, 62%)` |
| `--accent` | `hsl(192, 95%, 29%)` | `hsl(192, 90%, 42%)` |
| `--accent-soft` | accent at 10% | accent at 16% |
| `--ok` / `--warn` / `--bad` | `hsl(152, 60%, 36%)` / `hsl(38, 92%, 44%)` / `hsl(0, 70%, 50%)` | `hsl(152, 55%, 48%)` / `hsl(40, 92%, 56%)` / `hsl(0, 75%, 62%)` |
| `--accent-text` (on accent fills) | `#ffffff` | `hsl(222, 22%, 8%)` |
| `--ink` (default shape stroke) | `hsl(222, 22%, 14%)` | `hsl(220, 14%, 90%)` |
| `--shape-fill`, `--handle` | `#ffffff` | `hsl(222, 12%, 12%)` |
| `--hover` / `--pressed` | `hsl(220, 14%, 95%)` / `hsl(220, 14%, 91%)` | `hsl(222, 10%, 18%)` / `hsl(222, 10%, 22%)` |

- **Elevation**: two levels only. Islands use `0 1px 2px rgb(0 0 0 / .06), 0 4px 12px rgb(0 0 0 / .08)` in light. In dark, shadows barely read, so islands get a 1 px border plus `0 8px 24px rgb(0 0 0 / .45)`. Menus and popovers add 4 px more blur.
- **Radius**: 6 px for buttons and inputs, 10 px for islands, 12 px for dialogs, full for avatars and pills.
- **Density**: 32 px tool buttons, 4 px gaps, 1 px dividers between tool groups (select and hand | shapes | pen and text | image).
- **Type**: Inter Variable, 13 px default UI size, scale 11 / 12 / 13 / 15 / 20. Weights 450 body, 550 labels, 650 room name. JetBrains Mono Variable at 11 to 12 px with `font-variant-numeric: tabular-nums` for every offset, latency and count.
- **Dark mode** is a first-class theme, not an inversion: the canvas is darker than panels, shape default stroke flips to near-white, and user-chosen shape colours keep their hue but shift lightness so they hold contrast, as Linear does by generating both themes from the same LCH inputs.
- **Brand**: the cat mark appears once, top left, at 24 px inside a 32 px button. Use it again only on the empty-room state, the loading card and the no-access card. Accent is reserved for selection, focus rings, the playhead, the Share button, your own follow border, and the one action on a card that replaces the canvas.

## Motion

| Element | Duration | Easing |
|---|---|---|
| Button hover and press | 100 ms | ease-out |
| Tooltip, small popover | 140 ms | `cubic-bezier(0.23, 1, 0.32, 1)` |
| Menus, style bar | 160 ms, 4 px rise | same |
| Entering history mode | 200 ms | same |
| Camera: zoom to fit, jump to user | 280 ms | `cubic-bezier(0.77, 0, 0.175, 1)` |
| Idle fade | 400 ms | linear |

UI motion stays under 300 ms and uses strong ease-out for entering elements ([Emil Kowalski](https://emilkowal.ski/ui/great-animations)). Shapes under your own pointer never animate. Honour `prefers-reduced-motion` by cutting camera moves to instant and keeping only opacity fades.

## Icons

Use [Lucide](https://lucide.dev) at 18 px with a 1.75 px stroke, the size and weight that match Inter at 13 px. Excalidraw uses Tabler, which shares Lucide's 24 px, 2 px stroke language ([Excalidraw discussion](https://github.com/excalidraw/excalidraw/discussions/7184), [Tabler vs Lucide](https://iconstack.io/compare/tabler-vs-lucide)); Lucide is MIT licensed and ships plain SVGs and a framework-free `lucide` package, which suits a canvas with no UI framework. Figma drew 200 custom icons for UI3, which is the bar to aim for in consistency, not in count. Draw only one custom glyph: an offset-gap icon (a dashed segment in a line) for catching up.

## Performance feel

- Optimistic echo with Figma's rule: drop incoming values for a field that has an unacknowledged local write, then reconcile on ack.
- Render the canvas in one `requestAnimationFrame` loop; cursors and handles on an overlay layer with transforms, never layout properties.
- Chrome never reflows when state changes: fixed-width chip slot, tabular numbers, numbers refresh at most 4 times a second.
- Cold join shows the snapshot frame as soon as it decodes, then applies the tail. Never show an empty canvas with a spinner if any frame is available.

## Things to avoid

- Fully opaque docked sidebars. Figma tried floating panels by default and reverted for its design tool, but a whiteboard has no property-heavy workflow to justify docking.
- More than one accent. Status colours are for status only, at small sizes.
- Blocking modals for connection trouble. Only snapshot rejoin dims the canvas.
- Raw IDs, JSON, or a scrolling log on the main screen.
- Cursor chat, reactions, stickers and emoji: out of scope and off-message.
- Assigning cyan to a person.
- Animating remote shape moves with long easing; it reads as lag.

## Felix-specific: show what Felix does without a debug page

The app exists to show three Felix properties: fanout is cheap, a slow client hurts only itself, and replay by offset is free. Each gets one tasteful surface.

1. **Round-trip number on the chip.** "Live · 23 ms" is the time from making a change to seeing it confirmed (publish to own delivery on the op log), p50 over the last ten seconds, in mono. With no edits in that window it shows the same measurement on the presence stream, which every session publishes to at least every 3 seconds. It is small and always there, which is what makes it credible.
2. **Status popover** (click the chip), titled "Sync". A 320 px card with rows in mono: "Changes in this room" (the log tail), "Synced here" (what this tab has applied), "Save time" p50 and p99 with a 60-point sparkline (the edit round trip), "Cursor delay", "Your connection" and "Server save" (the gateway's two legs, browser to gateway and gateway to Felix ack) so the latency budget is visible, and "Canvas version" (the state hash of the applied prefix). A row for viewers in the room comes with presence membership. No other numbers.
3. **Catching up as a feature, not an error.** The determinate bar counts the gap ("Catching up on 439 changes") and ends with "Up to date · version a3f9 matches". The hash check is demonstration 3 made visible.
4. **A slow-lane switch** in the popover: "Throttle this tab to 100 kbit/s". Presenters flip it, everyone else's chip keeps showing the same round trip, and this tab walks through catching up and converges. That is demonstration 2 on screen, with no terminal.
5. **Change numbers in the scrubber axis and the shape tooltip** ("last edited at change 18,390"). The log is the document, so its history is addressed by change number, which is the log offset underneath.
6. **An Inspect view** (`\` toggles) that labels each shape with its last change number and author colour in 10 px mono badges. It is off by default and lives in the view menu, so the normal canvas stays clean.
7. **Copy link to this version** in the context menu produces a link that opens the room scrubbed to that change. Shareable history is the most persuasive replay demo.

The UI never exposes storage or transport terms: no "log", "offset", "stream", "replay", "gateway", "snapshot" or "hash" in any label, tooltip, toast, error or empty state. Use product words such as "Saved", "Syncing", "Reconnecting", "change" and "version"; the terms above stay in the design docs and the code.

Rule for all of it: Felix detail is one click away, never in the way, typeset in the same mono at the same muted colour, and updated no faster than a person can read.
