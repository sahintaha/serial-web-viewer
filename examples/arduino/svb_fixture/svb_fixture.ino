// SVB-100 test firmware — implements docs/protocol.md so the board can be
// tested by the Serial Web Viewer production station.
//
// Wiring (Arduino Uno / Nano):
//   D7  → MOSFET / relay that switches the supply of the load under test
//   D13 → green status LED (on-board LED works for a bench test)
//   A0  → supply voltage through a 1:1 divider (2 × 10 kΩ)   → 0–10 V
//   A1  → INA169 current sense output, 1 kΩ load (1 V = 1 A)
//   A2  → sensor output used by SELFTEST (expected 0.5–4.5 V)
//   A3, A4 → optional sensors for the telemetry stream
//
// Every command gets exactly one reply that starts with "@".
// Telemetry lines (STREAM ON) have no "@", so the station never confuses them.

#include <EEPROM.h>

const char MODEL[] = "SVB-100";
const char FIRMWARE[] = "1.4.2";

const int PIN_SUPPLY = 7;
const int PIN_LED = 13;
const int PIN_VSENSE = A0;
const int PIN_ISENSE = A1;
const int PIN_SENSOR = A2;

const int SERIAL_ADDR = 0;     // EEPROM: up to 40 characters + terminator
const int SERIAL_MAX = 40;

bool powered = false;
bool streaming = true;
unsigned long lastStream = 0;
char serialNumber[SERIAL_MAX + 1] = "-";
String line;

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

void saveSerial(const String &sn) {
  int n = min((int)sn.length(), SERIAL_MAX);
  for (int i = 0; i < n; i++) EEPROM.update(SERIAL_ADDR + i, sn[i]);
  EEPROM.update(SERIAL_ADDR + n, 0);
  sn.toCharArray(serialNumber, SERIAL_MAX + 1);
}

void setSupply(bool on) {
  powered = on;
  digitalWrite(PIN_SUPPLY, on ? HIGH : LOW);
  if (!on) digitalWrite(PIN_LED, LOW);
}

void reply(const char *body) {
  Serial.print('@');
  Serial.println(body);
}

void handle(String cmd) {
  cmd.trim();
  String upper = cmd;
  upper.toUpperCase();

  if (upper.startsWith("SN ")) {
    String sn = cmd.substring(3);
    sn.trim();
    sn.toUpperCase();
    if (sn.length() == 0 || sn.length() > SERIAL_MAX) return reply("ERR BAD_ARG");
    if (sn != String(serialNumber)) setSupply(false);
    saveSerial(sn);
    return reply("OK");
  }
  if (upper == "SN?") {
    Serial.print("@SN ");
    Serial.println(serialNumber);
    return;
  }
  if (upper == "ID?") {
    Serial.print("@ID ");
    Serial.print(MODEL);
    Serial.print(" FW");
    Serial.println(FIRMWARE);
    return;
  }
  if (upper == "PWR ON") {
    setSupply(true);
    return reply("OK");
  }
  if (upper == "PWR OFF") {
    setSupply(false);
    return reply("OK");
  }
  if (upper == "MEAS?") {
    if (!powered) return reply("ERR NOT_POWERED");
    float v = volts(PIN_VSENSE) * 2.0;           // 1:1 divider
    float mA = volts(PIN_ISENSE) * 1000.0;        // INA169: 1 V = 1 A
    Serial.print("@V");
    Serial.print(v, 3);
    Serial.print(",I");
    Serial.println(mA, 1);
    return;
  }
  if (upper == "SELFTEST") {
    if (!powered) return reply("ERR NOT_POWERED");
    float s = volts(PIN_SENSOR);
    return reply(s > 0.5 && s < 4.5 ? "OK" : "ERR SENSOR_FAULT");
  }
  if (upper == "LED ON") {
    if (!powered) return reply("ERR NOT_POWERED");
    digitalWrite(PIN_LED, HIGH);
    return reply("OK");
  }
  if (upper == "LED OFF") {
    digitalWrite(PIN_LED, LOW);
    return reply("OK");
  }
  if (upper == "STREAM ON") {
    streaming = true;
    return reply("OK");
  }
  if (upper == "STREAM OFF") {
    streaming = false;
    return reply("OK");
  }
  reply("ERR UNKNOWN_CMD");
}

void stream() {
  // Telemetry for the monitor view: A temp (°C, LM35 on A3), B humidity %, C pressure kPa, D light %
  float temperature = analogRead(A3) * 0.48828125;
  int humidity = map(analogRead(A4), 0, 1023, 0, 100);
  Serial.print("A");
  Serial.print(temperature, 1);
  Serial.print(",B");
  Serial.print(humidity);
  Serial.print(",C101.30,D");
  Serial.println(map(analogRead(PIN_SENSOR), 0, 1023, 0, 100));
}

void setup() {
  pinMode(PIN_SUPPLY, OUTPUT);
  pinMode(PIN_LED, OUTPUT);
  setSupply(false);
  loadSerial();
  Serial.begin(115200);
}

void loop() {
  // Non-blocking line reader; overly long lines are dropped
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      if (line.length()) handle(line);
      line = "";
    } else if (c != '\r') {
      if (line.length() < 80) line += c;
    }
  }

  if (streaming && millis() - lastStream >= 1000) {
    lastStream = millis();
    stream();
  }
}
