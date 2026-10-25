// Streams sensor readings in a format Serial Web Viewer understands
// and reacts to commands sent from the "Veri Gönder" card.
//
// Output (one line per reading):  A<temp>,B<humidity>,C<pot>,D<light>,V<volts>,I<mA>
// V and I match the default limits of the production test view.
// Commands (newline-terminated):  LED:ON  |  LED:OFF  |  RATE:<ms>

const int LED = LED_BUILTIN;
unsigned long intervalMs = 1000;
unsigned long lastSend = 0;
String command;

void setup() {
  Serial.begin(9600);
  pinMode(LED, OUTPUT);
}

void handleCommand(const String &cmd) {
  if (cmd == "LED:ON") {
    digitalWrite(LED, HIGH);
  } else if (cmd == "LED:OFF") {
    digitalWrite(LED, LOW);
  } else if (cmd.startsWith("RATE:")) {
    long ms = cmd.substring(5).toInt();
    if (ms >= 50) intervalMs = ms;
  } else {
    Serial.print("ERR:unknown command ");
    Serial.println(cmd);
    return;
  }
  Serial.print("ACK:");
  Serial.println(cmd);
}

void loop() {
  // Read commands without blocking the sensor loop
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      command.trim();
      if (command.length()) handleCommand(command);
      command = "";
    } else if (command.length() < 64) {
      command += c;
    }
  }

  if (millis() - lastSend >= intervalMs) {
    lastSend = millis();
    float temperature = analogRead(A0) * 0.48828125; // LM35: 10 mV / °C
    int humidity = map(analogRead(A1), 0, 1023, 0, 100);
    int pot = map(analogRead(A2), 0, 1023, 0, 100);
    int light = map(analogRead(A3), 0, 1023, 0, 100);
    // Supply voltage through a 1:2 divider on A4, current from an INA169-style
    // sensor on A5 (1 V = 1 A with a 1 kΩ load resistor)
    float volts = analogRead(A4) * (5.0 / 1023.0) * 2.0;
    float milliamps = analogRead(A5) * (5.0 / 1023.0) * 1000.0;

    Serial.print("A");
    Serial.print(temperature, 1);
    Serial.print(",B");
    Serial.print(humidity);
    Serial.print(",C");
    Serial.print(pot);
    Serial.print(",D");
    Serial.print(light);
    Serial.print(",V");
    Serial.print(volts, 3);
    Serial.print(",I");
    Serial.println(milliamps, 1);
  }
}
