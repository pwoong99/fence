// 울타리치기 게임판 — 그리기, 정답 판정, 저장용 문자열 변환
const S = 60;   // 칸 크기
const M = 34;   // 바깥 여백
const NS = "http://www.w3.org/2000/svg";

export function edgeCount(w, h) { return (h + 1) * w + h * (w + 1); }

function geo(w, h) {
  const HE = (h + 1) * w;
  return {
    HE,
    hIdx: (r, c) => r * w + c,
    vIdx: (r, c) => HE + r * (w + 1) + c,
    ends(e) {
      if (e < HE) { const r = Math.floor(e / w), c = e % w; return [[r, c], [r, c + 1]]; }
      const k = e - HE, r = Math.floor(k / (w + 1)), c = k % (w + 1);
      return [[r, c], [r + 1, c]];
    },
    cellEdges(r, c) {
      return [r * w + c, (r + 1) * w + c, HE + r * (w + 1) + c, HE + r * (w + 1) + c + 1];
    }
  };
}

export function encodeEdges(set, w, h) {
  const n = edgeCount(w, h);
  let s = "";
  for (let i = 0; i < n; i++) s += set.has(i) ? "1" : "0";
  return s;
}

export function decodeEdges(str) {
  const set = new Set();
  for (let i = 0; i < (str || "").length; i++) if (str[i] === "1") set.add(i);
  return set;
}

// 퍼즐 묶음의 정답(16진수) → 선 집합
export function decodeAnswer(hex) {
  const bits = BigInt("0x" + hex).toString(2).slice(1);
  return decodeEdges(bits);
}

// 정답 판정: 모든 숫자 조건 + 끊기지 않는 하나의 닫힌 울타리
export function checkSolution(w, h, clues, set) {
  if (!set.size) return false;
  const g = geo(w, h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const ch = clues[r * w + c];
    if (ch === "." || ch === undefined) continue;
    const n = g.cellEdges(r, c).filter((e) => set.has(e)).length;
    if (n !== Number(ch)) return false;
  }
  const adj = new Map();
  for (const e of set) {
    const [a, b] = g.ends(e).map(([r, c]) => r * (w + 1) + c);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b); adj.get(b).push(a);
  }
  for (const list of adj.values()) if (list.length !== 2) return false;
  const start = adj.keys().next().value;
  const seen = new Set([start]); const st = [start];
  while (st.length) {
    const x = st.pop();
    for (const y of adj.get(x)) if (!seen.has(y)) { seen.add(y); st.push(y); }
  }
  return seen.size === adj.size;
}

export class Board {
  constructor(svg, { interactive = false, onChange = null } = {}) {
    this.svg = svg;
    this.interactive = interactive;
    this.onChange = onChange;
    this.mode = "draw";
    this.locked = false;
    this.edges = new Set();
    this.answer = null;
    if (interactive) this.bindPointer();
  }

  load(w, h, clues, edges = new Set()) {
    this.w = w; this.h = h; this.clues = clues;
    this.g = geo(w, h);
    this.edges = new Set(edges);
    this.answer = null;
    this.svg.setAttribute("viewBox", `0 0 ${w * S + 2 * M} ${h * S + 2 * M}`);
    this.draw();
  }

  setEdges(set) { this.edges = new Set(set); this.draw(); }
  setMode(m) { this.mode = m; this.svg.classList.toggle("erase-mode", m === "erase"); }
  setLocked(v) { this.locked = v; this.svg.classList.toggle("locked", v); }
  showAnswer(set) { this.answer = set; this.draw(); }
  clear() {
    if (!this.edges.size || this.locked) return;
    this.edges.clear(); this.draw(); this.onChange && this.onChange(this.edges);
  }

  pos(r, c) { return [M + c * S, M + r * S]; }

  draw() {
    const { w, h, g } = this;
    if (!g) return;
    const svg = this.svg;
    svg.innerHTML = "";
    const add = (tag, attrs, parent = svg) => {
      const el = document.createElementNS(NS, tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      parent.appendChild(el);
      return el;
    };
    add("rect", { x: M - 18, y: M - 18, width: w * S + 36, height: h * S + 36, rx: 18, class: "bd-bg" });
    const total = edgeCount(w, h);
    const show = this.answer || this.edges;
    // 빈 자리(연한 점선)
    for (let e = 0; e < total; e++) {
      const [[r1, c1], [r2, c2]] = g.ends(e);
      const [x1, y1] = this.pos(r1, c1), [x2, y2] = this.pos(r2, c2);
      add("line", { x1, y1, x2, y2, class: "bd-slot" });
    }
    // 숫자
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const ch = this.clues[r * w + c];
      if (ch === ".") continue;
      const n = g.cellEdges(r, c).filter((e) => show.has(e)).length;
      let cls = "bd-clue";
      if (!this.answer) {
        if (n > Number(ch)) cls += " over";
        else if (n === Number(ch) && n > 0) cls += " done";
      }
      const [x, y] = this.pos(r + 0.5, c + 0.5);
      const t = add("text", { x, y, class: cls });
      t.textContent = ch;
    }
    // 울타리
    for (const e of show) {
      const [[r1, c1], [r2, c2]] = g.ends(e);
      const [x1, y1] = this.pos(r1, c1), [x2, y2] = this.pos(r2, c2);
      add("line", { x1, y1, x2, y2, class: this.answer ? "bd-edge answer" : "bd-edge" });
    }
    // 점
    for (let r = 0; r <= h; r++) for (let c = 0; c <= w; c++) {
      const [x, y] = this.pos(r, c);
      add("circle", { cx: x, cy: y, r: 6.5, class: "bd-dot" });
    }
  }

  // ---------- 터치 입력 ----------
  toLocal(ev) {
    const p = this.svg.createSVGPoint();
    p.x = ev.clientX; p.y = ev.clientY;
    return p.matrixTransform(this.svg.getScreenCTM().inverse());
  }

  nearestEdge(x, y) {
    const { w, h, g } = this;
    let best = null, bd = 26;
    const hr = Math.round((y - M) / S), hc = Math.floor((x - M) / S);
    if (hr >= 0 && hr <= h && hc >= 0 && hc < w) {
      const d = Math.abs(y - (M + hr * S));
      if (d < bd) { bd = d; best = g.hIdx(hr, hc); }
    }
    const vc = Math.round((x - M) / S), vr = Math.floor((y - M) / S);
    if (vc >= 0 && vc <= w && vr >= 0 && vr < h) {
      const d = Math.abs(x - (M + vc * S));
      if (d < bd) { bd = d; best = g.vIdx(vr, vc); }
    }
    return best;
  }

  nearestDot(x, y) {
    const r = Math.round((y - M) / S), c = Math.round((x - M) / S);
    if (r < 0 || r > this.h || c < 0 || c > this.w) return null;
    const [px, py] = this.pos(r, c);
    return Math.hypot(px - x, py - y) <= 21 ? [r, c] : null;
  }

  edgeBetween(a, b) {
    const [r1, c1] = a, [r2, c2] = b;
    if (r1 === r2 && Math.abs(c1 - c2) === 1) return this.g.hIdx(r1, Math.min(c1, c2));
    if (c1 === c2 && Math.abs(r1 - r2) === 1) return this.g.vIdx(Math.min(r1, r2), c1);
    return null;
  }

  apply(e) {
    if (e === null || e === undefined) return false;
    if (this.mode === "draw") {
      if (this.edges.has(e)) return false;
      this.edges.add(e);
    } else {
      if (!this.edges.has(e)) return false;
      this.edges.delete(e);
    }
    return true;
  }

  bindPointer() {
    const svg = this.svg;
    let st = null;
    svg.addEventListener("pointerdown", (ev) => {
      if (this.locked || !this.g) return;
      ev.preventDefault();
      svg.setPointerCapture(ev.pointerId);
      const p = this.toLocal(ev);
      st = { id: ev.pointerId, x: p.x, y: p.y, moved: false, dot: this.nearestDot(p.x, p.y), changed: false };
    });
    svg.addEventListener("pointermove", (ev) => {
      if (!st || ev.pointerId !== st.id || this.locked) return;
      const p = this.toLocal(ev);
      if (!st.moved && Math.hypot(p.x - st.x, p.y - st.y) > 14) st.moved = true;
      if (!st.moved) return;
      const d = this.nearestDot(p.x, p.y);
      if (!d) return;
      if (st.dot && (d[0] !== st.dot[0] || d[1] !== st.dot[1])) {
        const e = this.edgeBetween(st.dot, d);
        if (this.apply(e)) { st.changed = true; this.draw(); }
      }
      st.dot = d;
    });
    const end = (ev) => {
      if (!st || ev.pointerId !== st.id) return;
      if (!st.moved && !this.locked) {
        const p = this.toLocal(ev);
        if (this.apply(this.nearestEdge(p.x, p.y))) { st.changed = true; this.draw(); }
      }
      if (st.changed && this.onChange) this.onChange(this.edges);
      st = null;
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", (ev) => { if (st && st.changed && this.onChange) this.onChange(this.edges); st = null; });
  }
}
