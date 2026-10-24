/*
  CoolAir simulator
  -----------------------------------------------------------------
  Simulates one room/house over a sped-up day:
    - outdoor temperature, humidity and sun follow a daily curve
    - sun on the building heats it up and makes the AC work harder
    - an outside-air fan + window can bring in cool outdoor air ("free cooling")
    - the AC runs on a thermostat; its efficiency drops as it gets hotter outside

  Everything goes through the MQTT broker (Mosquitto):
    publishes  coolair/telemetry   full state every tick (retained)
               coolair/history     recent points for the chart (retained)
               coolair/overrides   current overrides (retained)
               coolair/events      log lines
    subscribes coolair/cmd/override  {"device":"window|fan|ac","mode":"auto|open|closed|on|off","hours":4}
               coolair/cmd/setpoint  {"value":24}
               coolair/cmd/sim       {"scenario":"heatwave|mild|cool|muggy","speed":5,"reset":true,"paused":false}

  It also serves dashboard.html on http://localhost:8080 for convenience.
*/
const http = require("http");
const fs = require("fs");
const path = require("path");
const mqtt = require("mqtt");

const BROKER_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const HTTP_PORT = Number(process.env.PORT || 8080);
const T = "coolair/";

// ---------------- scenarios: daily outdoor weather ----------------
const SCENARIOS = {
  heatwave: { label: "Heatwave",      min: 22, max: 39, sunPeak: 950, humMin: 25, humMax: 55 },
  mild:     { label: "Mild summer",   min: 16, max: 31, sunPeak: 850, humMin: 35, humMax: 75 },
  cool:     { label: "Cool nights",   min: 12, max: 28, sunPeak: 800, humMin: 40, humMax: 85 },
  muggy:    { label: "Muggy & humid", min: 23, max: 33, sunPeak: 700, humMin: 55, humMax: 92 },
};

// ---------------- building + equipment model ----------------
const HOUSE = {
  capacity: 3.0,        // kWh per °C  (thermal mass of air + furniture + walls)
  envelopeUA: 0.22,     // kW per °C   (heat leaking through walls/roof)
  solarGain: 0.0028,    // kW per W/m² (sun through windows + hot roof)
  internalGain: 0.35,   // kW          (people, fridge, electronics)
  windowUA: 0.12,       // kW per °C   extra exchange with the window open, fan off
  fanMaxFlow: 1800,     // m³/h at 100% fan
  fanMaxKw: 0.08,       // electric kW at 100% fan
  acCoolKw: 4.0,        // kW of heat the AC removes
};
const AIR_KW_PER_M3H = 1.2 * 1.005 / 3600; // ρ·cp, kW per (m³/h · °C)

const CTRL = {
  freeCoolDelta: 2.0,   // outdoor must be this many °C cooler than indoor to start
  stopDelta: 0.5,       // stop when the gap closes to this
  maxDewPoint: 17,      // °C, don't pull in muggy air (dew point, not %RH: cool night air always reads high %RH)
  minOutdoor: 12,       // °C, don't over-chill
  precoolStart: 20,     // hours: overnight, bank coolness in the building before the sun hits
  precoolEnd: 10,       //   (window wraps past midnight)
  precoolBelow: 3.0,    // °C below setpoint while pre-cooling
  acBand: 0.5,          // thermostat hysteresis ±°C
};

// ---------------- state ----------------
let scenarioKey = "mild";
let speed = 5;             // sim minutes per real second
let paused = false;
let setpoint = 24;
let simMin = 0;            // minutes since start
const overrides = { window: null, fan: null, ac: null }; // {mode, untilMin|null}

let house, history, lastReason, lastChecks = null, lastHeat = null;
function resetSim() {
  simMin = 6 * 60;          // start at 06:00, just before the sun gets going
  const w = weatherAt(simMin);
  house = { tin: w.tout + 3, window: false, fan: 0, ac: false };
  history = [];
  lastReason = "";
}

function weatherAt(min) {
  const s = SCENARIOS[scenarioKey];
  const h = (min / 60) % 24;
  // coldest ~05:00, hottest ~15:00
  const phase = Math.cos(((h - 15) / 24) * 2 * Math.PI);
  const tout = (s.min + s.max) / 2 + ((s.max - s.min) / 2) * phase;
  const sun = h > 6 && h < 19 ? s.sunPeak * Math.sin((Math.PI * (h - 6)) / 13) : 0;
  const humidity = s.humMax - (s.humMax - s.humMin) * (phase + 1) / 2;
  // dew point (Magnus formula)
  const a = Math.log(humidity / 100) + (17.62 * tout) / (243.12 + tout);
  const dewPoint = (243.12 * a) / (17.62 - a);
  return { hour: h, tout, sun: Math.max(0, sun), humidity, dewPoint };
}

function acCop(tout) { return Math.min(4.5, Math.max(2.0, 3.8 - 0.07 * (tout - 25))); }

// ---------------- the controller ----------------
function overrideMode(dev) {
  const o = overrides[dev];
  if (o && o.untilMin !== null && simMin >= o.untilMin) {
    overrides[dev] = null;
    event(`${dev} override expired, back to auto`);
    publishOverrides();
    return null;
  }
  return o ? o.mode : null;
}

function decide(w) {
  const gap = house.tin - w.tout;
  const precool = w.hour >= CTRL.precoolStart || w.hour < CTRL.precoolEnd;
  const target = precool ? setpoint - CTRL.precoolBelow : setpoint;
  const outsideOk = w.dewPoint <= CTRL.maxDewPoint && w.tout >= CTRL.minOutdoor;
  const wantCool = house.tin > target;

  // Auto: free cooling when it's cool enough outside, hysteresis on the gap.
  let freeCool = house.window
    ? gap > CTRL.stopDelta && outsideOk && house.tin > target - 0.5
    : gap >= CTRL.freeCoolDelta && outsideOk && wantCool;

  let reason;
  if (freeCool) reason = precool ? `Pre-cooling for tomorrow's sun: outside is ${gap.toFixed(1)}°C cooler` : `Free cooling: outside is ${gap.toFixed(1)}°C cooler`;
  else if (w.dewPoint > CTRL.maxDewPoint && gap >= CTRL.freeCoolDelta) reason = `Outside is cooler but too muggy (dew point ${w.dewPoint.toFixed(0)}°C)`;
  else if (gap < CTRL.freeCoolDelta) reason = w.sun > 300 ? `Sun is up and outside is warmer, window shut to keep heat out` : `Outside isn't cool enough, window shut`;
  else reason = `At target, nothing to do`;

  // window
  const wm = overrideMode("window");
  let window = freeCool;
  if (wm === "open") { window = true; reason = "Window forced OPEN by override"; }
  if (wm === "closed") { window = false; if (freeCool) reason = "Free cooling available but window forced CLOSED by override"; }

  // fan: only useful with the window open (it pulls outside air in)
  const fm = overrideMode("fan");
  let fan = 0;
  if (window) {
    const need = Math.min(1, Math.max(0, (house.tin - target + 1) / 3));
    const boost = Math.min(1, Math.max(0, gap / 8));
    fan = Math.max(0.25, Math.min(1, 0.4 * need + 0.6 * boost));
  }
  if (fm === "on") fan = 1;
  if (fm === "off") fan = 0;

  // AC: thermostat, locked out in auto while the window is open
  const am = overrideMode("ac");
  let ac = house.ac;
  if (house.tin > setpoint + CTRL.acBand) ac = true;
  if (house.tin < setpoint - CTRL.acBand) ac = false;
  if (window && am === null) ac = false;
  if (am === "on") ac = true;
  if (am === "off") ac = false;
  if (window && ac) reason += " (warning: AC running with window open)";

  // the inputs behind the window decision, so the dashboard can explain it
  const checks = {
    gap: +gap.toFixed(2), needGap: house.window ? CTRL.stopDelta : CTRL.freeCoolDelta,
    dewPoint: +w.dewPoint.toFixed(1), maxDewPoint: CTRL.maxDewPoint,
    tout: +w.tout.toFixed(2), minOutdoor: CTRL.minOutdoor,
    tin: +house.tin.toFixed(2), target: +target.toFixed(2), precool, freeCool,
  };
  return { window, fan, ac, reason, checks };
}

// ---------------- physics step (1 sim minute) ----------------
function step() {
  const w = weatherAt(simMin);
  const d = decide(w);
  if (d.window !== house.window) event(d.window ? "Window OPENED" : "Window CLOSED");
  if ((d.fan > 0) !== (house.fan > 0)) event(d.fan > 0 ? "Fan ON" : "Fan OFF");
  if (d.ac !== house.ac) event(d.ac ? "AC ON" : "AC OFF");
  const kind = (r) => r.replace(/[\d.]+/g, "#"); // ignore changing numbers when deciding to log
  if (kind(d.reason) !== kind(lastReason) && !d.reason.startsWith("At target")) event(d.reason);
  lastReason = d.reason;
  lastChecks = d.checks;
  Object.assign(house, { window: d.window, fan: d.fan, ac: d.ac });

  const dtH = 1 / 60;
  const gains = HOUSE.solarGain * w.sun + HOUSE.internalGain;
  const cop = acCop(w.tout);

  // our house
  let vent = 0;
  if (house.window) vent = HOUSE.windowUA + AIR_KW_PER_M3H * HOUSE.fanMaxFlow * house.fan;
  const q = (HOUSE.envelopeUA + vent) * (w.tout - house.tin) + gains - (house.ac ? HOUSE.acCoolKw : 0);
  house.tin += (q * dtH) / HOUSE.capacity;
  // where the heat is coming from right now, kW (+ heats the house, − cools it)
  lastHeat = {
    sun: +(HOUSE.solarGain * w.sun).toFixed(2),
    walls: +(HOUSE.envelopeUA * (w.tout - house.tin)).toFixed(2),
    inside: HOUSE.internalGain,
    outsideAir: +(vent * (w.tout - house.tin)).toFixed(2),
    ac: house.ac ? -HOUSE.acCoolKw : 0,
    net: +q.toFixed(2), degPerHour: +(q / HOUSE.capacity).toFixed(2),
  };
  const acKw = house.ac ? HOUSE.acCoolKw / cop : 0;
  const fanKw = HOUSE.fanMaxKw * Math.pow(house.fan, 3) + (house.fan > 0 ? 0.01 : 0);

  simMin++;
  if (simMin % 5 === 0) {
    history.push({ m: simMin, tin: +house.tin.toFixed(2), tout: +w.tout.toFixed(2), sun: Math.round(w.sun), win: house.window ? 1 : 0, ac: house.ac ? 1 : 0, kw: +(acKw + fanKw).toFixed(2) });
    if (history.length > 288) history.shift(); // 24 h at 5-min resolution
  }
  return { w, acKw, fanKw, cop };
}

// ---------------- MQTT ----------------
const client = mqtt.connect(BROKER_URL, {
  clientId: "coolair-sim-" + Math.random().toString(16).slice(2, 8),
  will: { topic: T + "status", payload: "offline", retain: true, qos: 1 },
});
const pub = (topic, obj, retain = false) => client.publish(T + topic, typeof obj === "string" ? obj : JSON.stringify(obj), { retain });

function event(msg) {
  const hh = String(Math.floor((simMin / 60) % 24)).padStart(2, "0");
  const mm = String(simMin % 60).padStart(2, "0");
  const line = { sim: `${hh}:${mm}`, msg };
  console.log(`[${line.sim}] ${msg}`);
  if (client.connected) pub("events", line);
}
function publishOverrides() { pub("overrides", overrides, true); }

client.on("connect", () => {
  console.log(`Connected to MQTT broker at ${BROKER_URL}`);
  pub("status", "online", true);
  client.subscribe(T + "cmd/#", { qos: 1 });
  publishOverrides();
});
client.on("error", (e) => console.error("MQTT error:", e.message));
client.on("offline", () => console.log("MQTT offline, retrying... (is Mosquitto running? npm run broker)"));

client.on("message", (topic, buf) => {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch { return event(`Ignored non-JSON command on ${topic}`); }
  const cmd = topic.slice((T + "cmd/").length);

  if (cmd === "override") {
    const allowed = { window: ["open", "closed"], fan: ["on", "off"], ac: ["on", "off"] };
    if (!(msg.device in allowed)) return event(`Unknown device "${msg.device}"`);
    if (msg.mode === "auto" || msg.mode == null) {
      overrides[msg.device] = null;
      event(`${msg.device} override cleared, back to auto`);
    } else if (allowed[msg.device].includes(msg.mode)) {
      const hours = Number(msg.hours) > 0 ? Number(msg.hours) : null;
      overrides[msg.device] = { mode: msg.mode, untilMin: hours ? simMin + hours * 60 : null };
      event(`Override: ${msg.device} ${msg.mode.toUpperCase()}${hours ? ` for ${hours} h` : " until cleared"}`);
    } else return event(`Bad mode "${msg.mode}" for ${msg.device}`);
    publishOverrides();
  } else if (cmd === "setpoint") {
    const v = Number(msg.value);
    if (v >= 18 && v <= 30) { setpoint = v; event(`Setpoint changed to ${v}°C`); }
  } else if (cmd === "sim") {
    if (msg.scenario in SCENARIOS && msg.scenario !== scenarioKey) { scenarioKey = msg.scenario; msg.reset = true; }
    if (Number(msg.speed) > 0) speed = Math.min(60, Number(msg.speed));
    if (typeof msg.paused === "boolean") paused = msg.paused;
    if (msg.reset) { resetSim(); event(`Simulation reset: ${SCENARIOS[scenarioKey].label}`); pub("history", history, true); }
  }
});

// ---------------- main loop ----------------
resetSim();
setInterval(() => {
  if (!client.connected) return;
  let s;
  for (let i = 0; i < (paused ? 0 : speed); i++) s = step();
  if (!s) { const w = weatherAt(simMin); s = { w, acKw: 0, fanKw: 0, cop: acCop(w.tout) }; }
  const w = weatherAt(simMin);
  pub("telemetry", {
    simMinute: simMin, day: Math.floor(simMin / 1440) + 1, hour: +w.hour.toFixed(3),
    scenario: scenarioKey, scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.label])),
    speed, paused, setpoint,
    outdoor: { temp: +w.tout.toFixed(2), humidity: +w.humidity.toFixed(1), dewPoint: +w.dewPoint.toFixed(1), sun: Math.round(w.sun) },
    indoor: { temp: +house.tin.toFixed(2) },
    window: { open: house.window, override: overrides.window },
    fan: { speed: +house.fan.toFixed(2), override: overrides.fan },
    ac: { on: house.ac, kw: +s.acKw.toFixed(2), cop: +s.cop.toFixed(2), override: overrides.ac },
    reason: lastReason, checks: lastChecks, heat: lastHeat,
  }, true);
  if (simMin % 30 < speed || paused) pub("history", history, true);
}, 1000);

// ---------------- tiny static server for the dashboard ----------------
http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/dashboard.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(path.join(__dirname, "dashboard.html")).pipe(res);
  } else { res.writeHead(404); res.end("not found"); }
}).listen(HTTP_PORT, () => console.log(`Dashboard: http://localhost:${HTTP_PORT}`));
