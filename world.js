/* tl — world.js
   The 4-way intersection diorama. Top-down world rendered to a square canvas
   (the page tilts it into a GTA-map-like plane with CSS).

   Everything static is baked once into offscreen canvases (asphalt speckle,
   concrete expansion joints, roof gravel, worn tire tracks, baked AO at curbs);
   everything dynamic (cars, signals, weather grading, lights) is cheap per-frame.

   Mapping (the whole point):
     unit car  = a Claude Code task / request
     red       = waiting on a result (usually a permission prompt)
     yellow    = working — speed tracks progress
     green     = done — the car drives through, lane opens for the next task
     crash     = a tool call failed
     queue     = task backlog
   Civilian cars are ambient life — they obey the lights but carry no meaning. */

"use strict";

/* ── constants (world px; canvas is 2200², world spans ±1100) ───────── */
const SCENE_SIZE = 2200;
const HALF = SCENE_SIZE / 2;
const EDGE = 980;          // spawn / despawn (always offscreen at 115vmax cover)
const LANE = 38;           // lane center offset from road centerline
const ROADHALF = 64;       // asphalt half-width
const CROSS_IN = 64;       // where the box starts
const CROSS_OUT = 84;      // sidewalk inner edge
const STOPLINE = 94;       // stop line distance
const RIGHT_R = 26, LEFT_R = 76;
const CAR_L = 34, CAR_W = 16;

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => (t = clamp(t, 0, 1), t * t * (3 - 2 * t));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── geometry: route segments ───────────────────────────────────────── */
function segLine(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  return { line: true, x0, y0, x1, y1, dx: dx / len, dy: dy / len, len };
}
function segArc(cx, cy, r, a0, da) {
  return { line: false, cx, cy, r, a0, da, len: Math.abs(da) * r };
}
function segPoint(sg, s) {
  if (sg.line) return { x: sg.x0 + sg.dx * s, y: sg.y0 + sg.dy * s };
  const a = sg.a0 + sg.da * (s / sg.len);
  return { x: sg.cx + sg.r * Math.cos(a), y: sg.cy + sg.r * Math.sin(a) };
}
function segHeading(sg, s) {
  if (sg.line) return { x: sg.dx, y: sg.dy };
  const a = sg.a0 + sg.da * (s / sg.len), g = Math.sign(sg.da);
  return { x: -Math.sin(a) * g, y: Math.cos(a) * g };
}
function rotPt(p, i) { // rotate by i·90° (screen clockwise): (x,y) → (−y,x)
  let { x, y } = p;
  for (let k = 0; k < i; k++) { const t = x; x = -y; y = t; }
  return { x, y };
}
/* canonical approach 0 = enters from the north edge, drives south (+y).
   maneuvers built there, then rotated for approaches 1..3. */
function buildRoute(approach, maneuver) {
  const L0 = segLine(-LANE, -EDGE, -LANE, -STOPLINE);
  let segs;
  if (maneuver === "right") {
    segs = [
      L0,
      segLine(-LANE, -STOPLINE, -LANE, -CROSS_IN),
      segArc(-(LANE + RIGHT_R), -CROSS_IN, RIGHT_R, 0, Math.PI / 2),
      segLine(-(CROSS_IN), -LANE, -EDGE, -LANE),
    ];
  } else if (maneuver === "left") {
    segs = [
      L0,
      segLine(-LANE, -STOPLINE, -LANE, -LANE),
      segArc(LANE, -LANE, LEFT_R, Math.PI, -Math.PI / 2),
      segLine(LANE, LANE, EDGE, LANE),
    ];
  } else {
    segs = [L0, segLine(-LANE, -STOPLINE, -LANE, EDGE)];
  }
  if (approach) {
    segs = segs.map(sg => {
      if (sg.line) {
        const a = rotPt({ x: sg.x0, y: sg.y0 }, approach), b = rotPt({ x: sg.x1, y: sg.y1 }, approach);
        return segLine(a.x, a.y, b.x, b.y);
      }
      const c = rotPt({ x: sg.cx, y: sg.cy }, approach);
      // rotate the start angle too — the arc must stay tangent to its lanes
      return segArc(c.x, c.y, sg.r, sg.a0 + approach * Math.PI / 2, sg.da);
    });
  }
  const total = segs.reduce((n, s) => n + s.len, 0);
  const stopS = segs[0].len - CAR_L / 2 - 6;
  const boxS = stopS; // distance at which the car is at the stop line
  return { segs, total, stopS, boxS, maneuver, approach };
}
function routePose(route, s) {
  s = clamp(s, 0, route.total);
  for (const sg of route.segs) {
    if (s <= sg.len + 0.001) return { seg: sg, ...segPoint(sg, s), h: segHeading(sg, s) };
    s -= sg.len;
  }
  const sg = route.segs[route.segs.length - 1];
  return { seg: sg, ...segPoint(sg, sg.len), h: segHeading(sg, sg.len) };
}

/* ── palettes ───────────────────────────────────────────────────────── */
const CAR_COLORS = [
  "#b9bdc4", "#2a2c31", "#dfe1e4", "#8f2f33", "#31507f", "#6b7076",
  "#494b50", "#9c8f5c", "#37545e", "#c7c2b8",
];
const CLAUDE_COLORS = ["#dfe6f2", "#c9d6ec", "#e8e2d2"]; // task cars read lighter

/* ── the world ──────────────────────────────────────────────────────── */
class World {
  constructor(canvas) {
    this.cv = canvas;
    this.cv.width = this.cv.height = SCENE_SIZE;
    this.ctx = canvas.getContext("2d");
    this.rng = mulberry32(20260901);

    this.unitCars = new Map();     // unitId → Car (Claude work)
    this.staging = [];             // units waiting for lane room
    this.civilians = [];
    this.particles = [];
    this.decals = [];              // skid marks
    this.time = 0;
    this.stats = { through: 0, crashed: 0, active: 0, queued: 0 };
    this.civTimer = 2;
    this.civCycle = { phase: 0, t: 0 }; // 0 NS green, 1 yellow, 2 EW green, 3 yellow
    this.approachUse = [0, 0, 0, 0];    // round-robin for unit lanes
    this.flash = 0;                // lightning
    this.lighting = { day: 1, night: 0, warm: 0, wet: 0, snow: 0, fog: 0, lightsOn: false, cloudShadows: [], shadow: { x: 0.4, y: 0.5, len: 14 } };
    this.signals = ["green", "green", "green", "green"];

    this.bake();
    requestAnimationFrame(() => this.frame());
    this._last = performance.now();
    this._acc = 0;
    this.paused = false;
  }

  /* ══ baking: the static world ══════════════════════════════════════ */
  bake() {
    const rng = mulberry32(777);
    const g = this.ctx;
    const W = SCENE_SIZE;
    const wx = x => HALF + x, wy = y => HALF + y; // world → canvas

    const ground = document.createElement("canvas");
    ground.width = ground.height = W;
    const c = ground.getContext("2d");
    this.groundCv = ground;
    this.buildings = [];
    this.trees = [];
    this.lamps = [];

    /* — grass base + texture — */
    c.fillStyle = "#4a5940";
    c.fillRect(0, 0, W, W);
    for (let i = 0; i < 16000; i++) {
      const x = rng() * W, y = rng() * W;
      c.fillStyle = rng() < 0.5 ? "rgba(30,42,24,0.25)" : "rgba(120,138,96,0.16)";
      c.fillRect(x, y, 1 + rng() * 2.4, 1 + rng() * 1.6);
    }
    for (let i = 0; i < 26; i++) { // mowing / patch variation
      c.fillStyle = `rgba(${60 + rng() * 40 | 0},${80 + rng() * 40 | 0},${50 + rng() * 30 | 0},0.07)`;
      c.beginPath();
      c.ellipse(rng() * W, rng() * W, 90 + rng() * 200, 60 + rng() * 150, rng() * TAU, 0, TAU);
      c.fill();
    }

    /* — sidewalk blocks in the 4 quadrants (rounded inner corner) — */
    const SIDE = wx(CROSS_OUT); // 816: blocks span 0..SIDE on their inner axes
    const quads = [ // [x, y, corner-radii order: tl, tr, br, bl] — round the corner nearest the intersection
      [0, 0, [0, 0, 24, 0]],
      [wx(CROSS_OUT), 0, [0, 0, 0, 24]],
      [wx(CROSS_OUT), wy(CROSS_OUT), [24, 0, 0, 0]],
      [0, wy(CROSS_OUT), [0, 24, 0, 0]],
    ];
    this.quadPaths = [];
    for (const [qx, qy, radii] of quads) {
      const p = new Path2D();
      p.roundRect(qx, qy, SIDE, SIDE, radii);
      this.quadPaths.push(p);
      c.fillStyle = "#8b8781"; // concrete
      c.fill(p);
      const sx = qx === 0 ? -1 : 1, sy = qy === 0 ? -1 : 1;
      // expansion joints
      c.save(); c.clip(p);
      c.strokeStyle = "rgba(60,58,54,0.35)"; c.lineWidth = 1;
      for (let v = CROSS_OUT; v < HALF - 40; v += 46) {
        const jx = wx(sx * v), jy = wy(sy * v);
        c.beginPath(); c.moveTo(jx, qy); c.lineTo(jx, qy === 0 ? SIDE : SCENE_SIZE); c.stroke();
        c.beginPath(); c.moveTo(qx, jy); c.lineTo(qx === 0 ? SIDE : SCENE_SIZE, jy); c.stroke();
      }
      // curb shadow (baked AO against asphalt) + curb face
      c.strokeStyle = "rgba(40,38,36,0.5)"; c.lineWidth = 3;
      c.beginPath(); c.moveTo(wx(sx * CROSS_OUT), wy(sy * CROSS_OUT)); c.lineTo(wx(sx * CROSS_OUT), wy(sy * (HALF - 30))); c.stroke();
      c.beginPath(); c.moveTo(wx(sx * CROSS_OUT), wy(sy * CROSS_OUT)); c.lineTo(wx(sx * (HALF - 30)), wy(sy * CROSS_OUT)); c.stroke();
      c.restore();
    }

    /* — asphalt: N-S and E-W strips — */
    const road = (horiz) => {
      c.save();
      c.beginPath();
      if (horiz) c.rect(0, wy(-ROADHALF), W, ROADHALF * 2);
      else c.rect(wx(-ROADHALF), 0, ROADHALF * 2, W);
      c.clip();
      c.fillStyle = "#4a4a4e";
      c.fillRect(0, 0, W, W);
      // aggregate speckle
      for (let i = 0; i < 24000; i++) {
        const x = rng() * W, y = rng() * W;
        const l = rng();
        c.fillStyle = l < 0.4 ? "rgba(20,20,22,0.3)" : l < 0.8 ? "rgba(110,110,116,0.22)" : "rgba(160,160,166,0.14)";
        c.fillRect(x, y, 1 + rng() * 1.4, 1 + rng() * 1.2);
      }
      // tar patches & cracks
      for (let i = 0; i < 10; i++) {
        c.fillStyle = "rgba(24,24,26,0.16)";
        c.beginPath();
        c.ellipse(rng() * W, rng() * W, 20 + rng() * 60, 8 + rng() * 24, rng() * TAU, 0, TAU);
        c.fill();
      }
      c.strokeStyle = "rgba(22,22,24,0.28)"; c.lineWidth = 1.2;
      for (let i = 0; i < 14; i++) {
        let x = rng() * W, y = rng() * W;
        c.beginPath(); c.moveTo(x, y);
        for (let k = 0; k < 5; k++) { x += (rng() - 0.5) * 40; y += (rng() - 0.5) * 40; c.lineTo(x, y); }
        c.stroke();
      }
      // worn tire tracks (two darker bands per lane)
      c.fillStyle = "rgba(28,28,30,0.10)";
      for (const dir of [-1, 1]) {
        for (const off of [-8, 8]) {
          if (horiz) c.fillRect(0, wy(dir * LANE + off) - 5, W, 10);
          else c.fillRect(wx(dir * LANE + off) - 5, 0, 10, W);
        }
      }
      c.restore();
    };
    road(false); road(true);

    /* — markings — */
    const paint = "rgba(224,224,228,0.82)", yellow = "rgba(214,164,58,0.9)";
    // double yellow centerlines (outside the box)
    for (const [a, b] of [[-HALF + 60, -CROSS_OUT], [CROSS_OUT, HALF - 60]]) {
      for (const off of [-2.5, 2.5]) {
        c.strokeStyle = yellow; c.lineWidth = 2.2;
        c.beginPath(); c.moveTo(wx(off), wy(a)); c.lineTo(wx(off), wy(b)); c.stroke();
        c.beginPath(); c.moveTo(wx(a), wy(off)); c.lineTo(wx(b), wy(off)); c.stroke();
      }
      // white edge lines
      c.strokeStyle = paint; c.lineWidth = 2;
      for (const off of [-(ROADHALF - 4), ROADHALF - 4]) {
        c.beginPath(); c.moveTo(wx(off), wy(a)); c.lineTo(wx(off), wy(b)); c.stroke();
        c.beginPath(); c.moveTo(wx(a), wy(off)); c.lineTo(wx(b), wy(off)); c.stroke();
      }
    }
    // stop bars — only across the INCOMING lane of each approach
    c.fillStyle = paint;
    c.fillRect(wx(-ROADHALF + 2), wy(-STOPLINE), ROADHALF - 6, 5);  // from north, SB lane x∈[−64,0]
    c.fillRect(wx(4), wy(STOPLINE - 5), ROADHALF - 6, 5);          // from south, NB lane x∈[0,64]
    c.fillRect(wx(STOPLINE - 5), wy(-ROADHALF + 2), 5, ROADHALF - 6); // from east, WB lane y∈[−64,0]
    c.fillRect(wx(-STOPLINE), wy(4), 5, ROADHALF - 6);             // from west, EB lane y∈[0,64]
    // crosswalks (zebra) across each road, just outside the box
    for (let x = -ROADHALF + 8; x < ROADHALF - 8; x += 13) {
      c.fillRect(wx(x) - 4, wy(-CROSS_OUT), 8, 18); // north side
      c.fillRect(wx(x) - 4, wy(CROSS_IN), 8, 18);   // south side
    }
    for (let y = -ROADHALF + 8; y < ROADHALF - 8; y += 13) {
      c.fillRect(wx(-CROSS_OUT), wy(y) - 4, 18, 8); // west side
      c.fillRect(wx(CROSS_IN), wy(y) - 4, 18, 8);   // east side
    }
    // manholes
    for (const [mx, my] of [[-LANE - 10, 220], [LANE + 8, -320], [300, LANE + 10]]) {
      c.fillStyle = "rgba(30,30,32,0.85)";
      c.beginPath(); c.arc(wx(mx), wy(my), 5, 0, TAU); c.fill();
      c.strokeStyle = "rgba(90,90,94,0.8)"; c.lineWidth = 1.2;
      c.beginPath(); c.arc(wx(mx), wy(my), 5, 0, TAU); c.stroke();
    }

    /* — quadrant contents — */
    // NE / SE / NW: buildings; SW: park
    const addBuilding = (x, y, w, h, storeSide) => {
      const roof = ["#6f6a63", "#7b746b", "#635f5a", "#807767", "#565458", "#756d60"][Math.floor(rng() * 6)];
      const b = { x, y, w, h, roof, storeSide, ac: [], lit: [] };
      const n = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++)
        b.ac.push({ x: x + 14 + rng() * (w - 34), y: y + 12 + rng() * (h - 30), s: 8 + rng() * 8 });
      // storefront windows along the street-facing edge (lit at night)
      const edge = storeSide === "S" ? [x + 8, y + h - 7, 1] : storeSide === "W" ? [x + 1, y + 8, 2] : storeSide === "E" ? [x + w - 7, y + 8, 3] : [x + 8, y + 1, 4];
      const along = (storeSide === "S" || storeSide === "N") ? w : h;
      for (let p = 10; p < along - 12; p += 16) {
        b.lit.push({ side: storeSide, p, on: rng() < 0.42 });
      }
      this.buildings.push(b);
      // draw roof
      c.fillStyle = roof;
      c.fillRect(wx(x), wy(y), w, h);
      // gravel texture
      c.save();
      c.beginPath(); c.rect(wx(x), wy(y), w, h); c.clip();
      for (let i = 0; i < w * h / 30; i++) {
        c.fillStyle = rng() < 0.5 ? "rgba(0,0,0,0.14)" : "rgba(255,255,255,0.08)";
        c.fillRect(wx(x) + rng() * w, wy(y) + rng() * h, 1.4, 1.4);
      }
      c.restore();
      // parapet
      c.strokeStyle = "rgba(20,20,20,0.55)"; c.lineWidth = 2.5;
      c.strokeRect(wx(x) + 1, wy(y) + 1, w - 2, h - 2);
      c.strokeStyle = "rgba(255,255,255,0.10)"; c.lineWidth = 1;
      c.strokeRect(wx(x) + 3.5, wy(y) + 3.5, w - 7, h - 7);
      // AC units
      for (const u of b.ac) {
        c.fillStyle = "#9aa0a6";
        c.fillRect(wx(u.x), wy(u.y), u.s, u.s);
        c.strokeStyle = "rgba(0,0,0,0.4)"; c.lineWidth = 1;
        c.strokeRect(wx(u.x), wy(u.y), u.s, u.s);
        c.beginPath(); c.arc(wx(u.x + u.s / 2), wy(u.y + u.s / 2), u.s * 0.3, 0, TAU); c.stroke();
      }
      // baked AO at building base
      c.save();
      c.globalAlpha = 0.5;
      c.strokeStyle = "rgba(15,15,15,0.5)"; c.lineWidth = 7;
      c.strokeRect(wx(x) - 2, wy(y) - 2, w + 4, h + 4);
      c.restore();
      void edge;
    };
    addBuilding(-640, -640, 230, 190, "S");
    addBuilding(-350, -560, 150, 130, "S");
    addBuilding(-620, -330, 180, 150, "E");
    addBuilding(150, -660, 250, 180, "S");
    addBuilding(470, -600, 200, 160, "S");
    addBuilding(180, -350, 190, 150, "W");
    addBuilding(170, 240, 240, 180, "N");
    addBuilding(500, 330, 190, 210, "N");
    addBuilding(210, 520, 180, 140, "W");
    // SW park
    const px0 = CROSS_OUT + 4, py0 = CROSS_OUT + 4, px1 = 760, py1 = 760;
    c.fillStyle = "#41603a";
    c.fillRect(wx(-px1), wy(py0), px1 - px0, py1 - py0);
    for (let i = 0; i < 9000; i++) {
      const x = wx(-px1 + rng() * (px1 - px0)), y = wy(py0 + rng() * (py1 - py0));
      c.fillStyle = rng() < 0.5 ? "rgba(24,40,20,0.3)" : "rgba(120,150,90,0.2)";
      c.fillRect(x, y, 1.5, 1.2);
    }
    // looping path
    c.strokeStyle = "rgba(160,150,130,0.85)"; c.lineWidth = 7;
    c.beginPath(); c.ellipse(wx(-460), wy(470), 230, 200, 0, 0, TAU); c.stroke();
    c.strokeStyle = "rgba(70,64,54,0.4)"; c.lineWidth = 1;
    c.beginPath(); c.ellipse(wx(-460), wy(470), 226, 196, 0, 0, TAU); c.stroke();

    /* — trees — */
    const treeAt = (x, y, s) => this.trees.push({ x, y, s: s || 1, ph: rng() * TAU, v: Math.floor(rng() * 3) });
    for (let i = 0; i < 7; i++) treeAt(-700 + rng() * 520, 140 + rng() * 560, 0.9 + rng() * 0.5);
    treeAt(-460, 470, 1.15);
    treeAt(-330, 330, 0.95);
    treeAt(-600, 620, 1.0);
    treeAt(120, -820, 1.0); treeAt(-140, -830, 0.9);
    treeAt(830, -120, 1.0); treeAt(-840, -600, 0.95);
    treeAt(820, 700, 1.05); treeAt(-830, 700, 0.9);
    // canopy sprites
    this.canopy = [];
    for (let v = 0; v < 3; v++) {
      const t = document.createElement("canvas");
      t.width = t.height = 72;
      const tc = t.getContext("2d");
      const r2 = mulberry32(100 + v * 17);
      const blob = (dx, dy, r, col) => { tc.fillStyle = col; tc.beginPath(); tc.arc(36 + dx, 36 + dy, r, 0, TAU); tc.fill(); };
      blob(0, 0, 26, "#2c3d24");
      for (let i = 0; i < 7; i++) blob((r2() - 0.5) * 26, (r2() - 0.5) * 26, 8 + r2() * 9, "#37502c");
      for (let i = 0; i < 6; i++) blob((r2() - 0.5) * 18, (r2() - 0.5) * 18, 5 + r2() * 7, "#466137");
      for (let i = 0; i < 90; i++) {
        tc.fillStyle = r2() < 0.5 ? "rgba(20,32,16,0.5)" : "rgba(110,140,80,0.4)";
        tc.fillRect(36 + (r2() - 0.5) * 44, 36 + (r2() - 0.5) * 44, 1.6, 1.4);
      }
      this.canopy.push(t);
    }

    /* — signal poles + mast arms (baked), lamps — */
    for (let a = 0; a < 4; a++) {
      const pole = rotPt({ x: -(CROSS_OUT + 16), y: CROSS_OUT + 16 }, a);
      const head = rotPt({ x: -LANE, y: CROSS_OUT + 12 }, a);
      this["sig" + a] = { pole, head };
      c.strokeStyle = "#2c2c2e"; c.lineWidth = 4.5;
      c.beginPath(); c.moveTo(wx(pole.x), wy(pole.y)); c.lineTo(wx(head.x), wy(head.y)); c.stroke();
      c.strokeStyle = "rgba(255,255,255,0.14)"; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(wx(pole.x), wy(pole.y) - 1); c.lineTo(wx(head.x), wy(head.y) - 1); c.stroke();
      c.fillStyle = "#232325";
      c.beginPath(); c.arc(wx(pole.x), wy(pole.y), 5.5, 0, TAU); c.fill();
    }
    for (const [lx, ly] of [[ROADHALF + 8, -330], [-(ROADHALF + 8), -330], [ROADHALF + 8, 330], [-(ROADHALF + 8), 330], [-330, -(ROADHALF + 8)], [-330, ROADHALF + 8], [330, -(ROADHALF + 8)], [330, ROADHALF + 8]]) {
      this.lamps.push({ x: lx, y: ly });
      c.fillStyle = "#26262a";
      c.beginPath(); c.arc(wx(lx), wy(ly), 3.2, 0, TAU); c.fill();
    }
  }

  /* ══ public API for the session director ═══════════════════════════ */
  spawnUnit(id, label, kind) {
    // pick the least-recently used approach
    let a = 0, best = Infinity;
    for (let i = 0; i < 4; i++) if (this.approachUse[i] < best) { best = this.approachUse[i]; a = i; }
    this.approachUse[a]++;
    const maneuver = (r => r < 0.55 ? "straight" : r < 0.78 ? "right" : "left")(Math.random());
    const unit = { id, label, kind: kind || "turn", progress: 0, rate: 0.4, state: "running", approach: a, spawnedAt: this.time };
    this.trySpawn(unit);
    this.unitCars.set(id, unit);
    if (unit.car) unit.car.unit = unit;
    return unit;
  }
  trySpawn(unit) {
    // don't spawn on top of someone: check lane start
    const busy = this.carsOnApproach(unit.approach).some(c => c.s < 90);
    if (busy) { if (!this.staging.includes(unit)) this.staging.push(unit); unit.state = unit.state === "held" ? "held" : "queued"; return false; }
    const r = Math.random();
    const maneuver = r < 0.55 ? "straight" : r < 0.78 ? "right" : "left";
    unit.car = new Car(this, unit, buildRoute(unit.approach, maneuver), unit.kind === "task");
    unit.state = unit.state === "held" ? "held" : "running";
    this.staging = this.staging.filter(u => u !== unit);
    return true;
  }
  setProgress(id, p, rate) {
    const u = this.unitCars.get(id); if (!u) return;
    u.progress = clamp(p, 0, 1);
    if (rate !== undefined) u.rate = lerp(u.rate, clamp(rate, 0, 1), 0.3);
  }
  holdUnit(id) { const u = this.unitCars.get(id); if (u) { u.state = "held"; if (u.car) u.car.held = true; } }
  resumeUnit(id) { const u = this.unitCars.get(id); if (u && u.state !== "released") { u.state = "running"; if (u.car) u.car.held = false; } }
  releaseUnit(id) {
    const u = this.unitCars.get(id); if (!u) return;
    u.state = "released"; u.progress = 1;
    if (u.car) {
      u.car.held = false;
      if (u.car.state === "wreck" || u.car.state === "crashing") u.car.towed = true; // tow the wreck
      else u.car.released = true;
    }
    this.approachUse[u.approach]--;
  }
  setQueued(id) { const u = this.unitCars.get(id); if (u && (u.state === "running")) u.state = "queued"; }
  crashUnit(id) {
    const u = this.unitCars.get(id); if (!u || !u.car) return;
    u.state = "crashed"; this.stats.crashed++;
    u.car.startCrash();
  }
  retryUnit(id) { // a later tool in the same unit succeeded — car gets going again
    const u = this.unitCars.get(id); if (!u || !u.car) return;
    u.state = "running";
    u.car.revive();
  }
  towUnit(id) {
    const u = this.unitCars.get(id); if (!u) return;
    u.state = "towed";
    if (u.car) u.car.towed = true;
    this.approachUse[u.approach]--;
  }
  clearUnits() {
    for (const u of this.unitCars.values()) if (u.car) u.car.towed = true;
    this.unitCars.clear(); this.staging = [];
    this.approachUse = [0, 0, 0, 0];
  }

  carsOnApproach(a) {
    const out = [];
    for (const u of this.unitCars.values()) if (u.car && u.approach === a) out.push(u.car);
    for (const c of this.civilians) if (c.route.approach === a) out.push(c);
    return out;
  }

  /* ══ simulation ════════════════════════════════════════════════════ */
  frame() {
    const now = performance.now();
    let dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    if (!this.paused) {
      this._acc += dt;
      const step = 1 / 60;
      while (this._acc >= step) { this.update(step); this._acc -= step; }
    }
    this.render();
    requestAnimationFrame(() => this.frame());
  }

  update(dt) {
    this.time += dt;
    this.flash = Math.max(0, this.flash - dt * 2.5);

    // signal resolution
    this.updateSignals(dt);

    // staging retry
    for (const u of [...this.staging]) this.trySpawn(u);

    // unit cars
    this.stats.active = 0; this.stats.queued = this.staging.length;
    for (const [id, u] of [...this.unitCars]) {
      if (u.state === "running" || u.state === "held") this.stats.active++;
      if (u.car) {
        const alive = u.car.update(dt, this);
        if (!alive) { this.unitCars.delete(id); if (u.state === "released") this.stats.through++; }
      }
    }

    // civilians
    this.civTimer -= dt;
    if (this.civTimer <= 0 && this.civilians.length < 7) {
      this.civTimer = 2.2 + Math.random() * 5;
      const a = Math.floor(Math.random() * 4);
      if (!this.carsOnApproach(a).some(c => c.s < 120)) {
        const r = Math.random();
        this.civilians.push(new Car(this, null, buildRoute(a, r < 0.5 ? "straight" : r < 0.75 ? "right" : "left"), false));
      }
    }
    this.civilians = this.civilians.filter(c => c.update(dt, this));

    // particles
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.type === "smoke") { p.r += dt * 14; p.vx *= 0.98; p.vy *= 0.98; }
      if (p.type === "splash") p.life -= dt * 2;
    }
    this.particles = this.particles.filter(p => p.life > 0);
    if (this.particles.length > 400) this.particles.splice(0, this.particles.length - 400);

    // decals fade
    for (const d of this.decals) d.a -= dt * 0.02;
    this.decals = this.decals.filter(d => d.a > 0);
    if (this.decals.length > 500) this.decals.splice(0, this.decals.length - 500);

    // rain splashes on the road
    const L = this.lighting;
    if (L.wet > 0.4 && Math.random() < dt * 24) {
      const horiz = Math.random() < 0.5;
      const x = horiz ? (Math.random() * 2 - 1) * 900 : (Math.random() < 0.5 ? -1 : 1) * Math.random() * ROADHALF;
      const y = horiz ? (Math.random() < 0.5 ? -1 : 1) * Math.random() * ROADHALF : (Math.random() * 2 - 1) * 900;
      this.particles.push({ type: "splash", x, y, vx: 0, vy: 0, r: 1 + Math.random() * 2, life: 0.25, a: 0.2 });
    }
  }

  updateSignals(dt) {
    // cycle timing for civilians: NS green 8s, yellow 1.6s, EW green 8s, yellow 1.6s
    const cyc = this.civCycle;
    cyc.t += dt;
    const dur = [8, 1.6, 8, 1.6][cyc.phase];
    if (cyc.t > dur) { cyc.phase = (cyc.phase + 1) % 4; cyc.t = 0; }

    // unit-driven overrides: a unit's own approach shows its state;
    // every other approach keeps the normal civilian cycle.
    const override = [null, null, null, null];
    for (const u of this.unitCars.values()) {
      if (u.state === "towed") continue;
      const a = u.approach;
      if (u.state === "released") {
        if (u.car && !u.car.done) override[a] = "green"; // clear the box
        continue;
      }
      if (u.state === "held" || u.state === "crashed" || u.state === "queued") override[a] = "red";
      else if (override[a] !== "red") override[a] = "yellow";
    }

    for (let a = 0; a < 4; a++) {
      if (override[a]) { this.signals[a] = override[a]; continue; }
      const ns = cyc.phase === 0 ? "green" : cyc.phase === 1 ? "yellow" : "red";
      const ew = cyc.phase === 2 ? "green" : cyc.phase === 3 ? "yellow" : "red";
      this.signals[a] = (a === 0 || a === 2) ? ns : ew;
    }
  }

  boxOccupied(forCar) {
    // simple reservation: at most one car from a conflicting approach inside the box
    const mine = forCar.route.approach;
    const myStraight = forCar.route.maneuver === "straight";
    for (const u of this.unitCars.values()) {
      if (!u.car || u.car === forCar || u.car.done) continue;
      const c = u.car;
      if (c.inside) {
        const opp = (c.route.approach + 2) % 4 === mine;
        if (!(opp && myStraight && c.route.maneuver === "straight")) return true;
      }
    }
    for (const c of this.civilians) {
      if (c === forCar || c.done) continue;
      if (c.inside) {
        const opp = (c.route.approach + 2) % 4 === mine;
        if (!(opp && myStraight && c.route.maneuver === "straight")) return true;
      }
    }
    return false;
  }

  /* ══ rendering ═════════════════════════════════════════════════════ */
  render() {
    const c = this.ctx, L = this.lighting;
    const night = Math.min(L.night, 1 - this.flash * 0.85);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, SCENE_SIZE, SCENE_SIZE);
    c.drawImage(this.groundCv, 0, 0);
    const wx = x => HALF + x, wy = y => HALF + y;

    /* sun shadows (direction + length from the real sun) */
    if (L.day > 0.06) {
      const { x: sx, y: sy, len } = L.shadow;
      c.fillStyle = `rgba(12,14,20,${0.34 * L.day})`;
      for (const b of this.buildings) {
        c.save();
        c.translate(wx(b.x + b.w / 2) - (b.w / 2), wy(b.y + b.h / 2) - (b.h / 2));
        c.beginPath();
        // project the building silhouette along the shadow vector
        const pts = [[0, 0], [b.w, 0], [b.w, b.h], [0, b.h]];
        const ox = sx * len * 0.9, oy = sy * len * 0.9;
        c.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < 4; i++) c.lineTo(pts[i][0], pts[i][1]);
        for (let i = 3; i >= 0; i--) c.lineTo(pts[i][0] + ox, pts[i][1] + oy);
        c.closePath(); c.fill();
        c.restore();
      }
      for (const t of this.trees) {
        c.beginPath();
        c.ellipse(wx(t.x) + sx * len * 0.5, wy(t.y) + sy * len * 0.5, 20 * t.s, 15 * t.s, 0, 0, TAU);
        c.fill();
      }
    }

    /* snow cover */
    if (L.snow > 0.03) {
      c.fillStyle = `rgba(235,240,248,${0.5 * L.snow})`;
      for (const p of this.quadPaths) c.fill(p);
      c.strokeStyle = `rgba(235,240,248,${0.35 * L.snow})`;
      c.lineWidth = 6;
      c.strokeRect(wx(-ROADHALF), wy(-ROADHALF), ROADHALF * 2, ROADHALF * 2);
    }

    /* wet asphalt sheen */
    if (L.wet > 0.03) {
      c.save();
      c.globalAlpha = 0.2 * L.wet;
      c.globalCompositeOperation = "multiply";
      c.fillStyle = "#5a6a80";
      c.fillRect(wx(-ROADHALF), 0, ROADHALF * 2, SCENE_SIZE);
      c.fillRect(0, wy(-ROADHALF), SCENE_SIZE, ROADHALF * 2);
      c.restore();
    }

    /* skid decals */
    for (const d of this.decals) {
      c.strokeStyle = `rgba(15,15,17,${d.a})`;
      c.lineWidth = d.w;
      c.beginPath(); c.moveTo(wx(d.x1), wy(d.y1)); c.lineTo(wx(d.x2), wy(d.y2)); c.stroke();
    }

    /* trees (sway with the real wind) */
    const windAmp = Math.min(4, (L.windSpeed || 0) / 12);
    for (const t of this.trees) {
      const sway = Math.sin(this.time * 0.9 + t.ph) * windAmp + (L.windX || 0) * 1.5;
      c.save();
      c.translate(wx(t.x) + sway, wy(t.y));
      c.rotate(sway * 0.004);
      c.drawImage(this.canopy[t.v], -36 * t.s, -36 * t.s, 72 * t.s, 72 * t.s);
      c.restore();
    }

    /* cars: civilians first, unit cars on top */
    const drawList = [...this.civilians, ...[...this.unitCars.values()].map(u => u.car).filter(Boolean)];
    drawList.sort((a, b) => a.pose.y - b.pose.y);
    for (const car of drawList) car.draw(c, L, night, this);

    /* drifting cloud shadows — the real cloud cover, pushed by the real wind */
    if (L.cloudShadows && L.cloudShadows.length && L.day > 0.05) {
      c.save();
      for (const cs of L.cloudShadows) {
        const gr = c.createRadialGradient(0, 0, cs.r * 0.1, 0, 0, cs.r);
        gr.addColorStop(0, `rgba(8,12,20,${cs.a * L.day})`);
        gr.addColorStop(1, "rgba(8,12,20,0)");
        c.save();
        c.translate(wx(cs.x), wy(cs.y));
        c.rotate(cs.rot);
        c.scale(1, 0.62);
        c.fillStyle = gr;
        c.beginPath(); c.arc(0, 0, cs.r, 0, TAU); c.fill();
        c.restore();
      }
      c.restore();
    }

    /* signals */
    for (let a = 0; a < 4; a++) this.drawSignal(c, a, night);

    /* additive light pass: lamps, headlights, storefronts, signal glow */
    c.save();
    c.globalCompositeOperation = "lighter";
    const k = Math.max(night, L.fog * 0.6, L.wet * 0.4);
    if (k > 0.02) {
      // street lamp pools
      for (const lp of this.lamps) {
        const r = 95 * (1 + L.wet * 0.3);
        const gr = c.createRadialGradient(wx(lp.x), wy(lp.y), 4, wx(lp.x), wy(lp.y), r);
        gr.addColorStop(0, `rgba(255,196,120,${0.20 * k})`);
        gr.addColorStop(1, "rgba(255,196,120,0)");
        c.fillStyle = gr;
        c.beginPath(); c.arc(wx(lp.x), wy(lp.y), r, 0, TAU); c.fill();
      }
      // storefront windows
      for (const b of this.buildings) {
        for (const win of b.lit) {
          if (!win.on) continue;
          let x = 0, y = 0;
          if (b.storeSide === "S") { x = b.x + win.p; y = b.y + b.h - 3; }
          else if (b.storeSide === "N") { x = b.x + win.p; y = b.y + 3; }
          else if (b.storeSide === "W") { x = b.x + 3; y = b.y + win.p; }
          else { x = b.x + b.w - 3; y = b.y + win.p; }
          c.fillStyle = `rgba(255,208,130,${0.5 * k})`;
          c.fillRect(wx(x), wy(y), b.storeSide === "S" || b.storeSide === "N" ? 10 : 3, b.storeSide === "S" || b.storeSide === "N" ? 3 : 10);
        }
      }
    }
    for (const car of drawList) car.drawLights(c, L, night, this);
    // signal lamp glow
    const SIG = { red: [255, 69, 58], yellow: [255, 214, 10], green: [48, 209, 88] };
    for (let a = 0; a < 4; a++) {
      const col = SIG[this.signals[a]];
      const hd = this["sig" + a].head;
      for (const off of [-10, 0, 10]) {
        const on = (off === -10 && this.signals[a] === "red") || (off === 0 && this.signals[a] === "yellow") || (off === 10 && this.signals[a] === "green");
        if (!on || night < 0.12) continue;
        const gr = c.createRadialGradient(wx(hd.x), wy(hd.y + off), 1, wx(hd.x), wy(hd.y + off), 16);
        gr.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${0.5 * Math.max(night, 0.25)})`);
        gr.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
        c.fillStyle = gr;
        c.beginPath(); c.arc(wx(hd.x), wy(hd.y + off), 16, 0, TAU); c.fill();
      }
    }
    c.restore();

    /* color grading: night blue-multiply, golden-hour overlay, fog veil */
    if (night > 0.02) {
      c.save();
      c.globalCompositeOperation = "multiply";
      c.fillStyle = `rgba(56,72,120,${0.62 * night})`;
      c.fillRect(0, 0, SCENE_SIZE, SCENE_SIZE);
      c.restore();
    }
    if (L.warm > 0.02) {
      c.save();
      c.globalCompositeOperation = "overlay";
      c.fillStyle = `rgba(255,150,80,${0.35 * L.warm})`;
      c.fillRect(0, 0, SCENE_SIZE, SCENE_SIZE);
      c.restore();
    }
    if (L.fog > 0.02) {
      c.fillStyle = `rgba(190,198,208,${0.34 * L.fog})`;
      c.fillRect(0, 0, SCENE_SIZE, SCENE_SIZE);
    }

    /* particles */
    for (const p of this.particles) {
      if (p.type === "smoke") {
        c.fillStyle = `rgba(140,140,146,${0.16 * p.life})`;
        c.beginPath(); c.arc(wx(p.x), wy(p.y), p.r, 0, TAU); c.fill();
      } else if (p.type === "spark") {
        c.fillStyle = `rgba(255,180,80,${p.life * 2})`;
        c.fillRect(wx(p.x), wy(p.y), 2, 2);
      } else if (p.type === "splash") {
        c.strokeStyle = `rgba(200,214,230,${p.a * p.life * 4})`;
        c.lineWidth = 1;
        c.beginPath(); c.arc(wx(p.x), wy(p.y), p.r * (1 - p.life * 2), 0.4, 2.6); c.stroke();
      }
    }

    /* vignette */
    const vg = c.createRadialGradient(HALF, HALF, HALF * 0.55, HALF, HALF, HALF * 1.18);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.38)");
    c.fillStyle = vg;
    c.fillRect(0, 0, SCENE_SIZE, SCENE_SIZE);

    /* unit labels (crisp, above grading) */
    for (const u of this.unitCars.values()) {
      if (!u.car || u.car.done || u.car.fade <= 0.05) continue;
      u.car.drawLabel(c, u);
    }
  }

  drawSignal(c, a, night) {
    const { head } = this["sig" + a];
    const wx = x => HALF + x, wy = y => HALF + y;
    // backplate + 3 lamps, red on top
    c.save();
    c.translate(wx(head.x), wy(head.y));
    const ang = { 0: 0, 1: Math.PI / 2, 2: Math.PI, 3: -Math.PI / 2 }[a];
    c.rotate(ang); // plate long axis perpendicular to the approach it faces
    c.fillStyle = "#17181a";
    roundRect(c, -7, -17, 14, 34, 4);
    c.fill();
    c.strokeStyle = "rgba(214,164,58,0.55)"; c.lineWidth = 1;
    roundRect(c, -7, -17, 14, 34, 4);
    c.stroke();
    const lamps = [
      { y: -10, col: "#ff453a", on: this.signals[a] === "red" },
      { y: 0, col: "#ffd60a", on: this.signals[a] === "yellow" },
      { y: 10, col: "#30d158", on: this.signals[a] === "green" },
    ];
    for (const l of lamps) {
      c.fillStyle = l.on ? l.col : "rgba(40,42,46,0.9)";
      c.beginPath(); c.arc(0, l.y, 4.2, 0, TAU); c.fill();
      if (!l.on) { c.fillStyle = "rgba(0,0,0,0.25)"; c.beginPath(); c.arc(0, l.y, 2, 0, TAU); c.fill(); }
      void night;
    }
    c.restore();
  }

  smashAt(x, y) { // sparks + initial smoke
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * TAU, sp = 40 + Math.random() * 90;
      this.particles.push({ type: "spark", x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 1, life: 0.25 + Math.random() * 0.2 });
    }
    this.puffAt(x, y, 6);
  }
  puffAt(x, y, n) {
    for (let i = 0; i < n; i++) {
      this.particles.push({
        type: "smoke", x: x + (Math.random() - 0.5) * 8, y: y + (Math.random() - 0.5) * 8,
        vx: (Math.random() - 0.5) * 12, vy: (Math.random() - 0.5) * 12,
        r: 4 + Math.random() * 5, life: 1.2 + Math.random() * 1.5,
      });
    }
  }
}

/* ── car ────────────────────────────────────────────────────────────── */
class Car {
  constructor(world, unit, route, isTask) {
    this.world = world; this.unit = unit; this.route = route;
    this.s = 0; this.v = 26; this.len = CAR_L; this.wid = CAR_W;
    this.state = "drive";       // drive | crashing | wreck
    this.held = false; this.released = false; this.towed = false;
    this.done = false; this.inside = false;
    this.brake = false; this.fade = 0; this.fadeIn = true;
    this.cruise = isTask ? 42 : 52 + Math.random() * 18;
    this.color = isTask ? CLAUDE_COLORS[Math.floor(Math.random() * CLAUDE_COLORS.length)] : CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)];
    this.isTask = isTask;
    this.pose = routePose(route, 0);
    this.angle = Math.atan2(this.pose.h.y, this.pose.h.x);
    this.yaw = 0; this.spin = 0; this.crashT = 0; this.hazT = 0;
    this.lastSkid = 0;
  }

  targetS() {
    const r = this.route;
    if (this.state === "crashing" || this.state === "wreck") return this.s;
    if (!this.unit) return r.total + 60;          // civilians drive on through
    if (this.released || this.towed) return r.total + 60;
    if (this.held) return Math.min(this.s, r.stopS);
    const u = this.unit;
    // approach position tracks progress (never backwards, caps just shy of the line)
    const p = u ? clamp(u.progress, 0, 1) : 1;
    const pS = r.stopS * clamp(p * 1.04 + 0.03, 0.02, 0.995);
    this._pS = Math.max(this._pS ?? 0, pS);
    return this._pS;
  }

  update(dt, world) {
    this.fade = clamp(this.fade + (this.fadeIn ? dt : -dt) * 2, 0, 1);
    if (this.fade <= 0 && !this.fadeIn) return false;

    const r = this.route;

    if (this.state === "crashing") {
      this.crashT += dt;
      this.v = Math.max(0, this.v - 300 * dt);
      this.s += this.v * dt;
      this.yaw += this.spin * dt * Math.max(0, 1 - this.crashT);
      this.pose = routePose(r, this.s);
      if (world.time - this.lastSkid > 0.02 && this.v > 4) {
        this.lastSkid = world.time;
        const off = this.wid * 0.4, n = this.pose.h, t = { x: -n.y, y: n.x };
        for (const sgn of [-1, 1]) {
          world.decals.push({
            x1: this.pose.x + t.x * sgn * off, y1: this.pose.y + t.y * sgn * off,
            x2: this.pose.x + t.x * sgn * off - n.x * 3, y2: this.pose.y + t.y * sgn * off - n.y * 3,
            a: 0.5, w: 2.6,
          });
        }
      }
      if (this.crashT > 0.5 && this.state !== "wreck") { this.state = "wreck"; this.v = 0; }
      if (Math.random() < dt * 6) world.puffAt(this.pose.x, this.pose.y, 1);
      return true;
    }
    if (this.state === "wreck") {
      this.hazT += dt;
      if (Math.random() < dt * 0.7) world.puffAt(this.pose.x, this.pose.y, 1);
      if (this.towed && this.fade >= 1) this.fadeIn = false;
      return this.fade > 0 || !this.towed;
    }

    // follow / stop logic
    let tgt = this.targetS();
    let leader = null;
    for (const c of world.carsOnApproach(this.route.approach)) {
      if (c === this || c.s <= this.s) continue;
      if (!leader || c.s < leader.s) leader = c;
    }
    if (leader) tgt = Math.min(tgt, leader.s - leader.len - 12);
    // signal + box reservation — but only up to the stop line.
    // A car that has already committed never stops inside the box.
    if (this.s < this.route.stopS - 2) {
      const sig = world.signals[this.route.approach];
      const isUnit = this.unit && !this.released;
      if (!isUnit) { // civilians obey the light
        if (sig === "red" || (sig === "yellow" && this.v < 30)) tgt = Math.min(tgt, this.route.stopS);
      }
      if (this.s + 4 >= this.route.stopS && tgt > this.route.stopS && world.boxOccupied(this)) {
        tgt = this.route.stopS;
      }
    }

    const inBox = this.s > this.route.stopS - 2 && this.s < this.route.stopS + 150;
    this.inside = inBox;

    // speed limits
    let vLimit = this.cruise;
    if (this.released) vLimit = this.s < this.route.stopS ? 60 : this.inBoxZone() ? 110 : 230;
    else if (inBox) vLimit = 80;
    if (this.unit && !this.released) {
      const rate = this.unit.rate ?? 0.4;
      vLimit = Math.min(vLimit, lerp(16, 95, rate));
    }

    const dist = Math.max(0, tgt - this.s);
    let vT = Math.min(vLimit, Math.sqrt(2 * 210 * dist));
    if (dist < 1.5) vT = 0;
    const dv = vT - this.v;
    const acc = clamp(dv / Math.max(dt, 1e-4), -240, this.released ? 150 : 95);
    this.brake = acc < -40;
    this.v = Math.max(0, this.v + acc * dt);
    this.s += this.v * dt;
    this.pose = routePose(this.route, this.s);
    this.angle = Math.atan2(this.pose.h.y, this.pose.h.x) + this.yaw;

    // hard braking → skids
    if (this.brake && this.v > 60 && world.time - this.lastSkid > 0.03) {
      this.lastSkid = world.time;
      const off = this.wid * 0.42, n = this.pose.h, t = { x: -n.y, y: n.x };
      for (const sgn of [-1, 1]) world.decals.push({
        x1: this.pose.x + t.x * sgn * off, y1: this.pose.y + t.y * sgn * off,
        x2: this.pose.x + t.x * sgn * off - n.x * this.v * 0.02, y2: this.pose.y + t.y * sgn * off - n.y * this.v * 0.02,
        a: 0.22, w: 2,
      });
    }

    // blinker
    this.blinkOn = this.route.maneuver !== "straight" &&
      (this.s > this.route.stopS - 150) && Math.floor(world.time * 2.2) % 2 === 0;

    if (this.s >= this.route.total) { this.done = true; this.fadeIn = false; return this.fade > 0; }
    return true;
  }
  inBoxZone() { return this.s > this.route.stopS - 4 && this.s < this.route.stopS + 150; }

  startCrash() {
    if (this.state !== "drive") return;
    this.state = "crashing";
    this.spin = (Math.random() < 0.5 ? -1 : 1) * (1.4 + Math.random());
    this.world.smashAt(this.pose.x, this.pose.y);
    this.held = false;
  }
  revive() {
    if (this.state === "drive") return;
    this.fadeIn = false;                 // fade the wreck out…
    this._reviveAt = this.world.time + 0.6;
    const u = this.unit, r = this.route, s = this.s;
    setTimeout(() => {
      if (!u || u.state === "towed") return;
      const car = new Car(this.world, u, r, true);
      car.s = Math.max(0, s - 40); car.fade = 0;
      car.pose = routePose(r, car.s);
      u.car = car;
    }, 620);
  }

  draw(c, L, night, world) {
    const a = this.fade;
    if (a <= 0.01) return;
    c.save();
    c.globalAlpha = a;
    c.translate(HALF + this.pose.x, HALF + this.pose.y);
    c.rotate(this.angle);
    const hl = this.len / 2, hw = this.wid / 2;

    // soft contact shadow (ambient occlusion under the car)
    c.fillStyle = "rgba(8,10,14,0.32)";
    roundRect(c, -hl - 1.5, -hw - 1.5, this.len + 3, this.wid + 3, 6.5);
    c.fill();

    // sun shadow
    if (L.day > 0.06) {
      c.save();
      c.rotate(-this.angle);
      c.fillStyle = `rgba(10,12,18,${0.3 * L.day})`;
      c.beginPath();
      c.ellipse(L.shadow.x * 8, L.shadow.y * 8, hl * 1.02, hw * 0.95, this.angle, 0, TAU);
      c.fill();
      c.restore();
    }

    // fenders / wheel arches
    c.fillStyle = shade(this.color, -0.38);
    roundRect(c, hl - 12, -hw - 1.4, 9.5, this.wid + 2.8, 3.2); c.fill();
    roundRect(c, -hl + 2.5, -hw - 1.4, 9.5, this.wid + 2.8, 3.2); c.fill();

    // body with side shading
    const body = c.createLinearGradient(0, -hw, 0, hw);
    body.addColorStop(0, shade(this.color, -0.2));
    body.addColorStop(0.45, this.color);
    body.addColorStop(1, shade(this.color, -0.24));
    c.fillStyle = body;
    roundRect(c, -hl, -hw, this.len, this.wid, 5.5);
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.42)"; c.lineWidth = 0.9;
    roundRect(c, -hl, -hw, this.len, this.wid, 5.5);
    c.stroke();

    // hood + trunk shutlines
    c.strokeStyle = "rgba(0,0,0,0.2)"; c.lineWidth = 0.7;
    c.beginPath(); c.moveTo(hl - 13, -hw + 1.6); c.lineTo(hl - 13, hw - 1.6); c.stroke();
    c.beginPath(); c.moveTo(-hl + 12, -hw + 1.6); c.lineTo(-hl + 12, hw - 1.6); c.stroke();

    // side windows
    c.fillStyle = "rgba(20,28,38,0.88)";
    roundRect(c, -hl + 12.5, -hw + 2, this.len - 25.5, 2.7, 1.3); c.fill();
    roundRect(c, -hl + 12.5, hw - 4.7, this.len - 25.5, 2.7, 1.3); c.fill();

    // windshield — trapezoid with a reflection gradient
    const wsg = c.createLinearGradient(hl - 12.5, 0, hl - 6.3, 0);
    wsg.addColorStop(0, "rgba(126,166,196,0.95)");
    wsg.addColorStop(1, "rgba(26,38,52,0.95)");
    c.fillStyle = wsg;
    c.beginPath();
    c.moveTo(hl - 12.5, -hw + 3.6); c.lineTo(hl - 6.3, -hw + 4.7);
    c.lineTo(hl - 6.3, hw - 4.7); c.lineTo(hl - 12.5, hw - 3.6);
    c.closePath(); c.fill();
    c.strokeStyle = "rgba(255,255,255,0.22)"; c.lineWidth = 0.8;
    c.beginPath(); c.moveTo(hl - 11.6, -hw + 4.2); c.lineTo(hl - 8.8, -hw + 5); c.stroke();

    // rear glass
    c.fillStyle = "rgba(26,36,50,0.94)";
    c.beginPath();
    c.moveTo(-hl + 12, -hw + 4); c.lineTo(-hl + 7, -hw + 5);
    c.lineTo(-hl + 7, hw - 5); c.lineTo(-hl + 12, hw - 4);
    c.closePath(); c.fill();

    // roof panel
    c.fillStyle = shade(this.color, -0.3);
    roundRect(c, -hl + 12.5, -hw + 4.7, this.len - 25.5, this.wid - 9.4, 2.6);
    c.fill();

    // mirrors
    c.fillStyle = shade(this.color, -0.45);
    c.fillRect(hl - 13.5, -hw - 2.3, 3.2, 2.3);
    c.fillRect(hl - 13.5, hw, 3.2, 2.3);

    // task beacon
    if (this.isTask && this.unit) {
      const st = this.unit.state;
      c.fillStyle = st === "crashed" || st === "held" ? "#ff453a" : st === "queued" ? "#98989d" : st === "released" ? "#30d158" : "#0a84ff";
      c.beginPath(); c.arc(0, 0, 2.2, 0, TAU); c.fill();
    }

    // tail / brake / blinker lights
    const lights = L.lightsOn || night > 0.25;
    if (this.state === "wreck") {
      const on = Math.floor(this.hazT * 1.6) % 2 === 0;
      c.fillStyle = on ? "#ff9f0a" : "rgba(120,70,0,0.6)";
      c.fillRect(-hl, -hw + 1, 2.5, 3); c.fillRect(-hl, hw - 4, 2.5, 3);
    } else {
      c.fillStyle = this.brake ? "#ff5147" : lights ? "#c02b25" : "rgba(120,40,36,0.7)";
      c.fillRect(-hl, -hw + 1, 2.5, 3.4); c.fillRect(-hl, hw - 4.4, 2.5, 3.4);
      if (this.blinkOn) {
        const side = this.route.maneuver === "right" ? 1 : -1;
        c.fillStyle = "#ffb340";
        if (this.route.maneuver === "right") { c.fillRect(hl - 3, hw - 4, 2.5, 4); c.fillRect(-hl, hw - 4, 2.5, 4); }
        else { c.fillRect(hl - 3, -hw, 2.5, 4); c.fillRect(-hl, -hw, 2.5, 4); }
        void side;
      }
    }
    // headlights
    if (lights && this.state !== "wreck") {
      c.fillStyle = "#ffe9b8";
      c.fillRect(hl - 2, -hw + 1.5, 2.5, 3.5);
      c.fillRect(hl - 2, hw - 5, 2.5, 3.5);
    }
    void world;
    c.restore();
  }

  drawLights(c, L, night, world) {
    const lights = L.lightsOn || night > 0.25;
    if (!lights || this.state === "wreck" || this.fade < 0.1) return;
    const boost = Math.max(night, L.fog * 0.7, L.wet * 0.5);
    if (boost < 0.03) return;
    c.save();
    c.globalAlpha = this.fade * boost;
    c.translate(HALF + this.pose.x, HALF + this.pose.y);
    c.rotate(this.angle);
    const hl = this.len / 2, hw = this.wid / 2;
    // headlight cones
    const grad = c.createLinearGradient(hl, 0, hl + 95, 0);
    grad.addColorStop(0, "rgba(255,225,160,0.34)");
    grad.addColorStop(1, "rgba(255,225,160,0)");
    c.fillStyle = grad;
    c.beginPath();
    c.moveTo(hl - 1, -hw + 2); c.lineTo(hl + 95, -hw - 11); c.lineTo(hl + 95, hw + 11); c.lineTo(hl - 1, hw - 2);
    c.closePath(); c.fill();
    // brake glow
    if (this.brake) {
      const bg = c.createRadialGradient(-hl, 0, 1, -hl, 0, 16);
      bg.addColorStop(0, "rgba(255,60,50,0.5)");
      bg.addColorStop(1, "rgba(255,60,50,0)");
      c.fillStyle = bg;
      c.beginPath(); c.arc(-hl, 0, 16, 0, TAU); c.fill();
    }
    c.restore();
    void world;
  }

  drawLabel(c, u) {
    if (!u.label || this.s < 40 || this.done) return;
    const x = HALF + this.pose.x, y = HALF + this.pose.y - 26;
    c.save();
    c.globalAlpha = this.fade;
    c.font = "600 11px -apple-system, system-ui, sans-serif";
    const text = u.label.length > 26 ? u.label.slice(0, 25) + "…" : u.label;
    const w = c.measureText(text).width + 22;
    c.fillStyle = "rgba(18,18,20,0.74)";
    roundRect(c, x - w / 2, y - 9, w, 18, 9);
    c.fill();
    c.strokeStyle = "rgba(255,255,255,0.14)"; c.lineWidth = 1;
    roundRect(c, x - w / 2, y - 9, w, 18, 9);
    c.stroke();
    const dotCol = { running: "#ffd60a", held: "#ff453a", crashed: "#ff453a", released: "#30d158", queued: "#98989d" }[u.state] || "#98989d";
    c.fillStyle = dotCol;
    c.beginPath(); c.arc(x - w / 2 + 10, y, 2.6, 0, TAU); c.fill();
    c.fillStyle = "#f5f5f7";
    c.textBaseline = "middle";
    c.fillText(text, x - w / 2 + 17, y + 0.5);
    c.restore();
  }
}

/* ── helpers ────────────────────────────────────────────────────────── */
function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = v => clamp(Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt), 0, 255);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
