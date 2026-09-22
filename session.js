/* tl — session.js
   Tails Claude Code session transcripts (~/.claude/projects, *.jsonl, via
   server.py) and directs the intersection:

     user message        → a new car enters (a task/request)
     thinking            → car crawls, status "thinking…"
     tool_use            → work: light yellow, car advances
     tool_result ok      → progress; more speed if results come fast
     tool_result error   → the car crashes (smoke, skids); recovers on retry
     no result for 6s+   → red: waiting on a confirmation (permission prompt)
     final assistant text→ green: the car drives through, lane opens
     TaskCreate/Update   → task cars with their own labels & queueing

   Assistant entries arrive as per-block segments (thinking / tool_use / text),
   tool results as `user` entries carrying tool_result blocks. */

"use strict";

/* ── tool presentation ──────────────────────────────────────────────── */
const TOOL_SVG = {
  terminal: '<svg viewBox="0 0 16 16"><path d="M3 4l3.5 3.5L3 11M8 11h5"/></svg>',
  doc: '<svg viewBox="0 0 16 16"><path d="M4.5 2.5h5L12 5v8.5h-7.5zM9.5 2.5V5H12M6.5 8h4M6.5 10.5h4"/></svg>',
  pencil: '<svg viewBox="0 0 16 16"><path d="M4 12l.8-2.8L10.5 3.5l2 2L6.8 11zM9.5 4.5l2 2"/></svg>',
  listplus: '<svg viewBox="0 0 16 16"><path d="M5.5 3.5h7M5.5 8h7M5.5 12.5h4M3 3.5h.01M3 8h.01M3 12.5h.01"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  list: '<svg viewBox="0 0 16 16"><path d="M5.5 4.5h7M5.5 8h7M5.5 11.5h7M3 4.5h.01M3 8h.01M3 11.5h.01"/></svg>',
  person: '<svg viewBox="0 0 16 16"><circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13c.5-2.7 2.2-4 4.5-4s4 1.3 4.5 4"/></svg>',
  globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c-3.5 3.5-3.5 7.5 0 11 3.5-3.5 3.5-7.5 0-11z"/></svg>',
  wrench: '<svg viewBox="0 0 16 16"><path d="M10.5 3a3.5 3.5 0 0 0-4.4 4.4L3 10.5 5.5 13l3.1-3.1A3.5 3.5 0 0 0 13 5.5l-2 2-1.5-.5-.5-1.5z"/></svg>',
};
function toolMeta(name) {
  const T = {
    Bash: ["terminal", i => i.command || ""],
    Read: ["doc", i => base(i.file_path)],
    Write: ["doc", i => base(i.file_path)],
    Edit: ["pencil", i => base(i.file_path)],
    NotebookEdit: ["pencil", i => base(i.notebook_path)],
    Glob: ["doc", i => i.pattern || ""],
    Grep: ["doc", i => i.pattern || ""],
    TaskCreate: ["listplus", i => i.subject || "task"],
    TaskUpdate: ["check", i => `${i.status || "?"} · ${i.taskId || ""}`],
    TaskList: ["list", () => "all tasks"],
    TaskGet: ["list", i => i.taskId || ""],
    Agent: ["person", i => i.description || i.prompt || "agent"],
    WebFetch: ["globe", i => (i.urls || [i.url] || []).join(" ").slice(0, 60)],
    WebSearch: ["globe", i => i.query || ""],
    TodoWrite: ["listplus", i => (i.todos || []).length + " todos"],
  };
  return T[name] || ["wrench", i => {
    const v = Object.values(i || {})[0];
    return typeof v === "string" ? v.slice(0, 60) : "";
  }];
}
const base = p => (p || "").split("/").pop() || "";

/* ── activity feed ──────────────────────────────────────────────────── */
class Feed {
  constructor(ol) { this.ol = ol; }
  add({ icon = "wrench", title, sub = "", cls = "" }) {
    const li = document.createElement("li");
    li.className = "frow " + cls;
    li.innerHTML =
      `<span class="fi">${TOOL_SVG[icon] || TOOL_SVG.wrench}</span>` +
      `<span class="ft"><b></b><span></span></span>` +
      `<span class="fs run"></span>`;
    li.querySelector("b").textContent = title;
    li.querySelector(".ft span").textContent = sub;
    this.ol.prepend(li);
    while (this.ol.children.length > 150) this.ol.lastChild.remove();
    return {
      el: li,
      setStatus(s, sub) {
        li.querySelector(".fs").className = "fs " + s;
        if (sub !== undefined) li.querySelector(".ft span").textContent = sub;
      },
    };
  }
  clear() { this.ol.textContent = ""; }
  note(text) { return this.add({ icon: "list", title: text, cls: "msg" }); }
}

/* ── director: transcript events → traffic ──────────────────────────── */
class Director {
  constructor(world, feed, hud) {
    this.world = world; this.feed = feed; this.hud = hud;
    this.silent = false;             // fast-forward: count, don't spawn
    this.units = new Map();          // unitId → {id,label,kind,expected,done,errors,tools:[],t0}
    this.tasks = new Map();          // taskId → {unitId, state, subject}
    this.taskByTool = new Map();     // tool_use id of TaskCreate → taskId
    this.pending = new Map();        // tool_use id → {unitId, row, name, at}
    this.sidecars = new Set();       // Agent tool_use ids (own cars)
    this.turn = null; this.seq = 0;
    this.activeTaskId = null;
    this.tokensByMsg = new Map();
    this.events = 0; this.tokens = 0;
    this.heldSince = 0; this.held = false;
    this.resultTimes = [];
    this.lastEntryWall = 0;
    this.lastStatus = null;
    this.iv = setInterval(() => this.tick(), 1000);
  }

  /* ---- state ---- */
  attributionUnit() {
    const t = this.activeTaskId && this.tasks.get(this.activeTaskId);
    if (t && (t.state === "in_progress")) return t.unitId;
    return this.turn ? this.turn.id : null;
  }
  ensureUnit(id, label, kind) {
    if (!this.units.has(id)) {
      this.units.set(id, { id, label, kind, expected: 0, done: 0, errors: 0, tools: [], t0: Date.now() });
      if (!this.silent) this.world.spawnUnit(id, label, kind);
    }
    return this.units.get(id);
  }
  progressOf(u) {
    const age = (Date.now() - u.t0) / 1000;
    if (u.expected > 0) return clamp((u.done / u.expected) * 0.85, 0.02, 0.85);
    return clamp(0.1 + age / 90, 0.05, 0.45); // long single tool still creeps
  }
  rate() {
    const now = Date.now();
    this.resultTimes = this.resultTimes.filter(t => now - t < 15000);
    return clamp(this.resultTimes.length / 4, 0.08, 1);
  }
  pushProgress() {
    const uid = this.attributionUnit();
    if (!uid) return;
    const u = this.units.get(uid);
    this.world.setProgress(uid, this.progressOf(u), this.rate());
  }

  /* ---- transcript entry ---- */
  onEntry(e) {
    this.events++;
    this.lastEntryWall = Date.now();
    if (this.held) this.unhold();
    const t = e.type;

    if (t === "assistant" && e.message) {
      const msg = e.message;
      const usage = msg.usage;
      if (usage && msg.id) {
        const prev = this.tokensByMsg.get(msg.id) || 0;
        if (usage.output_tokens > prev) this.tokens += usage.output_tokens - prev;
        this.tokensByMsg.set(msg.id, usage.output_tokens);
      }
      for (const b of msg.content || []) {
        if (b.type === "tool_use") this.onToolUse(b);
        else if (b.type === "text" && (b.text || "").trim()) this.onText(b.text.trim());
        else if (b.type === "thinking") this.onThinking();
      }
    } else if (t === "user" && e.message) {
      const c = e.message.content;
      if (typeof c === "string") {
        if (!e.isMeta && c.trim()) this.onUserTurn(c.trim());
      } else if (Array.isArray(c)) {
        for (const b of c) if (b && b.type === "tool_result") this.onResult(b);
      }
    }
  }

  onUserTurn(text) {
    this.finishTurn();
    this.seq++;
    const label = text.replace(/\s+/g, " ").slice(0, 24) || `request ${this.seq}`;
    const id = `t${this.seq}`;
    this.turn = { id, label, answered: false, thinking: false };
    this.ensureUnit(id, label, "turn");
    this.feed.add({ icon: "person", title: "you", sub: text.replace(/\s+/g, " ").slice(0, 90), cls: "you" })
      .setStatus("ok", "");
    this.pushProgress();
    this.hud.dirty = true;
  }

  onThinking() {
    if (this.turn) this.turn.thinking = true;
    const uid = this.attributionUnit();
    if (uid) this.world.resumeUnit(uid);
  }

  onToolUse(b) {
    const [icon, pick] = toolMeta(b.name);
    const sub = pick(b.input || {});
    const row = this.feed.add({ icon, title: b.name, sub });

    if (b.name === "TaskCreate") {
      const subject = (b.input && b.input.subject) || "task";
      this.taskByTool.set(b.id, { subject, pending: true });
      this.pending.set(b.id, { unitId: this.turn?.id, row, name: b.name, at: Date.now() });
      return;
    }
    if (b.name === "TaskUpdate") {
      const inp = b.input || {};
      const task = this.tasks.get(inp.taskId);
      if (task) {
        if (inp.status === "in_progress") {
          task.state = "in_progress";
          this.activeTaskId = inp.taskId;
          this.world.resumeUnit(task.unitId);
          if (!this.silent) this.world.setProgress(task.unitId, 0.05, 0.3);
        } else if (inp.status === "completed") {
          task.state = "completed";
          this.world.releaseUnit(task.unitId);
          this.feed.note(`task done — ${task.subject}`);
        } else if (inp.status === "deleted") {
          task.state = "deleted";
          this.world.towUnit(task.unitId);
        }
        if (this.activeTaskId === inp.taskId && inp.status !== "in_progress") this.activeTaskId = null;
      }
      this.pending.set(b.id, { unitId: this.turn?.id, row, name: b.name, at: Date.now() });
      return;
    }

    const uid = this.attributionUnit();
    if (b.name === "Agent") {
      // subagents run in parallel — they get their own little car
      const sid = `a${b.id}`;
      this.sidecars.add(b.id);
      this.ensureUnit(sid, "agent: " + sub.slice(0, 18), "turn");
      this.pending.set(b.id, { unitId: sid, row, name: b.name, at: Date.now() });
      return;
    }
    if (uid) {
      const u = this.units.get(uid);
      u.expected++; u.tools.push({ name: b.name, sub, state: "run", at: Date.now() });
      this.pending.set(b.id, { unitId: uid, row, name: b.name, at: Date.now() });
      this.world.resumeUnit(uid);
      this.pushProgress();
    }
  }

  onResult(b) {
    const id = b.tool_use_id ?? b.id ?? (b.content && b.tool_use_id);
    const pend = this.pending.get(id);
    if (!pend) return;
    this.pending.delete(id);
    this.resultTimes.push(Date.now());
    const isErr = b.is_error === true;
    const text = typeof b.content === "string" ? b.content
      : Array.isArray(b.content) ? b.content.map(x => x.text || "").join(" ") : "";
    pend.row.setStatus(isErr ? "err" : "ok", text.replace(/\s+/g, " ").slice(0, 60));

    // TaskCreate result creates the task car
    const tc = this.taskByTool.get(id);
    if (tc && tc.pending) {
      tc.pending = false;
      const m = text.match(/#?(\d+)/);
      const taskId = (m && m[1]) || id;
      const unitId = `k${taskId}`;
      this.ensureUnit(unitId, tc.subject.slice(0, 22), "task");
      if (!this.silent) this.world.setQueued(unitId);
      this.tasks.set(taskId, { unitId, state: "pending", subject: tc.subject });
      this.tasks.set(id, this.tasks.get(taskId));
      return;
    }
    // Agent sidecar finished its run
    if (this.sidecars.has(id)) {
      const sid = `a${id}`;
      if (isErr) this.world.crashUnit(sid); else this.world.releaseUnit(sid);
      return;
    }
    // TaskUpdate result — nothing extra (handled at tool_use time)
    if (pend.name === "TaskUpdate") return;

    const u = this.units.get(pend.unitId);
    if (u) {
      u.done++;
      const tl = u.tools.find(t => t.state === "run");
      if (tl) { tl.state = isErr ? "err" : "ok"; }
      if (isErr) {
        u.errors++;
        this.world.crashUnit(pend.unitId);
      } else if (u.errors > 0) {
        u.errors = 0; // recovered — the replacement car rolls out
        this.world.retryUnit(pend.unitId);
      }
      this.pushProgress();
    }
    // turn may now be complete (final text already sent, all results in)
    if (this.turn && this.turn.answered && this.pending.size === 0) this.finishTurn();
  }

  onText(text) {
    this.feed.add({ icon: "doc", title: "claude", sub: text.replace(/\s+/g, " ").slice(0, 90), cls: "msg" })
      .setStatus("ok", "");
    if (this.turn) {
      this.turn.answered = true;
      if (this.pending.size === 0) this.finishTurn();
    }
  }

  finishTurn() {
    if (!this.turn) return;
    const uid = this.turn.id;
    this.world.releaseUnit(uid);
    this.turn = null;
    this.hud.dirty = true;
  }

  /* ---- the 6s rule: no result coming back → red, waiting on you ---- */
  tick() {
    if (this.silent) return;
    const now = Date.now();
    if (this.pending.size > 0 && this.lastEntryWall && now - this.lastEntryWall > 6000) {
      if (!this.held) {
        this.held = true; this.heldSince = now;
        const uid = this.attributionUnit();
        if (uid) this.world.holdUnit(uid);
        for (const p of this.pending.values()) p.row.setStatus("hold");
      }
    }
  }
  unhold() {
    this.held = false;
    for (const p of this.pending.values()) if (p.row.el.querySelector(".fs").classList.contains("hold")) p.row.setStatus("run");
    const uid = this.attributionUnit();
    if (uid) this.world.resumeUnit(uid);
  }

  /* ---- end-of-fast-forward: materialize what is still open ---- */
  materialize() {
    this.silent = false;
    const ensure = (id, label, kind) => {
      if (!this.units.has(id))
        this.units.set(id, { id, label, kind, expected: 0, done: 0, errors: 0, tools: [], t0: Date.now() });
      if (!this.world.unitCars.has(id)) this.world.spawnUnit(id, label, kind);
      return this.units.get(id);
    };
    for (const [taskId, t] of this.tasks) {
      if (t.state === "in_progress") {
        ensure(t.unitId, t.subject.slice(0, 22), "task");
        this.activeTaskId = this.activeTaskId || taskId;
      } else if (t.state === "pending") {
        ensure(t.unitId, t.subject.slice(0, 22), "task");
        this.world.setQueued(t.unitId);
      }
    }
    if (this.turn) ensure(this.turn.id, this.turn.label, "turn");
    this.pushProgress();
  }

  statusLine() {
    const pend = [...this.pending.values()];
    if (this.held && pend.length) {
      return { dot: "red", line: "waiting for confirmation", sub: `${pend[pend.length - 1].name} — ${Math.round((Date.now() - this.heldSince) / 1000)}s and counting` };
    }
    if (this.turn) {
      const u = this.units.get(this.turn.id);
      if (this.turn.thinking && this.pending.size === 0)
        return { dot: "yellow", line: "thinking…", sub: this.turn.label };
      const cur = pend[pend.length - 1];
      if (cur) return { dot: "yellow", line: `working — ${cur.name}`, sub: `${u ? u.done + "/" + u.expected : ""} tool calls · ${cur.name === "Bash" ? "" : ""}${cur.row.el.querySelector(".ft span").textContent.slice(0, 42)}` };
      return { dot: "yellow", line: "working", sub: this.turn.label };
    }
    const open = [...new Map([...this.tasks.values()].map(t => [t.unitId, t])).values()]
      .filter(t => t.state === "in_progress" || t.state === "pending");
    if (open.length) return {
      dot: "yellow",
      line: `${open.length} task${open.length > 1 ? "s" : ""} in the plan`,
      sub: open.map(t => t.subject).join(", ").slice(0, 64),
    };
    return { dot: "green", line: "ready for the next task", sub: "green across the board" };
  }
}

/* ── tailer ─────────────────────────────────────────────────────────── */
class Tailer {
  constructor(file) { this.file = file; this.offset = 0; this.buf = ""; this.size = 0; }
  async poll() {
    const out = [];
    for (let guard = 0; guard < 400; guard++) {
      const r = await fetch(`/api/tail?file=${encodeURIComponent(this.file)}&offset=${this.offset}`);
      if (!r.ok) return out;
      const j = await r.json();
      this.size = j.size;
      this.buf += j.data;
      this.offset += j.data.length;
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* torn tail line — keep buffering */ }
      }
      if (!j.more) break;
    }
    return out;
  }
}

/* ── demo: same pipeline, synthetic entries ─────────────────────────── */
const FEATS = ["login page", "dark mode", "search bar", "settings panel", "file tree", "toast system", "keyboard shortcuts", "auto-save"];
class Demo {
  constructor(director) { this.d = director; this.n = 0; this.failNext = false; this.on = true; }
  mkUser(text, t) { return { type: "user", message: { content: text }, _t: t }; }
  mkA(blocks, t, id) { return { type: "assistant", message: { id, content: blocks, usage: { output_tokens: 120 + Math.random() * 600 | 0 } }, _t: t }; }
  fire(e) { e._t = undefined; this.d.onEntry(e); }
  cycle() {
    if (!this.on) return;
    this.n++;
    const feat = FEATS[this.n % FEATS.length];
    const seq = [];
    let t = 0; const id = () => `d${this.n}-${t}`;
    seq.push([t, this.mkUser(`ship the ${feat}`, t)]);
    t += 1.2; seq.push([t, this.mkA([{ type: "thinking", thinking: "…" }], t, `m${this.n}`)]);
    t += 1.0; seq.push([t, this.mkA([{ type: "tool_use", id: id(), name: "Read", input: { file_path: `/app/${feat.replace(/ /g, "-")}.tsx` } }], t, `m${this.n}`)]);
    t += 0.9; seq.push([t, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `d${this.n}-2`, content: "184 lines" }] } }]);
    t += 1.1; seq.push([t, this.mkA([{ type: "tool_use", id: `d${this.n}-4`, name: "Edit", input: { file_path: `${feat}.tsx` } }], t, `m${this.n}`)]);
    t += 1.6; seq.push([t, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `d${this.n}-4`, content: "edited" }] } }]);
    t += 0.8; seq.push([t, this.mkA([{ type: "tool_use", id: `d${this.n}-6`, name: "Bash", input: { command: `npm test -- ${feat}` } }], t, `m${this.n}`)]);
    t += 2.2;
    const fail = this.failNext || this.n % 3 === 0;
    this.failNext = false;
    seq.push([t, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `d${this.n}-6`, is_error: fail, content: fail ? "exit 1 — 3 tests failed" : "12 passed" }] } }]);
    if (fail) {
      t += 1.4; seq.push([t, this.mkA([{ type: "tool_use", id: `d${this.n}-7`, name: "Edit", input: { file_path: `${feat}.tsx` } }], t, `m${this.n}`)]);
      t += 1.5; seq.push([t, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `d${this.n}-7`, content: "fixed" }] } }]);
      t += 0.8; seq.push([t, this.mkA([{ type: "tool_use", id: `d${this.n}-8`, name: "Bash", input: { command: "npm test" } }], t, `m${this.n}`)]);
      t += 2.0; seq.push([t, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `d${this.n}-8`, content: "15 passed" }] } }]);
    }
    if (this.n % 2 === 0) { // a subagent runs in parallel sometimes
      t += 0.4; seq.push([t, this.mkA([{ type: "tool_use", id: `d${this.n}-a`, name: "Agent", input: { description: `review ${feat}` } }], t, `m${this.n}`)]);
      t += 3.2; seq.push([t, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `d${this.n}-a`, content: "looks good" }] } }]);
    }
    t += 0.7; seq.push([t, this.mkA([{ type: "text", text: `done — ${feat} shipped ✅ tests green` }], t, `m${this.n}`)]);
    this.play(seq, () => setTimeout(() => this.cycle(), 6000 + Math.random() * 7000));
  }
  play(seq, done) {
    let i = 0;
    const step = () => {
      if (!this.on) return;
      if (i >= seq.length) { done && done(); return; }
      const [t, e] = seq[i++];
      this.fire(e);
      const next = seq[i] ? Math.max(60, (seq[i][0] - t) * 1000) : 400;
      setTimeout(step, next);
    };
    step();
  }
  injectTask() {
    this.n++;
    const feat = FEATS[(this.n * 3) % FEATS.length];
    this.fire(this.mkUser(`add a ${feat}`, 0));
    setTimeout(() => this.fire(this.mkA([{ type: "tool_use", id: `x${this.n}-1`, name: "TaskCreate", input: { subject: feat } }], 0, `x${this.n}`)), 500);
    setTimeout(() => this.fire({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `x${this.n}-1`, content: `Task #9${this.n} created` }] } }), 900);
    setTimeout(() => this.fire(this.mkA([{ type: "tool_use", id: `x${this.n}-2`, name: "TaskUpdate", input: { taskId: `9${this.n}`, status: "in_progress" } }], 0, `x${this.n}`)), 1300);
    setTimeout(() => this.fire({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `x${this.n}-2`, content: "ok" }] } }), 1600);
    setTimeout(() => this.fire(this.mkA([{ type: "tool_use", id: `x${this.n}-3`, name: "Write", input: { file_path: `${feat}.js` } }], 0, `x${this.n}`)), 2200);
    setTimeout(() => this.fire({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `x${this.n}-3`, content: "wrote file" }] } }), 3400);
    setTimeout(() => this.fire(this.mkA([{ type: "tool_use", id: `x${this.n}-4`, name: "TaskUpdate", input: { taskId: `9${this.n}`, status: "completed" } }], 0, `x${this.n}`)), 3800);
    setTimeout(() => this.fire({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `x${this.n}-4`, content: "ok" }] } }), 4100);
    setTimeout(() => this.fire(this.mkA([{ type: "text", text: `${feat} done` }], 0, `x${this.n}`)), 4600);
  }
  failOne() { this.failNext = true; this.d.feed.note("next tool call will fail"); }
  hold() {
    this.d.feed.note("holding — watch the light go red");
    const uid = this.d.attributionUnit();
    this.d.held = true; this.d.heldSince = Date.now();
    if (uid) this.d.world.holdUnit(uid);
    for (const p of this.d.pending.values()) p.row.setStatus("hold");
    setTimeout(() => this.d.unhold(), 5200);
  }
}
