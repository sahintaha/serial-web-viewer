# Contributing

Bug reports and pull requests are welcome. For anything larger than a small fix, open an
issue first so the approach can be agreed before you spend time on it.

## Reporting a bug

Include the steps to reproduce, what you expected and what happened, the mode
(Tarayıcı / Sunucu / Simülatör), browser and Node.js versions, and — for test station
problems — the communication log of the run (Geçmiş → record → Haberleşme kaydı).

## Development setup

Node.js 22.13 or newer.

```bash
npm ci
npm start                       # http://localhost:3000, prints the setup code on first start
npm test                        # unit and integration tests
npm run test:e2e                # Playwright (first run: npx playwright install chromium)
PW_CHANNEL=msedge npm run test:e2e   # or use an installed Edge / Chrome instead
npm run lint
```

The browser-only build is just `public/`; serve it with any static server and open
`/?demo` to use the simulator.

## Where things live

- `public/js/recipe.js`, `production.js` — evaluation and policy logic shared by the browser
  and the server. Changes here need unit tests in `test/`.
- `public/js/channel.js`, `runner.js`, `simulator.js` — protocol, run sequence, simulated board.
  Protocol changes must update the firmware (`examples/arduino`), the simulator and
  `docs/protocol.md` together.
- `public/js/station.js` and the other `*-ui.js` modules — screens. User-visible behaviour
  belongs in an end-to-end test in `e2e/`.
- `server.js`, `lib/`, `db.js` — server, REST API, Socket.io bridge, SQLite.
- `scripts/vendor.js` (`npm run vendor`) — copies Chart.js, Sortable and the fonts into
  `public/vendor/` so installations work offline. Run it after updating those packages.

## Database changes

Never edit an existing migration. Add a new entry to `MIGRATIONS` in `db.js`, bump
`LATEST_VERSION`, and add a test that opens a database of the previous version and checks
the data survives. A migration runs in a transaction; it must work on a database with data.

## Pull requests

- One topic per pull request, with tests for the behaviour it changes.
- `npm run lint`, `npm test` and `npm run test:e2e` pass locally; CI also compiles the firmware.
- Commit messages in English, imperative, with a type prefix: `fix: …`, `feat: …`, `docs: …`,
  `test: …`, `refactor: …`, `chore: …`.
- UI text is Turkish; code, comments and docs under `docs/` are English.

## Safety-related changes

Anything that touches the teardown, critical steps, the watchdog, the safety state or the
retest policy must keep the existing tests passing and should add one for the new case. If
the change affects the fixture, update [docs/hardware-checklist.md](docs/hardware-checklist.md).
