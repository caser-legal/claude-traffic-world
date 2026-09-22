/* tl — app.js
   The sky outside, the sun, the weather, the HUD, and mode management.
   The scene canvas only shows the ground world (world.js); everything
   atmospheric lives here, on a full-viewport canvas behind it. */

"use strict";

const $ = s => document.querySelector(s);
/* clamp / lerp / smooth come from world.js (loaded first) */

/* ── persisted settings ─────────────────────────────────────────────── */
const store = {
  get zip() { return localStorage.getItem("tl.zip") || ""; },
  set zip(v) { localStorage.setItem("tl.zip", v); },
  get sound() { return localStorage.getItem("tl.sound") === "1"; },
  set sound(v) { localStorage.setItem("tl.sound", v ? "1" : "0"); },
};

/* ── sun position (low-precision NOAA — plenty for light & shadow) ─── */
function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const n = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const alpha = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + lon) * rad;
  let H = lst - alpha;
  H = ((H + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const latR = lat * rad;
  const elev = Math.asin(Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(latR) - Math.tan(decl) * Math.cos(latR));
  return { elev: elev / rad, azim: ((az / rad + 180) % 360 + 360) % 360 };
}
function sunCrossings(date, lat, lon) { // today's sunrise / sunset (elev −0.83°)
  const day = new Date(date); day.setHours(0, 0, 0, 0);
  let rise = null, set = null, prev = null;
  for (let m = 0; m <= 1440; m += 8) {
    const t = new Date(day.getTime() + m * 60000);
    const e = sunPosition(t, lat, lon).elev + 0.83;
    if (prev !== null) {
      if (prev.e < 0 && e >= 0 && rise === null) rise = new Date(prev.t.getTime() + (m - prev.m) * 300);
      if (prev.e >= 0 && e < 0 && set === null) set = new Date(prev.t.getTime() + (m - prev.m) * 300);
    }
    prev = { e, t, m };
  }
  return { rise, set };
}
const fmtTime = d => d ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";

/* ── weather ────────────────────────────────────────────────────────── */
const WMO = {
  0: ["clear", 0.03], 1: ["mostly clear", 0.15], 2: ["partly cloudy", 0.4], 3: ["overcast", 0.92],
  45: ["fog", 0.6], 48: ["fog", 0.7],
  51: ["drizzle", 0.7], 53: ["drizzle", 0.8], 55: ["drizzle", 0.9],
  61: ["rain", 0.85], 63: ["rain", 0.95], 65: ["heavy rain", 1],
  66: ["freezing rain", 0.95], 67: ["freezing rain", 1],
  71: ["snow", 0.8], 73: ["snow", 0.9], 75: ["heavy snow", 0.97], 77: ["snow", 0.7],
  80: ["showers", 0.7], 81: ["showers", 0.85], 82: ["downpour", 1],
  85: ["snow showers", 0.8], 86: ["snow showers", 0.9],
  95: ["thunderstorm", 0.9], 96: ["thunderstorm", 0.95], 99: ["thunderstorm", 1],
};
const wx = {
  ok: false, temp: null, name: "—", code: 0, cloud: 0.25, precip: 0, snow: false,
  windKmh: 6, windDir: 250, storm: false, fog: 0, lat: null, lon: null,
  sunrise: null, sunset: null, isDay: 1,
};

async function refreshWeather() {
  const zip = store.zip;
  if (!zip) {
    wx.ok = false;
    // timezone fallback: approximate longitude (1 h ≈ 15°), mid-latitude
    const off = -new Date().getTimezoneOffset() / 60;
    wx.lat = 40; wx.lon = off * 15;
    $("#wx-line").textContent = "approximate sky — set your zip ⚙ for the real one";
    updateSunLine();
    return;
  }
  try {
    const j = await fetch(`/api/weather?zip=${encodeURIComponent(zip)}`).then(r => r.json());
    if (j.error) throw new Error(j.error);
    const c = j.current || {};
    const [name] = WMO[c.weather_code] || ["weather", 0.3];
    Object.assign(wx, {
      ok: true, temp: Math.round(c.temperature_2m), name,
      code: c.weather_code,
      cloud: (c.cloud_cover ?? 40) / 100,
      precip: c.precipitation ?? 0,
      snow: [71, 73, 75, 77, 85, 86].includes(c.weather_code),
      windKmh: c.wind_speed_10m ?? 6, windDir: c.wind_direction_10m ?? 250,
      storm: c.weather_code >= 95,
      fog: [45, 48].includes(c.weather_code) ? 0.85 : 0,
      lat: j.lat, lon: j.lon,
      sunrise: j.daily && j.daily.sunrise && new Date(j.daily.sunrise[0]),
      sunset: j.daily && j.daily.sunset && new Date(j.daily.sunset[0]),
      isDay: c.is_day ?? 1,
      place: `${j.city || zip}${j.state ? ", " + j.state : ""}`,
    });
    $("#wx-line").textContent = `${wx.temp}° ${name} · ${Math.round(wx.windKmh)} km/h wind · ${wx.place}`;
    updateSunLine();
  } catch (err) {
    $("#wx-line").textContent = `weather unavailable (${String(err.message || err)}) — will retry`;
  }
}
function updateSunLine() {
  const lat = wx.lat ?? 40, lon = wx.lon ?? 0;
  let { rise, set } = { rise: wx.sunrise, set: wx.sunset };
  if (!rise || !set) ({ rise, set } = sunCrossings(new Date(), lat, lon));
  $("#sun-line").textContent = `sunrise ${fmtTime(rise)} · sunset ${fmtTime(set)}`;
}

/* ── ambient audio (synthesized, off by default) ────────────────────── */
class Ambience {
  constructor() { this.on = store.sound; this.ctx = null; }
  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);
    // shared noise buffer
    const len = this.ctx.sampleRate * 2;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // rain layer
    this.rain = this.loop(900, 0);
    this.wind = this.loop(260, 0);
  }
  loop(cut, gain) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = cut;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start();
    return g;
  }
  setLevel(node, v, t = 0.8) {
    if (!this.ctx) return;
    node.gain.cancelScheduledValues(this.ctx.currentTime);
    node.gain.setTargetAtTime(v, this.ctx.currentTime, t);
  }
  apply() {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(this.on ? 0.5 : 0, this.ctx.currentTime, 0.4);
    this.setLevel(this.rain, clamp(env.wet * (env.snow > 0.5 ? 0.02 : 0.3), 0, 0.3));
    this.setLevel(this.wind, clamp(env.windKmh / 90, 0, 0.12));
  }
  chirp(base) {
    if (!this.ctx || !this.on) return;
    const t0 = this.ctx.currentTime;
    for (let i = 0; i < 2 + Math.random() * 2; i++) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      const t = t0 + i * 0.14;
      const f0 = base * (0.85 + Math.random() * 0.3);
      o.frequency.setValueAtTime(f0 * 1.25, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.8, t + 0.1);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 0.16);
    }
  }
  cricket() {
    if (!this.ctx || !this.on) return;
    const t0 = this.ctx.currentTime;
    for (let i = 0; i < 5; i++) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      const t = t0 + i * 0.09;
      o.frequency.value = 4200 + Math.random() * 400;
      g.gain.setValueAtTime(0.0, t);
      g.gain.linearRampToValueAtTime(0.012, t + 0.015);
      g.gain.linearRampToValueAtTime(0.0, t + 0.05);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 0.06);
    }
  }
  thunder() {
    if (!this.ctx || !this.on) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = "lowpass";
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    f.frequency.setValueAtTime(160, t);
    f.frequency.exponentialRampToValueAtTime(45, t + 2.6);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.55, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.001, t + 3.2);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + 3.4);
  }
}

/* ── environment state (smoothed) ───────────────────────────────────── */
const env = { day: 1, night: 0, warm: 0, wet: 0, snow: 0, fog: 0, windKmh: 6, windX: 0.3, elev: 30, azim: 180, flash: 0 };
let world, feed, director, audio = new Ambience();

function updateEnvironment(dt) {
  const lat = wx.lat ?? 40, lon = wx.lon ?? 0;
  const { elev, azim } = sunPosition(new Date(), lat, lon);
  env.elev = elev; env.azim = azim;
  let day = smooth((elev + 4) / 12) * (1 - 0.25 * wx.cloud);
  env.day = day; env.night = 1 - smooth((elev + 3) / 10);
  env.warm = Math.exp(-(((elev - 3) / 9) ** 2)) * (elev > -9 ? 1 : 0) * (1 - wx.cloud * 0.6);
  const wetTarget = (wx.precip > 0.1 || [51, 53, 55, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(wx.code)) ? 1 : (env.wet > 0.05 ? env.wet - dt * 0.01 : 0);
  env.wet = lerp(env.wet, wetTarget, dt * 0.15);
  env.snow = lerp(env.snow, wx.snow ? 1 : 0, dt * 0.03);
  env.fog = lerp(env.fog, wx.fog, dt * 0.1);
  env.windKmh = wx.windKmh;
  const toward = ((wx.windDir + 180) % 360) * Math.PI / 180;
  env.windX = Math.sin(toward);
  env.windY = -Math.cos(toward);
  env.flash = Math.max(0, env.flash - dt * 2.2);

  const L = world.lighting;
  L.day = day; L.night = env.night; L.warm = env.warm; L.wet = env.wet; L.snow = env.snow; L.fog = env.fog;
  L.windSpeed = env.windKmh; L.windX = env.windX;
  L.lightsOn = env.night > 0.3 || env.wet > 0.5 || env.fog > 0.4;
  if (elev > 1) {
    const len = clamp(150 / Math.tan(elev * Math.PI / 180), 16, 150);
    L.shadow = { x: -Math.sin(azim * Math.PI / 180), y: Math.cos(azim * Math.PI / 180), len };
  } else {
    L.shadow = { x: -0.5, y: 0.5, len: 22 };
  }
}

/* ── overhead weather layer — transparent, drawn above the map ──────── */
const sky = $("#sky");
const skyCtx = sky.getContext("2d");
let birds = [], raindrops = [], flakes = [];

function resizeSky() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  sky.width = innerWidth * dpr; sky.height = innerHeight * dpr;
  skyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", resizeSky);
resizeSky();

/* Everything that happens above the map: precip, birds, lightning, fog.
   Time of day no longer paints a sky — it drives the world's own light,
   color grading, shadows and cloud shadows instead. */
function renderOverlay(dt) {
  const c = skyCtx, w = innerWidth, h = innerHeight;
  c.clearRect(0, 0, w, h);

  // birds crossing overhead (dawn / early morning, dry)
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 9 && wx.precip < 0.1 && Math.random() < dt * 0.05 && birds.length < 2) {
    const dir = Math.random() < 0.5 ? 1 : -1;
    birds.push({ x: dir > 0 ? -80 : w + 80, y: h * (0.12 + Math.random() * 0.5), v: dir * (150 + Math.random() * 110), ph: 0 });
  }
  birds = birds.filter(b => {
    b.x += b.v * dt; b.ph += dt * 9;
    const flap = Math.sin(b.ph) * 3.5;
    c.strokeStyle = `rgba(16,20,26,${env.night > 0.5 ? 0.45 : 0.7})`;
    c.lineWidth = 1.6;
    for (let i = 0; i < 4; i++) {
      const bx = b.x - i * 15 * Math.sign(b.v), by = b.y + i * 6 + (i % 2) * 5;
      c.beginPath();
      c.moveTo(bx - 5, by - flap * 0.4);
      c.quadraticCurveTo(bx, by + flap, bx + 5, by - flap * 0.4);
      c.stroke();
    }
    return b.x > -140 && b.x < w + 140;
  });

  // precipitation falling past the camera
  if (env.wet > 0.15 && !wx.snow) {
    while (raindrops.length < 220) raindrops.push({ x: Math.random() * w, y: Math.random() * h, l: 10 + Math.random() * 14, s: 640 + Math.random() * 380 });
    c.strokeStyle = `rgba(178,198,222,${0.20 + env.wet * 0.15})`;
    c.lineWidth = 1;
    c.beginPath();
    const vx = env.windX * env.windKmh * 3.2;
    for (const d of raindrops) {
      d.y += d.s * dt; d.x += vx * dt;
      if (d.y > h) { d.y = -20; d.x = Math.random() * w; }
      if (d.x > w + 30) d.x = -20; if (d.x < -30) d.x = w + 20;
      c.moveTo(d.x, d.y); c.lineTo(d.x - vx * 0.016, d.y - d.l);
    }
    c.stroke();
  } else raindrops.length = 0;
  if (env.snow > 0.15) {
    while (flakes.length < 150) flakes.push({ x: Math.random() * w, y: Math.random() * h, r: 1 + Math.random() * 2.2, s: 26 + Math.random() * 40, ph: Math.random() * 6.28 });
    c.fillStyle = `rgba(240,246,255,${0.5 * env.snow})`;
    for (const f of flakes) {
      f.ph += dt; f.y += f.s * dt; f.x += Math.sin(f.ph) * 14 * dt + env.windX * 20 * dt;
      if (f.y > h) { f.y = -8; f.x = Math.random() * w; }
      if (f.x > w + 8) f.x = -8; if (f.x < -8) f.x = w + 8;
      c.beginPath(); c.arc(f.x, f.y, f.r, 0, Math.PI * 2); c.fill();
    }
  } else flakes.length = 0;

  // lightning — the whole map flashes, then thunder rolls in
  if (wx.storm && Math.random() < dt * 0.06) {
    env.flash = 1;
    world.flash = 1;
    setTimeout(() => audio.thunder(), 400 + Math.random() * 2200);
  }
  if (env.flash > 0) {
    c.fillStyle = `rgba(220,228,255,${env.flash * 0.30})`;
    c.fillRect(0, 0, w, h);
  }

  // fog veil over everything
  if (env.fog > 0.02) {
    c.fillStyle = `rgba(190,198,208,${env.fog * 0.30})`;
    c.fillRect(0, 0, w, h);
  }
}

/* cloud shadows drifting across the map — real cloud cover, real wind */
let cloudShadows = [];
function updateCloudShadows(dt) {
  const want = Math.round((wx.cloud ?? 0.3) * 7);
  while (cloudShadows.length < want) cloudShadows.push({
    x: (Math.random() * 2 - 1) * 1500, y: (Math.random() * 2 - 1) * 1500,
    r: 190 + Math.random() * 230, a: 0.09 + Math.random() * 0.09, rot: Math.random() * Math.PI,
  });
  cloudShadows.length = want;
  const sp = 10 + env.windKmh * 1.1;
  for (const cs of cloudShadows) {
    cs.x += env.windX * sp * dt;
    cs.y += (env.windY || 0) * sp * dt;
    if (cs.x > 1650) cs.x -= 3300; if (cs.x < -1650) cs.x += 3300;
    if (cs.y > 1650) cs.y -= 3300; if (cs.y < -1650) cs.y += 3300;
  }
  world.lighting.cloudShadows = cloudShadows;
}

/* ── ambient sound scheduling ───────────────────────────────────────── */
let birdT = 3, cricketT = 2;
function tickAudio(dt) {
  if (!audio.on || !audio.ctx) return;
  const hour = new Date().getHours();
  birdT -= dt;
  if (birdT <= 0) {
    birdT = 2 + Math.random() * 6;
    if (hour >= 5 && hour < 9 && wx.precip < 0.1) audio.chirp(2600 + Math.random() * 700);
    else if (hour >= 9 && hour < 19 && Math.random() < 0.25 && wx.precip < 0.1) audio.chirp(3200);
  }
  cricketT -= dt;
  if (cricketT <= 0) {
    cricketT = 1.4 + Math.random() * 1.6;
    if ((hour >= 20 || hour < 5) && env.wet < 0.3) audio.cricket();
  }
}

/* ── HUD wiring ─────────────────────────────────────────────────────── */
const hud = {
  dirty: true,
  tick() {
    if (world && director) {
      $("#st-through").textContent = world.stats.through;
      $("#st-crash").textContent = world.stats.crashed;
      $("#st-queue").textContent = world.stats.queued + (world.stats.active || 0);
      $("#st-events").textContent = director.events;
      $("#st-tokens").textContent = `${(director.tokens / 1000).toFixed(1)}k tokens this session`;
      const st = director.statusLine();
      $("#status-dot").className = "dot " + st.dot;
      $("#status-line").textContent = st.line;
      $("#status-sub").textContent = st.sub;
    }
    $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  },
};

/* car detail card — click a car */
function projectUnits() {
  // flat top-down: same cover scale as the #scene css (115vmax / SCENE_SIZE)
  const vw = innerWidth, vh = innerHeight;
  const k = (Math.max(vw, vh) * 1.15) / SCENE_SIZE;
  const out = [];
  if (!world) return out;
  for (const u of world.unitCars.values()) {
    if (!u.car || u.car.done) continue;
    out.push({ unit: u, sx: vw / 2 + u.car.pose.x * k, sy: vh / 2 + u.car.pose.y * k });
  }
  return out;
}
addEventListener("pointerdown", ev => {
  if (ev.target.closest(".panel")) return;
  let best = null, bd = 52;
  for (const p of projectUnits()) {
    const d = Math.hypot(p.sx - ev.clientX, p.sy - ev.clientY);
    if (d < bd) { bd = d; best = p; }
  }
  if (best) showCar(best.unit);
  else $("#p-car").hidden = true;
});
function showCar(u) {
  const info = director.units.get(u.id);
  $("#car-title").textContent = u.label;
  $("#car-kind").textContent = `${u.kind === "task" ? "task" : "request"} · ${u.state}`;
  const p = info ? clamp(director.progressOf(info), 0, 1) : u.progress;
  const bar = $("#car-prog");
  bar.style.width = (p * 100).toFixed(0) + "%";
  bar.style.background = u.state === "crashed" ? "var(--red)" : u.state === "released" ? "var(--green)" : "var(--yellow)";
  $("#car-stats").textContent = info
    ? `${info.done}/${info.expected} tool calls · ${info.errors} error${info.errors === 1 ? "" : "s"} · started ${Math.max(0, Math.round((Date.now() - info.t0) / 1000))}s ago`
    : "—";
  const ol = $("#car-tools");
  ol.textContent = "";
  if (info) for (const t of info.tools.slice(-8).reverse()) {
    const li = document.createElement("li");
    li.className = t.state;
    li.textContent = `${t.name} ${t.sub}`.trim();
    ol.appendChild(li);
  }
  $("#p-car").hidden = false;
}
$("#car-close").addEventListener("click", () => $("#p-car").hidden = true);

/* idle HUD fade + kiosk */
let idleTimer = null;
function wake() {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add("idle"), 22000);
}
["pointermove", "pointerdown", "keydown"].forEach(e => addEventListener(e, wake));
wake();
addEventListener("keydown", e => {
  if (e.key === "f" || e.key === "F") toggleKiosk();
  if (e.key === "Escape") $("#p-car").hidden = true;
});
function toggleKiosk() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}
$("#btn-kiosk").addEventListener("click", toggleKiosk);

/* sound */
$("#btn-sound").classList.toggle("on", store.sound);
$("#btn-sound").addEventListener("click", () => {
  store.sound = !store.sound;
  audio.on = store.sound;
  $("#btn-sound").classList.toggle("on", store.sound);
  if (audio.on) { audio.ensure(); audio.ctx?.resume(); audio.apply(); }
});

/* settings popover */
$("#btn-gear").addEventListener("click", () => {
  const pop = $("#gear-pop");
  pop.hidden = !pop.hidden;
  if (!pop.hidden) $("#zip-input").value = store.zip;
});
$("#zip-save").addEventListener("click", () => {
  store.zip = $("#zip-input").value.trim();
  $("#gear-pop").hidden = true;
  refreshWeather();
});
$("#zip-input").addEventListener("keydown", e => { if (e.key === "Enter") $("#zip-save").click(); });

/* ── modes ──────────────────────────────────────────────────────────── */
let mode = "live", liveTimer = null, watchTimer = null, replayState = null, demo = null, currentFile = null;
function teardown() {
  clearInterval(liveTimer); clearInterval(watchTimer); liveTimer = watchTimer = null;
  if (replayState) { replayState.on = false; replayState = null; }
  if (demo) { demo.on = false; demo = null; }
  if (director) clearInterval(director.iv);
  world.clearUnits();
  feed.clear();
}
async function setMode(m) {
  mode = m;
  $("#mode-tag").textContent = m;
  document.querySelectorAll("#mode-seg button").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  $("#speed-row").hidden = m !== "replay";
  $("#demo-row").hidden = m !== "demo";
  teardown();
  director = new Director(world, feed, hud);
  if (m === "live") await startLive();
  else if (m === "replay") await startReplay();
  else startDemoMode();
}
document.querySelectorAll("#mode-seg button").forEach(b =>
  b.addEventListener("click", () => setMode(b.dataset.mode)));
document.querySelectorAll("#speed-seg button").forEach(b =>
  b.addEventListener("click", () => {
    if (replayState) replayState.speed = +b.dataset.speed;
    document.querySelectorAll("#speed-seg button").forEach(x => x.classList.toggle("on", x === b));
  }));
$("#btn-pause").addEventListener("click", () => {
  world.paused = !world.paused;
  if (replayState) replayState.paused = world.paused;
});
$("#feed-clear").addEventListener("click", () => feed.clear());

async function currentSessions() {
  try { return (await fetch("/api/sessions").then(r => r.json())).sessions; } catch { return []; }
}

async function startLive() {
  const sessions = await currentSessions();
  if (!sessions.length) {
    feed.note("no Claude Code sessions found — running the demo instead");
    $("#mode-seg [data-mode=demo]").click();
    return;
  }
  await attachLive(sessions[0]);
  watchTimer = setInterval(async () => {
    const s = await currentSessions();
    if (s.length && s[0].file !== currentFile) attachLive(s[0]);
  }, 20000);
}
async function attachLive(meta) {
  currentFile = meta.file;
  clearInterval(liveTimer);
  liveTimer = null;
  const short = meta.project.replace(/^-Users-[^-]+-/, "~/").replace(/-/g, "/");
  $("#watching").textContent = `watching ${short} — newest session`;
  feed.note(`now watching ${short}`);
  const tailer = new Tailer(meta.file);
  director.silent = true;
  const entries = await tailer.poll();
  for (const e of entries) director.onEntry(e);
  director.silent = false;
  director.materialize();
  liveTimer = setInterval(async () => {
    try {
      for (const e of await tailer.poll()) director.onEntry(e);
      hud.dirty = true;
    } catch { /* server hiccup — next tick */ }
  }, 1000);
}

async function startReplay() {
  const sessions = await currentSessions();
  if (!sessions.length) { feed.note("nothing to replay"); return; }
  const meta = sessions[0];
  $("#watching").textContent = `replaying ${meta.project.replace(/^-Users-[^-]+-/, "~/")}`;
  const tailer = new Tailer(meta.file);
  const entries = (await tailer.poll()).filter(e => e.timestamp);
  if (!entries.length) { feed.note("empty session"); return; }
  entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  let i = 0;
  const t0 = Date.parse(entries[0].timestamp);
  let clock = t0;
  replayState = { speed: 1, paused: false, on: true };
  let last = performance.now();
  const step = () => {
    if (!replayState || !replayState.on) return;
    requestAnimationFrame(step);
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (replayState.paused) return;
    clock += dt * 1000 * replayState.speed;
    let fired = 0;
    while (i < entries.length && Date.parse(entries[i].timestamp) <= clock && fired < 12) {
      director.onEntry(entries[i++]); fired++;
    }
    if (i >= entries.length) {
      feed.note("replay complete — switching to live");
      $("#mode-seg [data-mode=live]").click();
      replayState.on = false;
    }
  };
  requestAnimationFrame(step);
}

function startDemoMode() {
  $("#watching").textContent = "demo — synthetic traffic";
  demo = new Demo(director);
  setTimeout(() => demo.cycle(), 600);
}
$("#demo-task").addEventListener("click", () => demo && demo.injectTask());
$("#demo-fail").addEventListener("click", () => demo && demo.failOne());
$("#demo-hold").addEventListener("click", () => demo && demo.hold());

/* ── boot ───────────────────────────────────────────────────────────── */
world = new World($("#scene"));
feed = new Feed($("#feed"));
director = new Director(world, feed, hud);
refreshWeather();
setInterval(refreshWeather, 10 * 60 * 1000);
setInterval(() => hud.tick(), 500);
hud.tick();
setMode("live");

/* main atmosphere loop */
let lastT = performance.now();
(function atmosphere() {
  requestAnimationFrame(atmosphere);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  updateEnvironment(dt);
  renderOverlay(dt);
  updateCloudShadows(dt);
  tickAudio(dt);
  if (audio.ctx) audio.apply();
})();
