// 울타리치기 — 학생 경쟁 게임 (GitHub Pages + Firebase webapp-hub 프로젝트, fence_ 컬렉션)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, collection, getDoc, getDocFromServer, setDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, increment, arrayUnion, writeBatch, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { PUZZLES } from "./puzzles.js";
import { Board, checkSolution, encodeEdges, decodeEdges, decodeAnswer } from "./board.js";

const VERSION = "v1.0";

const firebaseConfig = {
  apiKey: "AIzaSyD4CIUitbAtrNVc9rwnojFrTPlljwzp1l4",
  authDomain: "webapp-hub-64b0d.firebaseapp.com",
  projectId: "webapp-hub-64b0d",
  storageBucket: "webapp-hub-64b0d.firebasestorage.app",
  messagingSenderId: "114748294567",
  appId: "1:114748294567:web:306ff643b1c06c282fe282"
};
const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
const auth = getAuth(fbApp);

const DEFAULT_TIMES = [120, 120, 180, 180, 240, 240, 360, 360];
const DEFAULT_PTS = { first: 10, min: 3 };
const GRACE_MS = 1500;          // 제출 시간 여유
const EST = { serverTimestamps: "estimate" };

// ---------- 공통 도구 ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const levelInfo = (lv) => {
  const L = PUZZLES[lv - 1];
  return { size: `${L.w}×${L.h}`, kind: lv % 2 ? "숫자 많이" : "숫자 적게" };
};
const levelLabel = (lv) => { const i = levelInfo(lv); return `${lv}단계 · ${i.size} · ${i.kind}`; };
const fmtTime = (sec) => { sec = Math.max(0, Math.ceil(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; };
const ms = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : null);
document.querySelectorAll(".ver").forEach((el) => (el.textContent = VERSION));

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function confirmBox(msg, yes = "확인") {
  return new Promise((resolve) => {
    $("confirmMsg").textContent = msg;
    $("confirmYes").textContent = yes;
    $("confirmModal").classList.remove("hidden");
    const done = (v) => {
      $("confirmModal").classList.add("hidden");
      $("confirmYes").onclick = $("confirmNo").onclick = null;
      resolve(v);
    };
    $("confirmYes").onclick = () => done(true);
    $("confirmNo").onclick = () => done(false);
  });
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
}

// 서버 시계와 내 기기 시계의 차이 (모든 기기가 같은 타이머를 보도록)
let clockOffset = 0;
const now = () => Date.now() + clockOffset;
async function syncClock(ref, field) {
  try {
    const t0 = Date.now();
    await updateDoc(ref, { [field]: serverTimestamp() });
    const t1 = Date.now();
    const snap = await getDocFromServer(ref);
    const t = ms(snap.get(field));
    if (t) clockOffset = t - (t0 + t1) / 2;
  } catch (e) { console.warn("시계 맞추기 실패", e); }
}

// 같은 점수는 같은 등수
function ranked(players) {
  const list = [...players].sort((a, b) => (b.score || 0) - (a.score || 0) || a.name.localeCompare(b.name, "ko"));
  let prev = null, rank = 0;
  list.forEach((p, i) => {
    if ((p.score || 0) !== prev) { rank = i + 1; prev = p.score || 0; }
    p.rank = rank;
  });
  return list;
}

function resultText(res) {
  if (!res) return null;
  if (res.correct) return { ok: true, big: `🎉 정답! ${res.rank}등`, sm: `+${res.points}점을 얻었어요` };
  if (res.reason === "late") return { ok: false, big: "⏰ 시간 초과", sm: "제한 시간이 지난 뒤에 제출됐어요 · 0점" };
  if (res.reason === "timeout") return { ok: false, big: "⏰ 시간 초과", sm: "시간 안에 제출하지 못했어요 · 0점" };
  return { ok: false, big: "😢 아쉬워요, 오답!", sm: "다음 라운드에 다시 도전해요 · 0점" };
}

// ---------- 로그인 준비 (익명 로그인) ----------
let user = null;
const authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, (u) => {
    if (u) { user = u; resolve(u); }
    else signInAnonymously(auth).catch((e) => {
      console.error(e);
      $("entryMsg").textContent = "접속 준비에 실패했어요. 잠시 뒤 새로고침해 주세요.";
    });
  });
});

// ---------- 입장 화면 ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $("studentForm").classList.toggle("hidden", tab.dataset.tab !== "student");
    $("teacherForm").classList.toggle("hidden", tab.dataset.tab !== "teacher");
    $("entryMsg").textContent = "";
  });
});

try {
  const saved = JSON.parse(localStorage.getItem("fence_student") || "null");
  if (saved) { $("roomCode").value = saved.code || ""; $("studentName").value = saved.name || ""; }
} catch (e) { /* 저장값 없음 */ }

$("roomCode").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4); });

$("studentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("roomCode").value.trim();
  const name = $("studentName").value.trim().replace(/[\/\\.#$\[\]]/g, "").slice(0, 10);
  if (!/^\d{4}$/.test(code)) return ($("entryMsg").textContent = "방 번호 4자리를 적어 주세요.");
  if (!name) return ($("entryMsg").textContent = "이름을 적어 주세요.");
  const btn = e.submitter; btn.disabled = true;
  $("entryMsg").textContent = "";
  try { await joinStudent(code, name); }
  catch (err) { console.error(err); $("entryMsg").textContent = err.userMsg || "입장하지 못했어요. 다시 시도해 주세요."; }
  finally { btn.disabled = false; }
});

$("teacherForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("teacherPw").value.trim();
  if (!pw) return ($("entryMsg").textContent = "비밀번호를 적어 주세요.");
  const btn = e.submitter; btn.disabled = true;
  $("entryMsg").textContent = "";
  try { await teacherLogin(pw); $("teacherPw").value = ""; }
  catch (err) { console.error(err); $("entryMsg").textContent = err.userMsg || "입장하지 못했어요. 다시 시도해 주세요."; }
  finally { btn.disabled = false; }
});

const userErr = (msg) => Object.assign(new Error(msg), { userMsg: msg });

// =====================================================================
// 학생
// =====================================================================
const ST = { unsubs: [], room: null, me: null, players: [], round: null, saveTimer: null, tick: null, joined: false };
const stBoard = new Board($("stBoard"), { interactive: true, onChange: scheduleSave });
const stAnswerBoard = new Board($("stAnswerBoard"));
let stAnswerKey = null;

async function joinStudent(code, name) {
  await authReady;
  const roomRef = doc(db, "fence_rooms", code);
  const rs = await getDoc(roomRef);
  if (!rs.exists()) throw userErr("방 번호를 다시 확인해 주세요.");
  const pRef = doc(db, "fence_rooms", code, "players", name);
  const ps = await getDoc(pRef);
  if (ps.exists()) await updateDoc(pRef, { uid: user.uid, lastSeen: serverTimestamp() });
  else await setDoc(pRef, { name, uid: user.uid, score: 0, edges: "", joinedAt: serverTimestamp(), lastSeen: serverTimestamp() });
  await syncClock(pRef, "lastSeen");
  localStorage.setItem("fence_student", JSON.stringify({ code, name }));

  Object.assign(ST, { code, name, roomRef, pRef, room: null, me: null, players: [], round: null, joined: false });
  $("stName").textContent = name;
  $("stRoom").textContent = `방 ${code}`;
  setTool("draw");
  showScreen("student");

  ST.unsubs.push(onSnapshot(roomRef, (s) => {
    if (!s.exists()) return leaveStudent("선생님이 방을 닫았어요.");
    ST.room = s.data(EST); renderStudent();
  }));
  ST.unsubs.push(onSnapshot(pRef, (s) => {
    if (!s.exists()) { if (ST.joined) leaveStudent("선생님이 방에서 내보냈어요. 다시 입장할 수 있어요."); return; }
    ST.joined = true;
    ST.me = s.data(EST); renderStudent();
  }));
  ST.unsubs.push(onSnapshot(collection(db, "fence_rooms", code, "players"), (qs) => {
    ST.players = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderStudentRank();
  }));
  clearInterval(ST.tick);
  ST.tick = setInterval(studentTick, 250);
}

function leaveStudent(msg) {
  ST.unsubs.forEach((u) => u()); ST.unsubs = [];
  clearInterval(ST.tick); clearTimeout(ST.saveTimer);
  ST.joined = false;
  showScreen("entry");
  $("entryMsg").textContent = msg || "";
}
$("stLeave").addEventListener("click", async () => {
  if (await confirmBox("게임방에서 나갈까요?\n같은 이름으로 다시 들어오면 점수가 이어져요.", "나가기")) leaveStudent("");
});

function endAtOf(r) { const s = ms(r && r.startAt); return s ? s + r.duration * 1000 : null; }

function renderStudent() {
  const r = ST.room, me = ST.me;
  if (!r || !me) return;
  $("stScore").textContent = me.score || 0;
  renderStudentRank();

  const playing = r.status === "playing";
  const res = me.result && me.result.round === r.round ? me.result : null;
  $("stGame").classList.toggle("hidden", !playing);
  $("stLobby").classList.toggle("hidden", playing);

  if (playing) {
    if (ST.round !== r.round) {
      ST.round = r.round;
      let edges = new Set();
      if (me.sub && me.sub.round === r.round) edges = decodeEdges(me.sub.edges);
      else if (me.edges && me.edges.startsWith(r.round + ":")) edges = decodeEdges(me.edges.split(":")[1]);
      stBoard.load(r.puzzle.w, r.puzzle.h, r.puzzle.c, edges);
      setTool("draw");
      $("stLevel").textContent = levelLabel(r.level);
    }
    const submitted = !!(me.sub && me.sub.round === r.round);
    const end = endAtOf(r);
    const timeUp = end !== null && now() > end;
    const lock = submitted || timeUp || !!res;
    stBoard.setLocked(lock);
    ["toolDraw", "toolErase", "toolClear", "toolSubmit"].forEach((id) => ($(id).disabled = lock));
    const msg = $("stGameMsg");
    msg.className = "game-msg";
    if (res) {
      const t = resultText(res);
      msg.textContent = `${t.big} ${t.ok ? `+${res.points}점` : "0점"}`;
      msg.classList.add(t.ok ? "ok" : "bad");
    } else if (submitted) msg.textContent = "📮 제출 완료! 채점 중이에요…";
    else if (timeUp) { msg.textContent = "⏰ 시간 종료!"; msg.classList.add("bad"); }
    else msg.textContent = "";
  } else {
    const box = $("stResult");
    const t = r.status === "ended" ? resultText(res) : null;
    box.classList.toggle("hidden", !t);
    if (t) {
      box.className = "result " + (t.ok ? "ok" : "bad");
      box.innerHTML = `<div class="big">${esc(t.big)}</div><div class="sm">${esc(t.sm)}</div>`;
    }
    $("stWait").querySelector("p").textContent = r.round > 0 ? "다음 라운드를 기다리는 중이에요!" : "선생님이 시작하면 게임이 열려요!";
    // 지난 문제 정답 보여 주기
    const showAns = r.status === "ended" && r.round > 0 && r.puzzle && PUZZLES[r.level - 1] && PUZZLES[r.level - 1].puzzles[r.pid];
    $("stAnswerCard").hidden = !showAns;
    if (showAns && stAnswerKey !== r.round) {
      stAnswerKey = r.round;
      stAnswerBoard.load(r.puzzle.w, r.puzzle.h, r.puzzle.c);
      stAnswerBoard.showAnswer(decodeAnswer(PUZZLES[r.level - 1].puzzles[r.pid].a));
    }
  }
}

function renderStudentRank() {
  if (!ST.me) return;
  const list = ranked(ST.players.map((p) => ({ ...p })));
  const mine = list.find((p) => p.id === ST.name);
  $("stRankTxt").textContent = mine ? `${mine.rank}등 / ${list.length}명` : "-";
  $("stRankList").innerHTML = list.slice(0, 10).map((p) =>
    `<li class="${p.id === ST.name ? "me" : ""}"><span class="no">${p.rank}</span><span class="nm">${esc(p.name)}</span><span class="sc">${p.score || 0}점</span></li>`
  ).join("") + (mine && mine.rank > 10
    ? `<li class="me"><span class="no">${mine.rank}</span><span class="nm">${esc(mine.name)}</span><span class="sc">${mine.score || 0}점</span></li>` : "");
}

let stWasUp = false;
function studentTick() {
  const r = ST.room;
  if (!r || r.status !== "playing") return;
  const end = endAtOf(r);
  if (end === null) return;
  const left = (end - now()) / 1000;
  const el = $("stTimer");
  el.textContent = fmtTime(left);
  el.classList.toggle("warn", left <= 10 && left > 0);
  const up = left <= 0;
  if (up !== stWasUp) { stWasUp = up; renderStudent(); }
}

function setTool(m) {
  stBoard.setMode(m);
  $("toolDraw").classList.toggle("active", m === "draw");
  $("toolErase").classList.toggle("active", m === "erase");
}
$("toolDraw").addEventListener("click", () => setTool("draw"));
$("toolErase").addEventListener("click", () => setTool("erase"));
$("toolClear").addEventListener("click", async () => {
  if (!stBoard.edges.size) return;
  if (await confirmBox("그린 울타리를 모두 지울까요?", "모두 지우기")) stBoard.clear();
});

function scheduleSave() {
  clearTimeout(ST.saveTimer);
  ST.saveTimer = setTimeout(() => {
    const r = ST.room;
    if (!r || r.status !== "playing" || !ST.pRef) return;
    if (ST.me && ST.me.sub && ST.me.sub.round === r.round) return;
    updateDoc(ST.pRef, { edges: `${r.round}:${encodeEdges(stBoard.edges, stBoard.w, stBoard.h)}` }).catch(console.warn);
  }, 700);
}

$("toolSubmit").addEventListener("click", async () => {
  const r = ST.room;
  if (!r || r.status !== "playing") return;
  if (!stBoard.edges.size) return toast("먼저 울타리를 그려 주세요.");
  if (!(await confirmBox("정말 제출할까요?\n제출은 딱 한 번만 할 수 있어요!", "제출하기"))) return;
  if (ST.room.round !== r.round || ST.room.status !== "playing") return toast("이미 라운드가 끝났어요.");
  clearTimeout(ST.saveTimer);
  const bits = encodeEdges(stBoard.edges, stBoard.w, stBoard.h);
  $("toolSubmit").disabled = true;
  try {
    await updateDoc(ST.pRef, { sub: { round: r.round, edges: bits, at: serverTimestamp() }, edges: `${r.round}:${bits}` });
  } catch (e) {
    console.error(e);
    toast("제출하지 못했어요. 시간이 끝났거나 이미 제출했어요.");
    renderStudent();
  }
});

// =====================================================================
// 교사
// =====================================================================
const T = { unsubs: [], room: null, players: [], graded: new Map(), queue: Promise.resolve(), ending: false, sel: null, boardKey: null, answer: false, tick: null };
const tBoard = new Board($("tBoard"));

async function teacherLogin(pw) {
  await authReady;
  const k = await sha256("fence-teacher:" + pw);
  const tRef = doc(db, "fence_teachers", user.uid);
  let ok = false;
  try {
    const s = await getDoc(tRef);
    if (s.exists()) ok = s.get("k") === k;
    else { await setDoc(tRef, { k, at: serverTimestamp() }); ok = true; }
  } catch (e) { console.warn(e); ok = false; }
  if (!ok) throw userErr("비밀번호가 맞지 않아요.");

  let code = localStorage.getItem("fence_teacher_room");
  if (code) {
    const s = await getDoc(doc(db, "fence_rooms", code)).catch(() => null);
    if (!s || !s.exists()) code = null;
  }
  if (!code) code = await createRoom();
  startTeacher(code);
}

async function createRoom() {
  for (let i = 0; i < 20; i++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    const ref = doc(db, "fence_rooms", code);
    const s = await getDoc(ref);
    if (s.exists()) continue;
    await setDoc(ref, {
      status: "waiting", round: 0, level: 1, times: DEFAULT_TIMES, pts: DEFAULT_PTS, used: {},
      createdAt: serverTimestamp(), touchedAt: serverTimestamp()
    });
    return code;
  }
  throw userErr("방을 만들지 못했어요. 다시 시도해 주세요.");
}

function stopTeacher() {
  T.unsubs.forEach((u) => u()); T.unsubs = [];
  clearInterval(T.tick);
}

async function startTeacher(code) {
  stopTeacher();
  localStorage.setItem("fence_teacher_room", code);
  const roomRef = doc(db, "fence_rooms", code);
  Object.assign(T, { code, roomRef, room: null, players: [], graded: new Map(), queue: Promise.resolve(), ending: false, sel: null, boardKey: null, answer: false });
  $("tCode").textContent = code;
  showScreen("teacher");
  await syncClock(roomRef, "touchedAt");

  T.unsubs.push(onSnapshot(roomRef, (s) => {
    if (!s.exists()) return;
    T.room = s.data(EST);
    if (T.sel === null) T.sel = T.room.level || 1;
    renderTeacher();
    gradePending();
  }));
  T.unsubs.push(onSnapshot(collection(db, "fence_rooms", code, "players"), (qs) => {
    T.players = qs.docs.map((d) => ({ id: d.id, ...d.data(EST) }));
    renderTeacher();
    gradePending();
  }));
  T.tick = setInterval(teacherTick, 250);
}

const pRefOf = (id) => doc(db, "fence_rooms", T.code, "players", id);
const times = () => (T.room && T.room.times) || DEFAULT_TIMES;
const pts = () => ({ ...DEFAULT_PTS, ...((T.room && T.room.pts) || {}) });

function playerState(p, r) {
  if (!r || r.round < 1) return { cls: "", txt: "대기 중" };
  const res = p.result && p.result.round === r.round ? p.result : (T.graded.get(r.round + "|" + p.id) || null);
  if (res && res !== "pending") {
    if (res.correct) return { cls: "ok", txt: `✅ ${res.rank}등 · +${res.points}점`, done: true, ok: true };
    if (res.reason === "wrong") return { cls: "bad", txt: "❌ 오답", done: true, bad: true };
    return { cls: "bad", txt: "⏰ 시간 초과", done: true, late: true };
  }
  if (p.sub && p.sub.round === r.round) return { cls: "wait", txt: "📮 채점 중…" };
  if (r.status === "playing") return { cls: "", txt: "✏️ 푸는 중", solving: true };
  return { cls: "", txt: "대기 중" };
}

function renderTeacher() {
  const r = T.room;
  if (!r) return;
  const playing = r.status === "playing";
  $("tCount").textContent = T.players.length;

  // 단계 버튼
  $("levelBtns").innerHTML = PUZZLES.map((L, i) => {
    const lv = i + 1, info = levelInfo(lv);
    return `<button class="level-btn ${lv === T.sel ? "active" : ""}" data-lv="${lv}" ${playing ? "disabled" : ""}>
      <b>${lv}단계</b>${info.size}<br><small>${info.kind} · ${fmtTime(times()[i])}</small></button>`;
  }).join("");
  $("timeLabel").textContent = fmtTime(times()[T.sel - 1]);
  $("timeMinus").disabled = $("timePlus").disabled = playing;
  $("startBtn").classList.toggle("hidden", playing);
  $("endBtn").classList.toggle("hidden", !playing);
  $("startBtn").textContent = r.round > 0 ? `▶ ${r.round + 1}라운드 스타트` : "▶ 스타트";

  // 문제판
  if (r.round > 0 && r.puzzle) {
    $("tRoundInfo").textContent = `${r.round}라운드 · ${levelLabel(r.level)}${r.status === "ended" ? " · 끝" : ""}`;
    if (T.boardKey !== r.round) {
      T.boardKey = r.round; T.answer = false;
      tBoard.load(r.puzzle.w, r.puzzle.h, r.puzzle.c);
    }
    $("answerBtn").classList.toggle("hidden", r.status !== "ended");
    $("answerBtn").textContent = T.answer ? "🙈 정답 숨기기" : "✅ 정답 보기";
  } else {
    $("answerBtn").classList.add("hidden");
  }
  if (!playing) { $("tTimer").textContent = ""; $("tTimer").classList.remove("warn"); }

  // 학생 카드
  const list = ranked(T.players.map((p) => ({ ...p })));
  let nOk = 0, nBad = 0, nSolve = 0, nWait = 0;
  $("tPlayers").innerHTML = list.length ? list.map((p) => {
    const st = playerState(p, r);
    if (st.ok) nOk++; else if (st.done) nBad++; else if (st.solving) nSolve++; else if (st.cls === "wait") nWait++;
    return `<div class="pc ${st.cls}">
      <div class="pc-top"><span class="pc-name">${esc(p.name)}</span><span class="pc-score">${p.score || 0}점</span></div>
      <div class="pc-rank">${p.rank}등</div>
      <div class="pc-st">${st.txt}</div>
      <button class="kick" data-kick="${esc(p.id)}" title="내보내기">✕</button>
    </div>`;
  }).join("") : `<div class="empty">학생들이 방 번호 <b>${esc(T.code)}</b>로 들어오면 여기에 나타나요.</div>`;
  $("tSummary").textContent = r.round > 0
    ? `정답 ${nOk} · 틀림/시간 초과 ${nBad} · 채점 중 ${nWait} · 푸는 중 ${nSolve}` : "";

  if (!$("rankOverlay").classList.contains("hidden")) renderBigRank();
}

function renderBigRank() {
  const list = ranked(T.players.map((p) => ({ ...p })));
  const medal = (n) => (n === 1 ? "🥇" : n === 2 ? "🥈" : n === 3 ? "🥉" : n);
  $("bigRank").innerHTML = list.map((p) =>
    `<li class="${p.rank <= 3 ? "top" + p.rank : ""}"><span class="no">${medal(p.rank)}</span><span class="nm">${esc(p.name)}</span><span class="sc">${p.score || 0}점</span></li>`
  ).join("") || "<li>아직 학생이 없어요.</li>";
}

function teacherTick() {
  const r = T.room;
  if (!r || r.status !== "playing") return;
  const end = endAtOf(r);
  if (end === null) return;
  const left = (end - now()) / 1000;
  $("tTimer").textContent = fmtTime(left);
  $("tTimer").classList.toggle("warn", left <= 10 && left > 0);
  if (now() > end + GRACE_MS + 800) return endRound();
  // 모두 채점이 끝나면 라운드 자동 종료
  if (T.players.length && T.players.every((p) => playerState(p, r).done)) endRound();
}

// ----- 채점 (교사 화면이 맡음) -----
function gradePending() {
  const r = T.room;
  if (!r || r.status !== "playing") return;
  const round = r.round;
  const pend = T.players
    .filter((p) => p.sub && p.sub.round === round && ms(p.sub.at) &&
      !(p.result && p.result.round === round) && !T.graded.has(round + "|" + p.id))
    .sort((a, b) => ms(a.sub.at) - ms(b.sub.at));
  for (const p of pend) {
    T.graded.set(round + "|" + p.id, "pending");
    T.queue = T.queue.then(() => gradeOne(p, round)).catch((e) => {
      console.error(e);
      T.graded.delete(round + "|" + p.id);
    });
  }
}

function correctCount(round) {
  const names = new Set();
  T.players.forEach((p) => { if (p.result && p.result.round === round && p.result.correct) names.add(p.id); });
  T.graded.forEach((v, k) => { if (v && v.correct && k.startsWith(round + "|")) names.add(k.slice(k.indexOf("|") + 1)); });
  return names.size;
}

async function gradeOne(p, round) {
  const r = T.room;
  if (!r || r.round !== round) return;
  const end = endAtOf(r);
  const late = end !== null && ms(p.sub.at) > end + GRACE_MS;
  const ok = !late && checkSolution(r.puzzle.w, r.puzzle.h, r.puzzle.c, decodeEdges(p.sub.edges));
  let rank = 0, points = 0;
  if (ok) {
    rank = correctCount(round) + 1;
    const P = pts();
    points = Math.max(P.min, P.first - (rank - 1));
  }
  const result = { round, correct: ok, rank, points, reason: ok ? "ok" : late ? "late" : "wrong" };
  T.graded.set(round + "|" + p.id, result);
  await updateDoc(pRefOf(p.id), { result, score: increment(points) });
}

async function endRound() {
  const r = T.room;
  if (T.ending || !r || r.status !== "playing") return;
  T.ending = true;
  try {
    gradePending();
    await T.queue;
    const round = r.round;
    const batch = writeBatch(db);
    T.players.forEach((p) => {
      const has = (p.result && p.result.round === round) || T.graded.has(round + "|" + p.id);
      const sub = p.sub && p.sub.round === round;
      if (!has && !sub) batch.update(pRefOf(p.id), { result: { round, correct: false, rank: 0, points: 0, reason: "timeout" } });
    });
    batch.update(T.roomRef, { status: "ended", endedAt: serverTimestamp() });
    await batch.commit();
  } catch (e) {
    console.error(e); toast("라운드를 끝내지 못했어요. 다시 눌러 주세요.");
  } finally { T.ending = false; }
}

async function startRound() {
  const r = T.room;
  if (!r || r.status === "playing") return;
  const lv = T.sel, L = PUZZLES[lv - 1];
  const used = (r.used && r.used["L" + lv]) || [];
  let cand = L.puzzles.map((_, i) => i).filter((i) => !used.includes(i));
  const reset = !cand.length;
  if (reset) cand = L.puzzles.map((_, i) => i);
  const pid = cand[Math.floor(Math.random() * cand.length)];
  $("startBtn").disabled = true;
  try {
    await updateDoc(T.roomRef, {
      status: "playing", round: (r.round || 0) + 1, level: lv, pid,
      puzzle: { w: L.w, h: L.h, c: L.puzzles[pid].c },
      startAt: serverTimestamp(), duration: times()[lv - 1],
      [`used.L${lv}`]: reset ? [pid] : arrayUnion(pid)
    });
  } catch (e) { console.error(e); toast("시작하지 못했어요. 다시 눌러 주세요."); }
  finally { $("startBtn").disabled = false; }
}

// ----- 교사 버튼 -----
$("levelBtns").addEventListener("click", (e) => {
  const b = e.target.closest("[data-lv]");
  if (!b || b.disabled) return;
  T.sel = Number(b.dataset.lv);
  renderTeacher();
});
function changeTime(d) {
  const arr = [...times()];
  arr[T.sel - 1] = Math.min(1800, Math.max(30, arr[T.sel - 1] + d));
  updateDoc(T.roomRef, { times: arr }).catch(() => toast("시간을 바꾸지 못했어요."));
}
$("timeMinus").addEventListener("click", () => changeTime(-30));
$("timePlus").addEventListener("click", () => changeTime(30));
$("startBtn").addEventListener("click", startRound);
$("endBtn").addEventListener("click", async () => {
  if (await confirmBox("지금 라운드를 끝낼까요?\n아직 제출하지 않은 학생은 0점이에요.", "끝내기")) endRound();
});
$("answerBtn").addEventListener("click", () => {
  const r = T.room;
  if (!r || !r.puzzle) return;
  T.answer = !T.answer;
  tBoard.showAnswer(T.answer ? decodeAnswer(PUZZLES[r.level - 1].puzzles[r.pid].a) : null);
  renderTeacher();
});
$("tPlayers").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-kick]");
  if (!b) return;
  const id = b.dataset.kick;
  if (await confirmBox(`${id} 학생을 방에서 내보낼까요?\n점수도 함께 지워져요.`, "내보내기")) {
    deleteDoc(pRefOf(id)).catch(() => toast("내보내지 못했어요."));
  }
});
$("tRankBtn").addEventListener("click", () => { renderBigRank(); $("rankOverlay").classList.remove("hidden"); });
$("rankClose").addEventListener("click", () => $("rankOverlay").classList.add("hidden"));
$("tPtsBtn").addEventListener("click", () => {
  const P = pts();
  $("ptsFirst").value = P.first; $("ptsMin").value = P.min;
  $("ptsModal").classList.remove("hidden");
});
$("ptsCancel").addEventListener("click", () => $("ptsModal").classList.add("hidden"));
$("ptsSave").addEventListener("click", async () => {
  const first = Math.round(Number($("ptsFirst").value)), min = Math.round(Number($("ptsMin").value));
  if (!(first >= 1 && first <= 100 && min >= 0 && min <= first)) return toast("1등 점수는 1~100, 최소 점수는 0~1등 점수 사이로 정해 주세요.");
  try { await updateDoc(T.roomRef, { pts: { first, min } }); $("ptsModal").classList.add("hidden"); toast("점수 설정을 저장했어요."); }
  catch (e) { toast("저장하지 못했어요."); }
});
$("tResetBtn").addEventListener("click", async () => {
  if (T.room && T.room.status === "playing") return toast("라운드가 끝난 뒤에 초기화할 수 있어요.");
  if (!(await confirmBox("모든 학생의 점수를 0점으로 되돌릴까요?", "초기화"))) return;
  try {
    const batch = writeBatch(db);
    T.players.forEach((p) => batch.update(pRefOf(p.id), { score: 0, result: deleteField(), sub: deleteField(), edges: "" }));
    batch.update(T.roomRef, { status: "waiting" });
    await batch.commit();
    toast("점수를 초기화했어요.");
  } catch (e) { console.error(e); toast("초기화하지 못했어요."); }
});
$("tNewRoomBtn").addEventListener("click", async () => {
  if (!(await confirmBox("새 방을 만들까요?\n학생들은 새 방 번호로 다시 들어와야 해요.", "새 방 만들기"))) return;
  try { const code = await createRoom(); startTeacher(code); }
  catch (e) { toast(e.userMsg || "새 방을 만들지 못했어요."); }
});
$("tLeave").addEventListener("click", () => { stopTeacher(); showScreen("entry"); });
