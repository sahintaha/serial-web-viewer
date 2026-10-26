// SVB-100 test firmware — implements docs/protocol.md (protocol v2) so the board
// can be tested by the PCBA Test Station.
//
// Wiring (Arduino Uno / Nano):
//   D7  → MOSFET / relay that switches the supply of the load under test
//   D13 → green status LED (on-board LED works for a bench test)
//   A0  → supply voltage through a 1:1 divider (2 × 10 kΩ)   → 0–10 V
//   A1  → INA169 current sense output, 1 kΩ load (1 V = 1 A)
//   A2  → sensor output used by SELFTEST (expected 0.5–4.5 V)
//   A3, A4 → optional sensors for the telemetry stream
//
// Protocol summary:
//   "#00A1 MEAS?"  → "@#00A1 V5.012,I118.3"   (numbered, used by the station)
//   "MEAS?"        → "@V5.012,I118.3"          (unnumbered, for manual use)
//   A numbered command whose id was seen recently is NOT executed again: the cached
//   reply is replayed (idempotent retry). Same id with a different command → ERR ID_REUSED.
//   Supply watchdog: while powered, if no command arrives for WDT ms (default 3000),
//   the supply and LED are switched off. Any command (PING included) feeds it.

#include <EEPROM.h>

const char MODEL[] = "SVB-100";
const char FIRMWARE[] = "1.4.2";

const int PIN_SUPPLY = 7;
const int PIN_LED = 13;
const int PIN_VSENSE = A0;
const int PIN_ISENSE = A1;
const int PIN_SENSOR = A2;

// STATUS? reports the supply as MEASURED on A0, not the pin state: a welded relay or a
// shorted MOSFET then shows up as PWR=1 even after PWR OFF. Check the threshold on your fixture.
const float SUPPLY_PRESENT_V = 0.5;

const int SERIAL_ADDR = 0;     // EEPROM: up to 40 characters + terminator
const int SERIAL_MAX = 40;
const int LINE_MAX = 80;
const int REPLY_MAX = 48;
const int CACHE_SIZE = 4;      // RAM is tight on an Uno; the station never has more than 1 request in flight

struct CachedReply {
  char id[9];
  uint16_t commandHash;
  char reply[REPLY_MAX];
};

CachedReply cache[CACHE_SIZE];
int cacheNext = 0;

bool powered = false;
bool ledOn = false;
bool streaming = true;
bool watchdogTripped = false;
unsigned long watchdogMs = 3000;
unsigned long lastCommand = 0;
unsigned long lastStream = 0;
char serialNumber[SERIAL_MAX + 1] = "-";
char line[LINE_MAX + 1];
int lineLength = 0;
bool lineOverflow = false;

uint16_t hash16(const char *s) {
  uint16_t h = 0xFFFF;
  while (*s) {
    h ^= (uint8_t)*s++;
    for (int i = 0; i < 8; i++) h = (h & 1) ? (h >> 1) ^ 0xA001 : h >> 1;
  }
  return h;
}

float volts(int pin) {
  return analogRead(pin) * (5.0 / 1023.0);
}

void loadSerial() {
  for (int i = 0; i < SERIAL_MAX; i++) {
    char c = EEPROM.read(SERIAL_ADDR + i);
    if (c == 0 || c == (char)0xFF) {
      serialNumber[i] = 0;
      break;
    }
    serialNumber[i] = c;
  }
  serialNumber[SERIAL_MAX] = 0;
  if (serialNumber[0] == 0) strcpy(serialNumber, "-");
}

void saveSerial(const char *sn) {
  int n = strlen(sn);
  for (int i = 0; i < n; i++) EEPROM.update(SERIAL_ADDR + i, sn[i]);
  EEPROM.update(SERIAL_ADDR + n, 0);
  strcpy(serialNumber, sn);
}

void setSupply(bool on) {
  powered = on;
  digitalWrite(PIN_SUPPLY, on ? HIGH : LOW);
  if (!on) {
    ledOn = false;
    digitalWrite(PIN_LED, LOW);
  }
}

void upperCase(char *s) {
  for (; *s; s++) *s = toupper(*s);
}

// Executes one command; writes the reply body into `out`.
void execute(char *cmd, char *out) {
  char upper[LINE_MAX + 1];
  strncpy(upper, cmd, LINE_MAX);
  upper[LINE_MAX] = 0;
  upperCase(upper);

  if (strncmp(upper, "SN ", 3) == 0) {
    char *sn = upper + 3;
    while (*sn == ' ') sn++;
    int n = strlen(sn);
    if (n == 0 || n > SERIAL_MAX) { strcpy(out, "ERR BAD_ARG"); return; }
    if (strcmp(sn, serialNumber) != 0) setSupply(false);
    saveSerial(sn);
    strcpy(out, "OK");
    return;
  }
  if (strncmp(upper, "WDT ", 4) == 0) {
    long ms = atol(upper + 4);
    if (ms < 0 || ms > 60000) { strcpy(out, "ERR BAD_ARG"); return; }
    watchdogMs = ms;
    strcpy(out, "OK");
    return;
  }
  if (strcmp(upper, "PING") == 0) { strcpy(out, "OK"); return; }
  if (strcmp(upper, "SN?") == 0) { snprintf(out, REPLY_MAX, "SN %s", serialNumber); return; }
  if (strcmp(upper, "ID?") == 0) { snprintf(out, REPLY_MAX, "ID %s FW%s", MODEL, FIRMWARE); return; }
  if (strcmp(upper, "STATUS?") == 0) {
    bool supplyPresent = volts(PIN_VSENSE) * 2.0 > SUPPLY_PRESENT_V;  // 1:1 divider
    snprintf(out, REPLY_MAX, "PWR=%d LED=%d WDT=%d", supplyPresent ? 1 : 0, ledOn ? 1 : 0, watchdogTripped ? 1 : 0);
    return;
  }
  if (strcmp(upper, "PWR ON") == 0) {
    setSupply(true);
    watchdogTripped = false;
    strcpy(out, "OK");
    return;
  }
  if (strcmp(upper, "PWR OFF") == 0) { setSupply(false); strcpy(out, "OK"); return; }
  if (strcmp(upper, "MEAS?") == 0) {
    if (!powered) { strcpy(out, "ERR NOT_POWERED"); return; }
    char v[12], i[12];
    dtostrf(volts(PIN_VSENSE) * 2.0, 1, 3, v);       // 1:1 divider
    dtostrf(volts(PIN_ISENSE) * 1000.0, 1, 1, i);    // INA169: 1 V = 1 A → mA
    snprintf(out, REPLY_MAX, "V%s,I%s", v, i);
    return;
  }
  if (strcmp(upper, "SELFTEST") == 0) {
    if (!powered) { strcpy(out, "ERR NOT_POWERED"); return; }
    float s = volts(PIN_SENSOR);
    strcpy(out, s > 0.5 && s < 4.5 ? "OK" : "ERR SENSOR_FAULT");
    return;
  }
  if (strcmp(upper, "LED ON") == 0) {
    if (!powered) { strcpy(out, "ERR NOT_POWERED"); return; }
    ledOn = true;
    digitalWrite(PIN_LED, HIGH);
    strcpy(out, "OK");
    return;
  }
  if (strcmp(upper, "LED OFF") == 0) {
    ledOn = false;
    digitalWrite(PIN_LED, LOW);
    strcpy(out, "OK");
    return;
  }
  if (strcmp(upper, "STREAM ON") == 0) { streaming = true; strcpy(out, "OK"); return; }
  if (strcmp(upper, "STREAM OFF") == 0) { streaming = false; strcpy(out, "OK"); return; }
  strcpy(out, "ERR UNKNOWN_CMD");
}

void handle(char *text) {
  lastCommand = millis();  // every command feeds the watchdog

  // Optional request id: "#<1-8 alphanumerics> <command>"
  char id[9] = "";
  char *cmd = text;
  if (text[0] == '#') {
    char *space = strchr(text, ' ');
    int len = space ? space - text - 1 : 0;
    if (!space || len < 1 || len > 8) {
      Serial.println("@ERR BAD_ID");
      return;
    }
    strncpy(id, text + 1, len);
    id[len] = 0;
    upperCase(id);
    cmd = space + 1;
    while (*cmd == ' ') cmd++;
  }

  if (id[0]) {
    uint16_t h = hash16(cmd);
    for (int k = 0; k < CACHE_SIZE; k++) {
      if (strcmp(cache[k].id, id) == 0) {
        Serial.print("@#");
        Serial.print(id);
        Serial.print(' ');
        Serial.println(cache[k].commandHash == h ? cache[k].reply : "ERR ID_REUSED");
        return;
      }
    }
  }

  char reply[REPLY_MAX];
  execute(cmd, reply);

  if (id[0]) {
    CachedReply &slot = cache[cacheNext];
    strcpy(slot.id, id);
    slot.commandHash = hash16(cmd);
    strncpy(slot.reply, reply, REPLY_MAX - 1);
    slot.reply[REPLY_MAX - 1] = 0;
    cacheNext = (cacheNext + 1) % CACHE_SIZE;
    Serial.print("@#");
    Serial.print(id);
    Serial.print(' ');
  } else {
    Serial.print('@');
  }
  Serial.println(reply);
}

void stream() {
  // Telemetry for the monitor view (no "@"): A temp (°C, LM35 on A3), B humidity %, C kPa, D light %
  char t[10];
  dtostrf(analogRead(A3) * 0.48828125, 1, 1, t);
  Serial.print("A");
  Serial.print(t);
  Serial.print(",B");
  Serial.print(map(analogRead(A4), 0, 1023, 0, 100));
  Serial.print(",C101.30,D");
  Serial.println(map(analogRead(PIN_SENSOR), 0, 1023, 0, 100));
}

void setup() {
  pinMode(PIN_SUPPLY, OUTPUT);
  pinMode(PIN_LED, OUTPUT);
  setSupply(false);  // safe state at power-up, before anything else
  loadSerial();
  for (int k = 0; k < CACHE_SIZE; k++) cache[k].id[0] = 0;
  Serial.begin(115200);
  lastCommand = millis();
}

void loop() {
  // Non-blocking line reader; an overlong line is discarded entirely, never truncated into a command
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      line[lineLength] = 0;
      if (lineOverflow) Serial.println("@ERR LINE_TOO_LONG");
      else if (lineLength > 0) handle(line);
      lineLength = 0;
      lineOverflow = false;
    } else if (c != '\r') {
      if (lineLength < LINE_MAX) line[lineLength++] = c;
      else lineOverflow = true;
    }
  }

  // Supply watchdog: the station went quiet (crash, closed tab, unplugged cable)
  if (powered && watchdogMs > 0 && millis() - lastCommand > watchdogMs) {
    setSupply(false);
    watchdogTripped = true;
  }

  if (streaming && millis() - lastStream >= 1000) {
    lastStream = millis();
    stream();
  }
}
