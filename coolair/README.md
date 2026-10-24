# CoolAir

When the sun heats a building, the AC works harder, and it also gets less efficient as the outdoor temperature rises. CoolAir simulates an outside-air fan and an openable window. Whenever the outside air is cooler than the inside air (nights, early mornings, cool evenings), they bring that air in, so the AC runs less. A dashboard shows what's happening and lets you override any decision, for example "keep the window closed".

```
 dashboard.html  ──ws:9001──┐                 ┌──1883── simulator.js
 (browser)                  ├── Mosquitto ────┤         (house + sun + AC + fan/window
 future ESP32 / sensors ────┘   (Docker)      │          physics, auto controller)
                                              └──1883── anything else (mosquitto_sub, Node-RED…)
```

All requests go through MQTT topics on the broker. No component calls another one directly.

## Run it

Needs Docker Desktop and Node 18+.

```
npm install
npm run broker      # starts Mosquitto in Docker (ports 1883 + 9001)
npm start           # starts the simulator, serves the dashboard
```

Open **http://localhost:8080**. You can also open `dashboard.html` directly, since it connects to `ws://localhost:9001`.

Stop the broker with `npm run broker:stop`.

## MQTT topics

| Topic | Direction | Payload |
|---|---|---|
| `coolair/telemetry` | sim → all (retained, 1/s) | full state: temps, sun, humidity, window/fan/AC, reason, decision checks, heat flows |
| `coolair/history` | sim → all (retained) | last 24 sim hours at 5-min resolution, for the chart |
| `coolair/overrides` | sim → all (retained) | current overrides |
| `coolair/events` | sim → all | `{"sim":"07:15","msg":"Window OPENED"}` |
| `coolair/status` | sim → all (retained, LWT) | `online` / `offline` |
| `coolair/cmd/override` | any → sim | `{"device":"window","mode":"closed","hours":4}` |
| `coolair/cmd/setpoint` | any → sim | `{"value":24}` |
| `coolair/cmd/sim` | any → sim | `{"scenario":"heatwave|mild|cool|muggy","speed":15,"paused":false,"reset":true}` |

Override modes: window `auto|open|closed`; fan and AC `auto|on|off`. Leave out `hours`, or set it to 0, and the override stays until you clear it.

Try it from a terminal (the Mosquitto container includes the CLI tools):

```
docker exec coolair-mosquitto mosquitto_sub -t "coolair/events" -v
docker exec coolair-mosquitto mosquitto_pub -t coolair/cmd/override -m "{\"device\":\"window\",\"mode\":\"closed\"}"
```

## How the auto controller decides

- **Free cooling:** it opens the window and runs the fan when outside is at least 2 °C cooler than inside, the outdoor dew point is 17 °C or lower (dew point rather than %RH, because cool night air always reads high %RH), and outside is at least 12 °C. It stops once the gap shrinks to 0.5 °C. Fan speed scales with the temperature gap and how far the room is above target.
- **Pre-cooling:** overnight (20:00 to 10:00) it uses outside air to cool the house 3 °C below the setpoint, so the building's thermal mass holds that coolness into the sunny part of the day.
- **Sun and heat:** when outside is warmer, the window stays shut to keep the heat out, and the AC holds the setpoint (±0.5 °C).
- **AC lockout:** in auto, the AC never runs while the window is open. If you force both, the dashboard shows a warning.
- **Overrides always win.** "Keep closed" on the window also stops the fan, because the fan only pulls in outside air.

## About the model

The model and its constants (`HOUSE`, `CTRL`, `SCENARIOS` at the top of `simulator.js`) are rough single-zone estimates for a demo, not measured data.

## Later: real hardware

An ESP32 or other device can join the same broker on port 1883. It would publish real sensor readings and subscribe to device commands. The dashboard doesn't need to change. Before you wire up real fans, window actuators, or AC relays, have the mains wiring and fail-safes reviewed by a qualified person.
