# CoolAir

When the sun heats a building, the AC works harder, and it also gets less efficient as the outdoor temperature rises. CoolAir controls a **window**, an **intake fan**, **blinds** and the **AC** together. When the outside air is cooler than inside (nights, early mornings, cool evenings), it opens the window and runs the intake fan so the AC can stay off. When the sun is strong, it closes the blinds to keep the heat out.

A PSoC 4 (M-series) board sends the real indoor and outdoor temperatures and whether a person is detected. The server decides what each device should do and replies straight away, so the board can light its LED and update its LCD. A dashboard shows everything and lets you override the intake fan, the AC and the blinds.

```
 PSoC 4 board (indoor + outdoor temp sensors, person sensor, LED, LCD)
   │  UART → USB (KitProg) → bridge on the laptop
   │  GET /api/sensor?temp=27.5&outdoorTemp=19.2&person=1
   ▼
 simulator.js  ── serves ──►  dashboard (browser, polls /api/state every second)
 (weather, house, controller)    buttons send GET /api/override, /api/setpoint, /api/sim
```

Everything is plain HTTP with JSON. There's no broker and nothing else to install.

## Run it

Needs Node 18 or newer.

```
npm install
npm start
```

Open **http://localhost:8080**.

With the PSoC plugged in by USB, start the bridge in a second terminal:

```
npm run bridge
```

In VS Code, Terminal → Run Task → **CoolAir: start everything** starts both.

## The USB bridge (`bridge.js`)

The PSoC 4 M-series has no Wi-Fi, so it can't call the server by itself. The dev kit's KitProg chip shows the PSoC's UART as a COM port on the laptop. `bridge.js` reads each line from that port, sends it to `/api/sensor`, and writes the answer back down the same port.

```
PSoC UART ──USB (KitProg)──► bridge.js ──HTTP──► CoolAir server
          ◄── one reply line ──        ◄── JSON ──
```

- It finds the KitProg port by itself. Use `npm run bridge -- --list` to see the ports, or `npm run bridge -- --port COM5` to pick one.
- The default speed is 115200 baud; change it with `--baud 9600`. It must match the PSoC's UART settings: 8 data bits, no parity, 1 stop bit.
- If the board is unplugged, the bridge waits and reconnects. If the server isn't running, the board gets an error line.
- To try it without the board: `npm run bridge -- --stdin`, then type readings.

### What the PSoC sends

One line per reading, ending in `\n`, in any of these forms:

```
{"temp":27.5,"outdoorTemp":19.2,"person":1}
[27.5,1,19.2]
temp=27.5&outdoorTemp=19.2&person=1
```

Once a second is plenty. Every line gets exactly one reply, in the same order. If more than 10 lines are waiting, the oldest are answered with `E,too many readings at once; skipped`.

### What the PSoC gets back

One plain-ASCII line:

```
S,<window>,<intakeFan>,<ac>,<blinds>,<led>,<lcd line 1>,<lcd line 2>
S,1,1,0,0,1,IN 27.5 OUT 19C ,OUTSIDE AIR B0  
```

| Field | Values |
|---|---|
| `window`, `intakeFan`, `ac`, `led` | `0` or `1` |
| `blinds` | `0` (open) to `100` (closed) |
| `lcd line 1`, `lcd line 2` | Exactly 16 characters each, ready to print |

If something goes wrong, the line starts with `E,` followed by a short message, e.g. `E,server offline (is npm start running?)`. Start the bridge with `--reply json` to get the server's full JSON reply instead.

### Sketch of the PSoC side

This is a starting point, not tested on hardware. It assumes a PSoC Creator SCB UART component named `UART`. The temperatures are kept in tenths of a degree, because `printf` with `%f` doesn't work on PSoC unless float formatting is turned on in the build settings.

```c
char out[64], in[80];
int t10 = 275, o10 = 192, person = 1;   /* 27.5 °C, 19.2 °C, someone home */
sprintf(out, "{\"temp\":%d.%d,\"outdoorTemp\":%d.%d,\"person\":%d}\n",
        t10 / 10, t10 % 10, o10 / 10, o10 % 10, person);
UART_UartPutString(out);

/* ...collect characters from UART_UartGetChar() into `in` until '\n'... */
int window, fan, ac, blinds, led;
char lcd1[17], lcd2[17];
if (sscanf(in, "S,%d,%d,%d,%d,%d,%16[^,],%16[^\n]", &window, &fan, &ac, &blinds, &led, lcd1, lcd2) == 7) {
    /* drive the LED pin from led, print lcd1 and lcd2 on the LCD */
}
```

Negative temperatures need a sign handled separately, since `t10 % 10` is negative below zero.

### Or: a Wi-Fi module

An ESP-01 (ESP8266) on the PSoC's UART, driven with AT commands, can send the HTTP request itself. Then the bridge isn't needed. The laptop and the module must be on the same Wi-Fi, and the module uses the laptop's IP address (from `ipconfig`) in place of `localhost`. If Windows asks whether to allow Node.js through the firewall, allow it on private networks.

## Inputs and outputs

| | Name | Type | Who sets it |
|---|---|---|---|
| Input | `temp` | number, °C | Indoor temperature sensor |
| Input | `outdoorTemp` | number, °C | Outdoor temperature sensor |
| Input | `person` | true / false | Person sensor |
| Output | `window` | true / false | Always automatic |
| Output | `intakeFan` | true / false | Automatic, can be overridden |
| Output | `ac` | true / false | Automatic, can be overridden |
| Output | `blinds` | 0 (open) to 100 (closed) | Automatic, can be overridden with a slider |

While the board keeps sending readings, they replace the simulated ones. The sun and humidity are always simulated. If it goes quiet for 30 seconds, the simulation takes over again, and the dashboard shows which source each value came from.

## The API

Every endpoint takes its payload in any of three ways, whichever is easiest for the sender:

1. Query parameters: `/api/sensor?temp=27.5&person=1`
2. A `json` parameter: `/api/sensor?json=%7B%22temp%22%3A27.5%7D`
3. A JSON body, on GET or POST: `{"temp": 27.5, "person": true}`

| Endpoint | Payload | Reply |
|---|---|---|
| `GET /api/sensor` | `{"temp":27.5,"outdoorTemp":19.2,"person":true}`, or an array (see below) | The outputs, for the LED and LCD |
| `GET /api/state` | none | Everything the dashboard shows |
| `GET /api/override` | `{"device":"intakeFan","mode":"on"}`, `{"device":"ac","mode":"auto"}`, `{"device":"blinds","value":60}` | `{"ok":true,"state":{…}}` |
| `GET /api/setpoint` | `{"value":24}` (18–30, rounded to 0.5) | `{"ok":true,"state":{…}}` |
| `GET /api/sim` | `{"scenario":"heatwave"}`, `{"speed":15}`, `{"paused":true}`, `{"person":false}`, `{"reset":true}` | `{"ok":true,"state":{…}}` |

Modes for `intakeFan` and `ac` are `on`, `off` or `auto` (`true`/`false` and `1`/`0` work too). `blinds` takes a `value` from 0 to 100, or `mode: "auto"`. The window can't be overridden.

A bad request gets HTTP 400 and a message explaining what was wrong, for example `{"ok":false,"error":"temperature must be a number between -20 and 60 °C, got \"hot\""}`.

### Sensor arrays

`/api/sensor` accepts a JSON array in any of these shapes. They all mean the same thing:

```json
[{"temp": 27.5}, {"outdoorTemp": 19.2}, {"person": true}]
[{"name": "temp", "value": 27.5}, {"name": "outdoor", "value": 19.2}, {"name": "person", "value": 1}]
[27.5, true, 19.2]
```

In the last form the order is indoor temperature, person, outdoor temperature. Key names are matched loosely: `temp`, `temperature`, `indoorTemp`, `tempC`; `outdoorTemp`, `outdoor`, `outsideTemp`, `outside`, `tempOut`; and `person`, `personDetected`, `presence`, `occupied`, `motion`, `pir`. Upper or lower case doesn't matter.

If any one value is invalid, the whole reading is rejected, so nothing is half-applied.

### What the board gets back

```json
{
  "ok": true,
  "window": true, "intakeFan": true, "ac": false, "blinds": 0,
  "mode": "outside-air", "led": true, "person": true,
  "indoor": 27.5, "outdoor": 18.4, "target": 24,
  "lcd": ["IN 27.5 OUT 18C ", "OUTSIDE AIR B0  "],
  "received": ["temp", "person"]
}
```

- `mode` is `outside-air`, `ac` or `holding`.
- `led` is true while outside air is doing the cooling.
- `lcd` holds two lines of exactly 16 characters, ready to print on a 16×2 LCD.

## How the controller decides

- **Window:** it opens when all four checks pass:
  - outside is at least 2 °C cooler than inside
  - the outdoor dew point is 17 °C or lower (not muggy)
  - outside is at least 12 °C
  - the house needs cooling

  It closes again once the gap shrinks to 0.5 °C.
- **Intake fan:** in auto, it runs exactly when the window is open, since its job is pulling outside air in.
- **AC:** a thermostat (target ± 0.5 °C). In auto it stays off while the window is open.
- **Pre-cooling:** overnight (20:00 to 10:00) it uses outside air to cool the house 3 °C below the target, so the building starts the sunny afternoon cooler.
- **Person:** with nobody detected, the AC target is relaxed by 3 °C to save energy.
- **Blinds:** in strong sun, when the house is warm, they close in steps of 10 %. They're fully closed at 700 W/m², capped at 80 % when someone is home so there's still daylight, and open at night. Closed blinds keep out 70 % of the sun's heat.
- **Overrides always win.**

## Tests

```
npm test
```

This takes under 2 minutes. Each test starts its own server on a spare port, so a server that's already running isn't disturbed.

- **`test/sim.test.js`** covers:
  - every sensor payload shape
  - bad and oversized payloads
  - the sensor timeout falling back to the simulation
  - person detection, every override, the safety notes, auto blinds
  - setpoint and sim limits
  - two simulated days in each weather type
  - 600 random requests, and 2000 requests at once
- **`test/bridge.test.js`** covers the USB bridge: every line format, replies in order, bad lines, a flood of lines, the server being offline, and the `--stdin` mode. The real serial port can only be tested with the board plugged in.
- **`test/dashboard.test.js`** loads the dashboard in a fake browser and checks every banner state, the cards, buttons and slider, error messages, the event log and the chart.

## About the model

The model and its constants (`HOUSE`, `CTRL`, `SCENARIOS` at the top of `simulator.js`) are rough single-zone estimates for a demo, not measured data. Before you wire up real fans, window motors, blinds or AC relays, have the mains wiring and fail-safes reviewed by a qualified person.
