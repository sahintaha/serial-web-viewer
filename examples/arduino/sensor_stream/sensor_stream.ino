// Streams sensor readings in a format Serial Web Viewer understands
// and reacts to commands sent from the "Veri Gönder" card.
//
// Output (one line per reading):  A<temp>,B<humidity>,C<pot>,D<light>
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

    Serial.print("A");
    Serial.print(temperature, 1);
    Serial.print(",B");
    Serial.print(humidity);
    Serial.print(",C");
    Serial.print(pot);
    Serial.print(",D");
    Serial.println(light);
  }
}
