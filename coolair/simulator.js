/*
  CoolAir server + simulator
  -----------------------------------------------------------------
  Simulates one room/house over a sped-up day:
    - outdoor temperature, humidity and sun follow a daily curve
    - sun on the building heats it up; blinds block part of that heat
    - a window + intake fan can bring in cool outdoor air
    - the AC runs on a thermostat; its efficiency drops as it gets hotter outside
  Real readings from the PSoC board (indoor temperature, outdoor temperature,
  person detected) replace the simulated ones while they keep arriving.

  Plain HTTP + JSON, no broker. Every endpoint takes its payload as URL query
  parameters, as ?json=<url-encoded JSON>, or as a JSON body (GET or POST).

    GET /api/state                     everything, for the dashboard
    GET /api/sensor   {"temp":27.5,"outdoorTemp":19.2,"person":true}   (or a JSON array, see readSensor)
                      -> replies with the outputs for the LED/LCD
    GET /api/override {"device":"intakeFan|ac|blinds","mode":"auto|on|off","value":0-100}
    GET /api/setpoint {"value":24}
    GET /api/sim      {"scenario":"heatwave|mild|cool|muggy","speed":5,"paused":false,"reset":true}

  It also serves dashboard.html on http://localhost:8080.
*/
const http = require("http");
const fs = require("fs");
const path = require("path");

const HTTP_PORT = Number(process.env.PORT || 8080);
const SENSOR_TIMEOUT_S = Number(process.env.SENSOR_TIMEOUT_S || 30); // real readings older than this are ignored and the simulation takes over again

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
  solarGain: 0.0028,    // kW per W/m² (sun through windows + hot roof, blinds open)
  blindsBlock: 0.7,     // fully closed blinds keep out 70% of the sun's heat
  internalGain: 0.35,   // kW          (people, fridge, electronics)
  windowUA: 0.12,       // kW per °C   extra exchange with the window open, fan off
  fanFlow: 1800,        // m³/h with the intake fan on
  fanKw: 0.09,          // electric kW with the intake fan on
  acCoolKw: 7.0,        // kW of heat the AC removes (a common "2-ton" home unit)
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
  emptySetback: 3.0,    // with nobody detected, let the AC target drift this much warmer
  blindsFullSun: 700,   // W/m² of sun at which auto blinds close fully
  blindsMaxWithPerson: 80, // leave some daylight when someone is in the room
};

// ---------------- state ----------------
let scenarioKey = "mild";
let speed = 5;             // sim minutes per real second
let paused = false;
let setpoint = 24;
let simMin = 0;            // minutes since start
const overrides = { intakeFan: null, ac: null, blinds: null }; // intakeFan/ac: "on"|"off"; blinds: 0-100
const sensor = { temp: null, tempAt: 0, outdoor: null, outdoorAt: 0, person: null, personAt: 0, lastFrom: null };
let simPerson = true;      // used when no person sensor is reporting

let house, history, lastReason, lastChecks, today, events, eventSeq = 0;
function resetSim() {
  simMin = 6 * 60;          // start at 06:00, just before the sun gets going
  const w = weatherAt(simMin);
  house = { tin: w.tout + 3, window: false, intakeFan: false, ac: false, blinds: 0 };
  history = [];
  today = { outsideAirMin: 0, acMin: 0 };
  lastReason = "";
  lastChecks = null;
}
events = [];

function weatherAt(min) {
  const s = SCENARIOS[scenarioKey];
  const h = (min / 60) % 24;
  // coldest ~05:00, hottest ~15:00
  const phase = Math.cos(((h - 15) / 24) * 2 * Math.PI);
  const tout = sensorOutdoorLive() ? sensor.outdoor : (s.min + s.max) / 2 + ((s.max - s.min) / 2) * phase; // real reading wins
  const sun = h > 6 && h < 19 ? s.sunPeak * Math.sin((Math.PI * (h - 6)) / 13) : 0;
  const humidity = s.humMax - (s.humMax - s.humMin) * (phase + 1) / 2;
  // dew point (Magnus formula)
  const a = Math.log(humidity / 100) + (17.62 * tout) / (243.12 + tout);
  const dewPoint = (243.12 * a) / (17.62 - a);
  return { hour: h, tout, sun: Math.max(0, sun), humidity, dewPoint };
}

function acCop(tout) { return Math.min(4.5, Math.max(2.0, 3.8 - 0.07 * (tout - 25))); }

const nowS = () => Date.now() / 1000;
const sensorTempLive = () => sensor.temp !== null && nowS() - sensor.tempAt < SENSOR_TIMEOUT_S;
const sensorOutdoorLive = () => sensor.outdoor !== null && nowS() - sensor.outdoorAt < SENSOR_TIMEOUT_S;
const sensorPersonLive = () => sensor.person !== null && nowS() - sensor.personAt < SENSOR_TIMEOUT_S;
const personNow = () => (sensorPersonLive() ? sensor.person : simPerson);

// ---------------- the controller ----------------
function decide(w) {
  const person = personNow();
  const gap = house.tin - w.tout;
  const precool = w.hour >= CTRL.precoolStart || w.hour < CTRL.precoolEnd;
  const acTarget = person ? setpoint : setpoint + CTRL.emptySetback;
  const target = precool ? setpoint - CTRL.precoolBelow : acTarget; // free cooling target
  const outsideOk = w.dewPoint <= CTRL.maxDewPoint && w.tout >= CTRL.minOutdoor;

  // Window (always automatic): open for free cooling, with hysteresis on the gap.
  const window = house.window
    ? gap > CTRL.stopDelta && outsideOk && house.tin > target - 0.5
    : gap >= CTRL.freeCoolDelta && outsideOk && house.tin > target;

  let reason;
  if (window) reason = precool ? `Pre-cooling for tomorrow's sun: outside is ${gap.toFixed(1)}°C cooler` : `Cooling with outside air: outside is ${gap.toFixed(1)}°C cooler`;
  else if (w.dewPoint > CTRL.maxDewPoint && gap >= CTRL.freeCoolDelta) reason = `Outside is cooler but too muggy (dew point ${w.dewPoint.toFixed(0)}°C)`;
  else if (gap < CTRL.freeCoolDelta) reason = w.sun > 300 ? `Sun is up and outside is warmer, window shut to keep heat out` : `Outside isn't cool enough, window shut`;
  else reason = `At target, nothing to do`;
  if (!person) reason += ` · nobody detected, AC target relaxed to ${acTarget.toFixed(1)}°C`;

  // Intake fan: pulls outside air in, so in auto it runs exactly when the window is open.
  let intakeFan = window;
  if (overrides.intakeFan === "on") intakeFan = true;
  if (overrides.intakeFan === "off") intakeFan = false;

  // AC: thermostat, locked out in auto while the window is open.
  let ac = house.ac;
  if (house.tin > acTarget + CTRL.acBand) ac = true;
  if (house.tin < acTarget - CTRL.acBand) ac = false;
  if (window && overrides.ac === null) ac = false;
  if (overrides.ac === "on") ac = true;
  if (overrides.ac === "off") ac = false;

  // Blinds (0 open … 100 closed): close against strong sun when the house is warm, open otherwise.
  let blinds = 0;
  if (w.sun > 0 && house.tin > target - 1) {
    blinds = Math.round(Math.min(1, w.sun / CTRL.blindsFullSun) * 10) * 10; // steps of 10 so they don't twitch
    if (person) blinds = Math.min(blinds, CTRL.blindsMaxWithPerson);
  }
  if (overrides.blinds !== null) blinds = overrides.blinds;

  if (window && ac) reason += " (warning: AC running with window open)";
  if (!window && intakeFan) reason += " (note: the intake fan is forced on but the window is shut, so it can't bring in outside air)";

  const checks = {
    gap: +gap.toFixed(2), needGap: house.window ? CTRL.stopDelta : CTRL.freeCoolDelta,
    dewPoint: +w.dewPoint.toFixed(1), maxDewPoint: CTRL.maxDewPoint,
    tout: +w.tout.toFixed(2), minOutdoor: CTRL.minOutdoor,
    tin: +house.tin.toFixed(2), target: +target.toFixed(2), acTarget: +acTarget.toFixed(2), precool, freeCool: window, person,
  };
  return { window, intakeFan, ac, blinds, reason, checks };
}

// ---------------- apply a decision (no time passes) ----------------
// Called every sim minute, and straight after any request that changes something, so the state reacts instantly.
function applyDecision() {
  if (sensorTempLive()) house.tin = sensor.temp;
  const d = decide(weatherAt(simMin));
  if (d.window !== house.window) event(d.window ? "Window OPENED" : "Window CLOSED");
  if (d.intakeFan !== house.intakeFan) event(d.intakeFan ? "Intake fan ON" : "Intake fan OFF");
  if (d.ac !== house.ac) event(d.ac ? "AC ON" : "AC OFF");
  if (Math.abs(d.blinds - house.blinds) >= 30 || (d.blinds === 0) !== (house.blinds === 0)) event(`Blinds ${d.blinds}% closed`);
  const kind = (r) => r.replace(/[\d.]+/g, "#"); // ignore changing numbers when deciding to log
  if (kind(d.reason) !== kind(lastReason) && !d.reason.startsWith("At target")) event(d.reason);
  lastReason = d.reason;
  lastChecks = d.checks;
  Object.assign(house, { window: d.window, intakeFan: d.intakeFan, ac: d.ac, blinds: d.blinds });
}

// where the heat is coming from right now, kW (+ heats the house, − cools it)
function heatFlows(w) {
  const vent = house.window ? HOUSE.windowUA + (house.intakeFan ? AIR_KW_PER_M3H * HOUSE.fanFlow : 0) : 0;
  const parts = {
    sun: HOUSE.solarGain * w.sun * (1 - HOUSE.blindsBlock * house.blinds / 100),
    walls: HOUSE.envelopeUA * (w.tout - house.tin),
    inside: HOUSE.internalGain,
    outsideAir: vent * (w.tout - house.tin),
    ac: house.ac ? -HOUSE.acCoolKw : 0,
  };
  const net = parts.sun + parts.walls + parts.inside + parts.outsideAir + parts.ac;
  return { ...parts, net, degPerHour: net / HOUSE.capacity };
}
const powerKw = (w) => ({ ac: house.ac ? HOUSE.acCoolKw / acCop(w.tout) : 0, fan: house.intakeFan ? HOUSE.fanKw : 0 });

// ---------------- physics step (1 sim minute) ----------------
function step() {
  applyDecision();
  const w = weatherAt(simMin);
  if (house.window && !house.ac) today.outsideAirMin++;
  if (house.ac) today.acMin++;
  const { net } = heatFlows(w);
  const p = powerKw(w);
  if (!sensorTempLive()) house.tin += (net / 60) / HOUSE.capacity; // a live sensor reading wins over the model

  simMin++;
  if (simMin % 1440 === 0) today = { outsideAirMin: 0, acMin: 0 }; // new day at midnight
  if (simMin % 5 === 0) {
    history.push({ m: simMin, tin: +house.tin.toFixed(2), tout: +w.tout.toFixed(2), sun: Math.round(w.sun), win: house.window ? 1 : 0, ac: house.ac ? 1 : 0, blinds: house.blinds, kw: +(p.ac + p.fan).toFixed(2) });
    if (history.length > 288) history.shift(); // 24 h at 5-min resolution
  }
}

function clock(min) {
  return `${String(Math.floor((min / 60) % 24)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function event(msg) {
  events.push({ id: ++eventSeq, sim: clock(simMin), msg });
  if (events.length > 60) events.shift();
  console.log(`[${clock(simMin)}] ${msg}`);
}

function modeNow() {
  if (house.ac) return "ac";
  if (house.window) return "outside-air";
  return "holding";
}

// ---------------- what the endpoints return ----------------
const r2 = (v) => +v.toFixed(2);
function fullState() {
  const w = weatherAt(simMin), p = powerKw(w), h = heatFlows(w);
  return {
    simMinute: simMin, day: Math.floor(simMin / 1440) + 1, hour: +w.hour.toFixed(3), clock: clock(simMin),
    scenario: scenarioKey, scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.label])),
    speed, paused, setpoint,
    mode: modeNow(),
    inputs: {
      indoorTemp: r2(house.tin), indoorSource: sensorTempLive() ? "sensor" : "simulated",
      outdoorTemp: r2(w.tout), outdoorSource: sensorOutdoorLive() ? "sensor" : "simulated",
      person: personNow(), personSource: sensorPersonLive() ? "sensor" : "simulated",
      sensorLastSeenS: sensor.lastFrom ? Math.round(nowS() - sensor.lastFrom) : null,
    },
    outdoor: { temp: r2(w.tout), humidity: +w.humidity.toFixed(1), dewPoint: +w.dewPoint.toFixed(1), sun: Math.round(w.sun) },
    outputs: { window: house.window, intakeFan: house.intakeFan, ac: house.ac, blinds: house.blinds },
    overrides: { ...overrides },
    ac: { kw: r2(p.ac), cop: r2(acCop(w.tout)) },
    reason: lastReason, checks: lastChecks,
    heat: { sun: r2(h.sun), walls: r2(h.walls), inside: r2(h.inside), outsideAir: r2(h.outsideAir), ac: r2(h.ac), net: r2(h.net), degPerHour: r2(h.degPerHour) },
    today: { outsideAirHours: r2(today.outsideAirMin / 60), acHours: r2(today.acMin / 60) },
    history, events,
  };
}

// compact reply for the board: the four outputs plus what the LED and a 16x2 LCD should show
function deviceReply() {
  const w = weatherAt(simMin), mode = modeNow();
  const pad = (s) => s.slice(0, 16).padEnd(16);
  const label = { "outside-air": "OUTSIDE AIR", ac: "AC ON", holding: "HOLDING" }[mode];
  return {
    ok: true,
    window: house.window, intakeFan: house.intakeFan, ac: house.ac, blinds: house.blinds,
    mode, led: mode === "outside-air", person: personNow(),
    indoor: r2(house.tin), outdoor: +w.tout.toFixed(1), target: lastChecks ? lastChecks.acTarget : setpoint,
    lcd: [pad(`IN ${house.tin.toFixed(1)} OUT ${w.tout.toFixed(0)}C`), pad(`${label} B${house.blinds}`)],
  };
}

// ---------------- reading payloads ----------------
class BadRequest extends Error {}

// true/false, 1/0, "on"/"off", "yes"/"no" -> boolean; anything else -> undefined
function toBool(v) {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "on", "yes", "y"].includes(s)) return true;
    if (["false", "0", "off", "no", "n"].includes(s)) return false;
  }
  return undefined;
}
const toNum = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

/** Merge the query string, ?json=..., and a JSON body into one payload. Arrays are passed through. */
function readPayload(url, body) {
  let payload = {};
  for (const [k, v] of url.searchParams) if (k !== "json") payload[k] = v;
  const sources = [];
  if (url.searchParams.has("json")) sources.push(url.searchParams.get("json"));
  if (body && body.trim()) sources.push(body);
  for (const src of sources) {
    let parsed;
    try { parsed = JSON.parse(src); } catch { throw new BadRequest("payload is not valid JSON"); }
    if (Array.isArray(parsed)) {
      if (Object.keys(payload).length === 0 && sources.length === 1) return parsed;
      payload = { ...payload, ...flattenArray(parsed) };
    } else if (parsed && typeof parsed === "object") payload = { ...payload, ...parsed };
    else throw new BadRequest("payload must be a JSON object or array");
  }
  return payload;
}

/**
 * Sensor arrays come in a few common shapes; all of these mean the same thing:
 *   [{"temp":27.5},{"person":true}]                       list of small objects
 *   [{"name":"temp","value":27.5},{"sensor":"person","value":1}]   name/value pairs
 *   [27.5, true, 19.2]                                     positional: [indoor temp, person, outdoor temp]
 */
function flattenArray(arr) {
  const out = {};
  arr.forEach((item, i) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const key = item.name ?? item.sensor ?? item.type ?? item.key ?? item.id;
      if (typeof key === "string" && "value" in item) out[key] = item.value;
      else Object.assign(out, item);
    } else if (i === 0) out.temp = item;
    else if (i === 1) out.person = item;
    else if (i === 2) out.outdoorTemp = item;
  });
  return out;
}

const TEMP_KEYS = ["temp", "temperature", "indoorTemp", "indoor", "tempC", "t"];
const OUTDOOR_KEYS = ["outdoorTemp", "outdoor", "outsideTemp", "outside", "tempOut", "outTemp", "tout"];
const PERSON_KEYS = ["person", "personDetected", "present", "presence", "occupied", "motion", "pir"];
function readSensor(payload) {
  const p = Array.isArray(payload) ? flattenArray(payload) : payload;
  const find = (keys) => { for (const k of Object.keys(p)) if (keys.some((want) => want.toLowerCase() === k.toLowerCase())) return p[k]; return undefined; };
  const rawT = find(TEMP_KEYS), rawO = find(OUTDOOR_KEYS), rawP = find(PERSON_KEYS);
  // check everything first, so a request with one bad value changes nothing
  const temp = (raw, what) => {
    const t = toNum(raw);
    if (!Number.isFinite(t) || t < -20 || t > 60) throw new BadRequest(`${what} must be a number between -20 and 60 °C, got ${JSON.stringify(raw)}`);
    return t;
  };
  const t = rawT !== undefined ? temp(rawT, "temperature") : undefined;
  const o = rawO !== undefined ? temp(rawO, "outdoor temperature") : undefined;
  const b = rawP !== undefined ? toBool(rawP) : undefined;
  if (rawP !== undefined && b === undefined) throw new BadRequest(`person must be true/false (or 1/0), got ${JSON.stringify(rawP)}`);
  if (t === undefined && o === undefined && b === undefined) throw new BadRequest(`no temperature, outdoor temperature or person value found; send e.g. {"temp":27.5,"outdoorTemp":19.2,"person":true}`);

  const got = [];
  if (t !== undefined) { sensor.temp = t; sensor.tempAt = nowS(); got.push("temp"); }
  if (o !== undefined) { sensor.outdoor = o; sensor.outdoorAt = nowS(); got.push("outdoorTemp"); }
  if (b !== undefined) {
    if (b !== sensor.person || !sensorPersonLive()) event(b ? "Person detected" : "Nobody detected");
    sensor.person = b; sensor.personAt = nowS(); got.push("person");
  }
  sensor.lastFrom = nowS();
  return got;
}

// ---------------- request handlers ----------------
function handleOverride(p) {
  const raw = String(p.device ?? "").trim();
  const DEVICES = { intakefan: "intakeFan", fan: "intakeFan", ac: "ac", blinds: "blinds" };
  const device = Object.hasOwn(DEVICES, raw.toLowerCase()) ? DEVICES[raw.toLowerCase()] : undefined; // hasOwn: "constructor" etc. aren't devices
  if (!device) {
    if (raw.toLowerCase() === "window") throw new BadRequest("the window is always automatic and can't be overridden");
    throw new BadRequest(`device must be intakeFan, ac or blinds, got ${JSON.stringify(p.device ?? null)}`);
  }
  const mode = p.mode === undefined || p.mode === null ? undefined : String(p.mode).trim().toLowerCase();
  if (mode === "auto") {
    overrides[device] = null;
    event(`${device} override cleared, back to auto`);
  } else if (device === "blinds") {
    const v = toNum(p.value ?? p.mode);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new BadRequest(`blinds value must be 0 (open) to 100 (closed), got ${JSON.stringify(p.value ?? p.mode ?? null)}`);
    overrides.blinds = Math.round(v);
    event(`Override: blinds ${overrides.blinds}% closed`);
  } else {
    const b = toBool(p.mode ?? p.value);
    if (b === undefined) throw new BadRequest(`mode for ${device} must be on, off or auto, got ${JSON.stringify(p.mode ?? null)}`);
    overrides[device] = b ? "on" : "off";
    event(`Override: ${device} ${overrides[device].toUpperCase()}`);
  }
}

function handleSetpoint(p) {
  const v = toNum(p.value);
  if (!Number.isFinite(v) || v < 18 || v > 30) throw new BadRequest(`setpoint must be 18-30 °C, got ${JSON.stringify(p.value ?? null)}`);
  setpoint = Math.round(v * 2) / 2;
  event(`Setpoint changed to ${setpoint}°C`);
}

function handleSim(p) {
  let did = false;
  if (p.scenario !== undefined) {
    if (typeof p.scenario !== "string" || !Object.hasOwn(SCENARIOS, p.scenario)) throw new BadRequest(`scenario must be one of ${Object.keys(SCENARIOS).join(", ")}`);
    if (p.scenario !== scenarioKey) { scenarioKey = p.scenario; p.reset = true; }
    did = true;
  }
  if (p.speed !== undefined) {
    const sp = Math.round(toNum(p.speed));
    if (!(sp >= 1)) throw new BadRequest("speed must be a number of sim minutes per second, 1-60");
    speed = Math.min(60, sp); did = true;
  }
  if (p.paused !== undefined) {
    const b = toBool(p.paused);
    if (b === undefined) throw new BadRequest("paused must be true or false");
    paused = b; did = true;
  }
  if (p.person !== undefined) { // lets the dashboard stand in for the person sensor
    const b = toBool(p.person);
    if (b === undefined) throw new BadRequest("person must be true or false");
    if (b !== simPerson) event(b ? "Simulated person: someone home" : "Simulated person: nobody home");
    simPerson = b; did = true;
  }
  if (toBool(p.reset) === true) { resetSim(); event(`Simulation reset: ${SCENARIOS[scenarioKey].label}`); did = true; }
  if (!did) throw new BadRequest("nothing to do; send scenario, speed, paused, person or reset");
}

// ---------------- main loop ----------------
resetSim();
setInterval(() => {
  if (paused) applyDecision(); // nothing moves, but sensor readings and overrides still take effect
  else for (let i = 0; i < speed; i++) step();
}, 1000);

// ---------------- HTTP server ----------------
function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch { return send(res, 400, { ok: false, error: "bad URL" }); }

  if (req.method === "OPTIONS") { // CORS preflight, so the dashboard can be opened from a file too
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(__dirname, "dashboard.html")).pipe(res);
  }
  if (!url.pathname.startsWith("/api/")) { res.writeHead(404); return res.end("not found"); }
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { ok: false, error: "use GET or POST" });

  let body = "", tooBig = false;
  req.on("data", (d) => {
    if (tooBig) return;
    body += d;
    if (body.length > 64 * 1024) { tooBig = true; send(res, 413, { ok: false, error: "payload too large (64 KB max)" }); req.resume(); }
  });
  req.on("end", () => {
    if (tooBig) return;
    const route = url.pathname.slice(5);
    // show every board reading in the terminal, so you can see the ESP32/PSoC getting through
    const from = (req.socket.remoteAddress || "?").replace(/^::ffff:/, "");
    const raw = body.trim() || url.search.slice(1);
    const logSensor = (msg) => { if (route === "sensor") console.log(`[sensor ${new Date().toLocaleTimeString()}] from ${from}: ${raw.slice(0, 200)}  ->  ${msg}`); };
    try {
      if (route === "state") return send(res, 200, fullState());
      const payload = readPayload(url, body);
      if (route === "sensor") {
        const got = readSensor(payload); applyDecision();
        const r = deviceReply();
        logSensor(`window=${+r.window} fan=${+r.intakeFan} ac=${+r.ac} blinds=${r.blinds} led=${+r.led}`);
        return send(res, 200, { ...r, received: got });
      }
      if (Array.isArray(payload)) throw new BadRequest("this endpoint takes a JSON object, not an array");
      if (route === "override") handleOverride(payload);
      else if (route === "setpoint") handleSetpoint(payload);
      else if (route === "sim") handleSim(payload);
      else return send(res, 404, { ok: false, error: `unknown endpoint /api/${route}` });
      applyDecision();
      send(res, 200, { ok: true, state: fullState() });
    } catch (e) {
      if (e instanceof BadRequest) { logSensor(`REJECTED: ${e.message}`); send(res, 400, { ok: false, error: e.message }); }
      else { console.error(e); send(res, 500, { ok: false, error: "internal error" }); }
    }
  });
});
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${HTTP_PORT} is already in use, probably by another CoolAir server that's still running.`);
    console.error(`Close that one (Ctrl+C in its terminal), or start this one on another port:  $env:PORT=8081; npm start`);
  } else console.error("Server error:", e.message);
  process.exit(1);
});
server.listen(HTTP_PORT, () => console.log(`CoolAir running: dashboard at http://localhost:${HTTP_PORT}  (API under /api/)`));
