# Contributing

flightstrip is small on purpose: about 6,000 lines of TypeScript, React and Node, with no runtime dependencies. You can read the part you want to change in one sitting. Fork it, make the board look the way you think, and send the good parts back.

## Run it with hot reload

```bash
git clone https://github.com/wangxuzhou666-arch/flightstrip
cd flightstrip && npm install
npm run dev:demo    # sample sessions, nothing read from ~/.claude
npm run dev         # your real sessions
```

Open `http://127.0.0.1:5317`. Edits to the client reload in the browser, and edits to the server restart it. If the board is already running on port 4317, start the dev server on another one with `PORT=4327 npm run dev:demo`.

## Where things are

| To change | Edit |
| --- | --- |
| Colors, light and dark | `client/src/styles.css`: every color is a variable on `:root`, with dark values below it |
| One tile (stage, progress, to-dos, context, memory) and the details panel it opens | `client/src/SessionCard.tsx` |
| The overview: groups, dragging, the tiles grid | `client/src/Groups.tsx` |
| The page: top bar, the band of readings, the rail, the Background jobs tab | `client/src/Board.tsx` |
| The machine and weekly-limit readings | `client/src/Machine.tsx`, `client/src/Usage.tsx` |
| The memory ranking in the rail | `client/src/Hogs.tsx` (display), `server/hogs.ts` (sampling, pause and end), `server/alerts.ts` (the notification) |
| Any text on the board | `shared/i18n/en.ts` and `shared/i18n/zh.ts` |
| The sample sessions (`--demo` and the live demo) | `shared/demo.ts` |
| What gets read from a transcript | `server/transcript.ts` |
| How the snapshot is put together | `server/collect.ts` |
| The Haiku goal and progress lines | `server/brief.ts` |

## Common changes

- **Restyle the board.** Change the variables at the top of `styles.css` first. Most colors only show state (blue running, orange needs you, red failed, green done), so a new palette needs four clearly different state colors.
- **Show something new on a strip.** The data comes from `server/transcript.ts` and travels to the client in the snapshot types in `shared/types.ts`. Add the field there, then render it in `SessionCard.tsx` (on the tile only if it earns it, otherwise in the details), and give one of the sessions in `shared/demo.ts` a value so others can see it.
- **Add or reword text.** Put the English string in `en.ts` and the Chinese one in `zh.ts`. `zh.ts` is typed against `en.ts`, so a missing translation fails `npm run typecheck`.

## What belongs on a strip

The board exists to show less. A new field earns its place on the tile if it helps you decide which session needs you next. Everything else belongs in the details panel, or in another tool.

## Before you open a pull request

```bash
npm run typecheck && npm test
```

- For a visible change, attach a screenshot in light and dark mode, and one at phone width (about 390px).
- Use the sample sessions in `shared/demo.ts` for screenshots, fixtures and tests. Never commit real transcripts, session ids or paths from your machine.
- For a bigger change, such as a new tab, a new data source or a new dependency, open an issue first so we can agree on the shape before you build it.

Bug reports are just as welcome. flightstrip reads files Claude Code writes for itself, so when an update changes them, an issue with your Claude Code version and what looks wrong is the fastest way to get it fixed.
