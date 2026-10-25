# Test fixture line protocol (v2)

The production test station talks to the device under test (DUT) over a serial
line. The same protocol is implemented by:

- `examples/arduino/svb_fixture/svb_fixture.ino` (real hardware, compiled in CI),
- `public/js/simulator.js` (the browser's simulator mode),
- `public/js/channel.js` (station side: ids, queue, lock, heartbeat),
- the tests in `test/channel.test.mjs` and `test/runner.test.mjs`.

## Framing

- ASCII, one message per line, terminated by `\n` (`\r\n` is accepted). Lines longer
  than 80 characters are rejected as a whole (`@ERR LINE_TOO_LONG`), never truncated.
- Commands are case-insensitive; arguments are not (serial numbers are upper-cased by the station).
- Every command gets **exactly one reply line** and every reply line starts with `@`.
- Anything else the device prints (telemetry, debug output) has no `@` prefix.

## Request ids (v2)

The station prefixes each command with `#` and an id of 1–8 letters / digits; the reply
repeats it:

```
→ #00A1 MEAS?
← @#00A1 V5.012,I118.3
```

- The station accepts a reply **only** if its id belongs to the request in flight. A late
  reply to an earlier, timed-out command (`@#00A0 OK`), a duplicate, or an unnumbered reply
  (`@OK`, e.g. from a command typed in the monitor) can never satisfy another request.
- The station sends one request at a time per port (`CommandChannel` queue).
- **Idempotent retries.** A retry after a timeout reuses the same id. The device keeps
  the last few `(id, command) → reply` pairs (simulator 8, Arduino 4) and *replays* the cached
  reply instead of executing the command again. So a lost reply to `PWR ON` cannot switch
  the supply twice, and a lost reply to `SN …` cannot count as a second attempt.
  The same id with a different command → `@#<id> ERR ID_REUSED`.
- Commands without an id are still accepted and answered without an id (`MEAS?` →
  `@V5.012,I118.3`), for manual use from the monitor.

### Legacy firmware (v1)

Firmware that does not understand ids can be tested by setting `"protocol": "v1"` on the
product. This is never assumed silently. In v1 the station sends plain commands, accepts
the first `@` reply, and after a timeout discards replies for a guard window (`300 ms`) before
sending the next command. This narrows, but cannot close, the window in which a late reply is
taken for the next command's reply; heartbeats are not available. Use v2 for production.

## Replies

| Reply | Meaning |
|---|---|
| `@#id OK` | Command executed |
| `@#id ERR <CODE>` | Refused / failed; the step fails with the code as reason |
| `@#id <data>` | Command-specific data, e.g. `ID SVB-100 FW1.4.2`, `V5.012,I118.3` |

Measurement replies use the monitor's field syntax (`KEY<number>` pairs separated by commas),
so recipe limits refer to those keys.

## Commands

| Command | Reply | Side effect / notes |
|---|---|---|
| `PING` | `OK` | Feeds the watchdog. Sent by the station when the line is idle (heartbeat). |
| `SN <serial>` | `OK` | Stores the serial (EEPROM). A new serial switches the supply off. |
| `SN?` | `SN <serial>` | |
| `ID?` | `ID <model> FW<version>` | Recipes check it with a glob, e.g. `ID SVB-100 FW1.4.*` |
| `PWR ON` / `PWR OFF` | `OK` | Switches the DUT supply. `PWR OFF` also turns the LED off. Idempotent. |
| `STATUS?` | `PWR=<0/1> LED=<0/1> WDT=<0/1>` | `WDT=1`: the watchdog switched the supply off since the last `PWR ON` |
| `WDT <ms>` | `OK` | Watchdog timeout, `0`–`60000` (default 3000; `0` disables it — bench use only) |
| `MEAS?` | `V<volts>,I<milliamps>[,T<°C>]` | `ERR NOT_POWERED` when the supply is off |
| `SELFTEST` | `OK` / `ERR SENSOR_FAULT` | `ERR NOT_POWERED` when the supply is off |
| `LED ON` / `LED OFF` | `OK` | The acknowledgement says nothing about whether the LED actually lit; that is why the recipe asks the operator. |
| `STREAM ON` / `STREAM OFF` | `OK` | Periodic telemetry `A<temp>,B<hum>,C<kPa>,D<light>` (no `@`) |
| anything else | `ERR UNKNOWN_CMD` | |

All commands are idempotent when retried with the same id (replay). Without an id, `SN`
increments the board's attempt counter again and `PWR ON` re-arms the watchdog.

## Safe state

The supply is the hazard. It is switched off in four independent ways:

1. **Teardown** — the recipe's teardown steps run after every outcome (PASS, FAIL, cancel,
   lost connection, unexpected exception). Steps marked `"critical": true` (`PWR OFF`,
   `STATUS?` expecting `PWR=0 *`) are retried at least twice; a failing non-critical step
   (e.g. `LED OFF`) never prevents them.
2. **Watchdog** — while powered, the firmware switches the supply off if no command arrives
   for `WDT` ms. During a test the station sends `PING` whenever the line has been idle for
   `heartbeatMs` (product setting, default 1000 ms), so long operator questions do not trip it.
   If the browser tab closes, crashes or the cable is pulled, the heartbeat stops and the
   board switches itself off. No JavaScript cleanup is relied upon.
3. **Power-up default** — `setup()` switches the supply off before anything else.
4. **Best effort on page close** — the station sends `PWR OFF` on `pagehide` (not relied upon).

The station records two separate things:

- the **verdict** on the board (PASS / FAIL / ERROR), from the main steps;
- the **safety state**: `SAFE` (all critical teardown steps passed), `UNSAFE` (a critical step
  got a wrong reply — e.g. `STATUS?` still reports `PWR=1`), `UNVERIFIED` (no reply / could not
  be sent) or `NOT_CHECKED` (no critical steps). The UI never shows a plain "done" when the
  state is not `SAFE`.

What must be verified on real hardware is listed in [hardware-checklist.md](hardware-checklist.md).

## Recipes

A product recipe (see *Products and recipes* in the app) is a list of steps:

| Step | What the station does | PASS when |
|---|---|---|
| `command` | send `send`, wait up to `timeoutMs`, retry up to `retries` times (same id) | the reply matches the `expect` glob (`*` any text, `?` one character) |
| `measure` | send `send` `samples` times, `intervalMs` apart | each limit key has exactly `samples` finite values and the value chosen by `evaluate` is within `[min, max]` (inclusive) |
| `delay` | wait `ms` (settling time) | always |
| `confirm` | optionally send a command, then ask the operator a yes/no question | the operator answers yes |

`{serial}` in a command is replaced by the scanned serial number. A `command` step may set
`"capture": "firmware"` to store its reply with the result (e.g. the DUT firmware version).

`evaluate` (measure steps, part of the recipe revision and stored with every result):

| Value | Checked against the limits |
|---|---|
| `mean` (default) | the mean of the samples |
| `min` / `max` | the smallest / largest sample |
| `all` | every sample; the reported value is the sample furthest outside |

A value that is not a finite number (`NaN`, `Infinity`, `1e999`, text) makes the measurement
`INVALID` and the step ERROR; more replies than `samples` are rejected. Neither can PASS.

Step outcomes:

- **FAIL**: the board is bad (wrong reply, `@ERR …`, value out of limits, operator said no).
- **ERROR**: the test could not be completed (no reply after all retries, missing or invalid
  samples, cancelled, connection lost, heartbeat lost). An ERROR does not count towards the
  product's FAIL limit.
- **SKIPPED**: not executed because an earlier step failed (`stopOnFail`, the default).

## Known limitations

- One device per station. Parallel testing of several boards needs one station per port.
- The reply cache is small (4 entries on the Uno). The station has one request in flight and
  retries immediately, so this is enough for retries, but ids must not be reused across sessions
  within 4 commands (the station's ids are random-start counters).
