# Real-hardware checklist

The automated tests (unit, integration and Playwright end-to-end) run the station against
a simulated board and a mock serial port. They prove the software's behaviour, not the
fixture's. Before a station is used in production, and after every change to the fixture,
the firmware or the safety-related parts of a recipe, go through this list on the real
fixture and file the result with the station's calibration record.

Tools: the fixture with the [`svb_fixture`](../examples/arduino/svb_fixture/svb_fixture.ino)
firmware (or your own implementation of [protocol v2](protocol.md)), a known-good board,
a multimeter or scope on the DUT supply, a stopwatch (or scope timing).

## 1. Power-up and serial link

| # | Check | Expected |
|---|---|---|
| 1.1 | Power the fixture with a board inserted, without opening the station | DUT supply stays **off** (power-up default) |
| 1.2 | Connect (Tarayıcı or Sunucu mode, 115200 8N1), send `STATUS?` from the monitor | `@PWR=0 LED=0 WDT=0` |
| 1.3 | Send `#0001 PING`, then `#0001 PING` again | Both answered `@#0001 OK`; the second is a replay |
| 1.4 | Send `#0001 PWR ON` (same id, different command) | `@#0001 ERR ID_REUSED`, supply stays off |
| 1.5 | Send a line longer than 80 characters | `@ERR LINE_TOO_LONG`, nothing switched |

## 2. Supply switching is measured, not assumed

| # | Check | Expected |
|---|---|---|
| 2.1 | `PWR ON`, measure the DUT supply, then `STATUS?` | Supply present on the meter, `PWR=1` |
| 2.2 | `PWR OFF`, measure, then `STATUS?` | Supply gone (below the `SUPPLY_PRESENT_V` threshold) on the meter, `PWR=0` |
| 2.3 | Simulate a stuck switch: bridge the relay contacts / MOSFET (or feed A0 from a bench supply) and run a full test | Test verdict as usual, safety **UNSAFE** ("besleme kapanmadı"), next test blocked until the operator acknowledges |
| 2.4 | Check the A0 divider ratio and `SUPPLY_PRESENT_V` against the lowest supply that is still hazardous for your DUT | Threshold is below that level with margin |

## 3. Watchdog: the board protects itself without the station

| # | Check | Expected |
|---|---|---|
| 3.1 | `PWR ON`, then send nothing | Supply off after `WDT` (default 3 s) ± 100 ms; `STATUS?` → `WDT=1` |
| 3.2 | Start a test, wait at the LED question for 30 s | Supply stays on (heartbeat `PING` every ~1 s visible in the log) |
| 3.3 | Start a test, close the browser tab at the LED question | Supply off within `WDT` + 1 s |
| 3.4 | Start a test, kill the browser process (Task Manager / `kill -9`) during the measurement | Supply off within `WDT` + 1 s |
| 3.5 | Start a test, unplug the USB cable during the measurement | Supply off within `WDT` + 1 s; the station shows ERROR, safety **UNVERIFIED**, and blocks the next test until acknowledged |
| 3.6 | Sunucu mode: stop the server (`Ctrl+C` / `docker compose stop`) during a test | Supply off within `WDT` + 1 s |
| 3.7 | Power-cycle the fixture during a test | Supply off after the restart (1.1) |

## 4. Teardown and safe state in the station

| # | Check | Expected |
|---|---|---|
| 4.1 | Run a good board | PASS, "Kart güvenli durumda: besleme kapalı (doğrulandı)", supply off on the meter |
| 4.2 | Run a board that fails the measurement | FAIL, teardown steps run, safety SAFE, supply off |
| 4.3 | Press "Testi durdur" during the measurement | ERROR "durduruldu", teardown runs, safety SAFE, supply off |
| 4.4 | Answer "Hayır" at the LED question | FAIL, supply off |

## 5. Ports, tabs and stations

| # | Check | Expected |
|---|---|---|
| 5.1 | Sunucu mode: open the station in two tabs, start a test in one, try "Gönder" and "Bağlantıyı kes" in the other | Both refused with "kilitli"; the test is not disturbed |
| 5.2 | Enable "Düzenli aralıkla gönder" in the monitor, then start a test | Periodic sending stops when the test starts |
| 5.3 | Scan the same barcode twice quickly | Exactly one test runs |
| 5.4 | Two stations, same serial number at the same moment | One starts, the other gets "başka bir istasyonda test ediliyor" |
| 5.5 | Unplug and re-plug the USB cable while idle | Status "Bağlı değil"; connecting again works without reloading |

## 6. Traceability

| # | Check | Expected |
|---|---|---|
| 6.1 | Open a result in Geçmiş | Station, fixture, calibration id and due date, app version, DUT firmware and the logged-in user are filled in |
| 6.2 | Set `CALIBRATION_DUE` to yesterday, restart, try a real-board test | Refused ("kalibrasyonunun süresi dolmuş"); simulator tests still work |
| 6.3 | Print a result ("Yazdır / PDF") | One-page report with result, measurements, steps, station data |

## What the software cannot verify

- The station records what the fixture **reports**. Recomputing the verdict on the server
  protects against a tampered or buggy browser, not against a fixture that measures the wrong
  thing (wrong divider, wrong probe, swapped channels). Section 2 and the calibration record
  cover that.
- Whether the operator really looked at the LED. The confirm step records the answer and who
  gave it, not the observation.
- In browser-only mode (GitHub Pages, no server) every guarantee about retests and attempts is
  per browser: another browser or a cleared profile has its own history.
