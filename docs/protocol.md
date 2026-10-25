# Test fixture line protocol

The production test station talks to the device under test (DUT) over a serial
line. The same protocol is implemented by:

- `examples/arduino/svb_fixture/svb_fixture.ino` (real hardware),
- `public/js/simulator.js` (the browser's simulator mode),
- the unit tests in `test/runner.test.mjs`.

## Framing

- ASCII, one message per line, terminated by `\n` (`\r\n` is accepted).
- Commands are case-insensitive; arguments are not (serial numbers are upper-cased by the station).
- Every command gets **exactly one reply line**, and every reply line starts with `@`.
- Anything else the device prints (telemetry, debug output) has no `@` prefix.

The `@` prefix is what lets the station run a test while the device keeps streaming
sensor data: the station only waits for `@` lines, and only for lines that arrive
*after* it sent the command. Lines from before the board was plugged in can never
be counted as a measurement.

Reply forms:

| Reply | Meaning |
|---|---|
| `@OK` | Command executed |
| `@ERR <CODE>` | Command refused or failed; the step fails with the code as reason |
| `@<data>` | Command-specific data, e.g. `@ID SVB-100 FW1.4.2` or `@V5.012,I118.3` |

Measurement replies use the same field syntax as the monitor (`KEY<number>` pairs
separated by commas), so recipe limits refer to those keys.

## Commands

| Command | Reply | Notes |
|---|---|---|
| `SN <serial>` | `@OK` | Stores the serial number on the board. A new serial resets power and LED. |
| `SN?` | `@SN <serial>` | |
| `ID?` | `@ID <model> FW<version>` | Recipes check it with a glob, e.g. `ID SVB-100 FW1.4.*` |
| `PWR ON` / `PWR OFF` | `@OK` | Switches the DUT supply. `PWR OFF` also turns the LED off. |
| `MEAS?` | `@V<volts>,I<milliamps>[,T<°C>]` | `@ERR NOT_POWERED` when the supply is off |
| `SELFTEST` | `@OK` / `@ERR SENSOR_FAULT` | `@ERR NOT_POWERED` when the supply is off |
| `LED ON` / `LED OFF` | `@OK` | The acknowledgement says nothing about whether the LED actually lit; that is why the recipe asks the operator. |
| `STREAM ON` / `STREAM OFF` | `@OK` | Periodic telemetry lines `A<temp>,B<hum>,C<kPa>,D<light>` (no `@`) |
| anything else | `@ERR UNKNOWN_CMD` | |

## How the station uses it

A product recipe (see *Products and recipes* in the app) is a list of steps:

| Step | What the station does | PASS when |
|---|---|---|
| `command` | send `send`, wait up to `timeoutMs`, resend up to `retries` times on timeout | the reply matches the `expect` glob (`*` any text, `?` one character) |
| `measure` | send `send` `samples` times, `intervalMs` apart | each limit key has exactly `samples` finite values and the value chosen by `evaluate` is within `[min, max]` (inclusive) |
| `delay` | wait `ms` (settling time) | always |
| `confirm` | optionally send a command, then ask the operator a yes/no question | the operator answers yes |

`{serial}` in a command is replaced by the scanned serial number.

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
- **ERROR**: the test could not be completed (no reply after all retries, missing samples,
  cancelled, connection lost). An ERROR does not count towards the product's retest limit.
- **SKIPPED**: not executed because an earlier step failed (`stopOnFail`, the default).

`teardown` steps (only `command` and `delay`) always run after the main steps — also after
a failure or a cancel — so the board is switched off before the operator removes it. They
are recorded but do not change the verdict.

## Known limitations

- There is no request id. If a reply arrives after its timeout, the next command could
  take it as its own reply. Keep `timeoutMs` comfortably above the device's worst-case
  response time; a sequence number in the reply would remove this limitation.
- One device per station. Parallel testing of several boards needs one station per port.
