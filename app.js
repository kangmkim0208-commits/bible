import { CONFIG } from './config.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const KINDS = ['모세오경과 역사서', '시가서와 선지서', '신약과 시편'];
const COLORS = ['var(--r1)', 'var(--r2)', 'var(--r3)'];
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

let BOOKS = [], BMAP = {}, PLAN = [], TOTAL = 0, STREAM_OF = {};
let store = null;
let state = { day: 0, view: 'today' };
const bibleCache = {};

// ── 날짜 ─────────────────────────────────────────
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
function todayOffset() {
  const t = parse(ymd(new Date())), s = parse(PLAN[0].d);
  return Math.round((t - s) / 864e5);
}
const clampDay = (i) => Math.max(0, Math.min(PLAN.length - 1, i));
function dateLabel(s) { const d = parse(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`; }

// ── 장 표기 ──────────────────────────────────────
const unit = (code) => (code === 'PSA' ? '편' : '장');
function refLabel(ref) { const [c, n] = ref.split('.'); return `${BMAP[c].name} ${n}${unit(c)}`; }
function refShort(ref) { const [c, n] = ref.split('.'); return `${BMAP[c].abbr} ${n}`; }
const dayRefs = (i) => PLAN[i].s.flat();
function partShort(p) {
  const [c1, n1] = p[0].split('.');
  if (p.length === 1) return refShort(p[0]);
  const [c2, n2] = p[p.length - 1].split('.');
  return c1 === c2 ? `${BMAP[c1].abbr} ${n1}–${n2}` : p.map(refShort).join(', ');
}

// ── 저장소: 미리보기(이 기기) ─────────────────────
function demoStore() {
  const names = CONFIG.demoNames || [];
  const members = [{ id: 'a', name: names[0] || '나' }, { id: 'b', name: names[1] || '함께 읽는 사람' }];
  let data = ls.get('demo-read', null);
  if (!data) { data = { a: {}, b: { 'GEN.1': 1, 'MAT.1': 1 } }; ls.set('demo-read', data); }
  let pos = ls.get('demo-pos', null);
  if (!pos) { pos = { a: {}, b: { 'EZR.1': 6 } }; ls.set('demo-pos', pos); }
  let meId = ls.get('demo-me', 'a');
  const subs = new Set();
  const emit = () => subs.forEach((f) => f());
  return {
    mode: 'demo', members,
    get me() { return members.find((m) => m.id === meId); },
    isRead: (id, ref) => !!(data[id] && data[id][ref]),
    count: (id) => Object.keys(data[id] || {}).length,
    getPos: (id, ref) => (pos[id] && pos[id][ref]) || 0,
    async toggle(ref, on) {
      data[meId] = data[meId] || {};
      if (on) { data[meId][ref] = Date.now(); if (pos[meId]) delete pos[meId][ref]; } else delete data[meId][ref];
      ls.set('demo-read', data); ls.set('demo-pos', pos); emit();
    },
    async setPos(ref, v) {
      pos[meId] = pos[meId] || {};
      if (v) pos[meId][ref] = v; else delete pos[meId][ref];
      ls.set('demo-pos', pos); emit();
    },
    switchMe() { meId = meId === 'a' ? 'b' : 'a'; ls.set('demo-me', meId); emit(); },
    onChange(f) { subs.add(f); }
  };
}

// ── 저장소: Firebase (두 사람 공유) ───────────────
const toKey = (ref) => ref.replace('.', '_');
const fromKey = (k) => k.replace('_', '.');

async function firebaseStore() {
  const fb = await import('./vendor/firebase.js');
  const app = fb.initializeApp(CONFIG.firebase);
  const auth = fb.getAuth(app);
  const db = fb.getFirestore(app);
  try { await fb.getRedirectResult(auth); } catch (e) { console.warn(e); }
  const signOut = () => fb.signOut(auth).then(() => location.reload());

  const user = await new Promise((res) => { const off = fb.onAuthStateChanged(auth, (u) => { off(); res(u); }); });
  if (!user) return { mode: 'signin', async signIn() {
    const p = new fb.GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });
    try { await fb.signInWithPopup(auth, p); location.reload(); }
    catch (e) {
      if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e.code)) await fb.signInWithRedirect(auth, p);
      else if (e.code !== 'auth/popup-closed-by-user') toast('로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    }
  } };

  const email = (user.email || '').toLowerCase();
  const myDoc = fb.doc(db, 'progress', user.uid);
  let snap;
  try { snap = await fb.getDoc(myDoc); }
  catch (e) {
    if (e.code === 'permission-denied') return { mode: 'denied', email, signOut };
    console.error(e); return { mode: 'error', signOut };
  }
  const suggested = (user.displayName || '').trim().split(/\s+/).pop() || '';
  if (!snap.exists()) return { mode: 'setup', suggested, signOut, async save(name) {
    await fb.setDoc(myDoc, { email, name, read: {} }); location.reload();
  } };

  const me = { id: user.uid, name: snap.data().name || '나' };
  let members = [me];
  const read = { [me.id]: {} }, pos = { [me.id]: {} };
  const subs = new Set();
  const emit = () => subs.forEach((f) => f());

  fb.onSnapshot(fb.collection(db, 'progress'), (qs) => {
    const next = [];
    qs.forEach((d) => {
      const v = d.data();
      if (d.id === me.id) { me.name = v.name || me.name; next.unshift(me); }
      else next.push({ id: d.id, name: v.name || '함께 읽는 사람' });
      const fresh = {}, fp = {};
      Object.keys(v.read || {}).forEach((k) => (fresh[fromKey(k)] = 1));
      Object.entries(v.pos || {}).forEach(([k, n]) => { if (Number(n) > 0) fp[fromKey(k)] = Number(n); });
      read[d.id] = fresh; pos[d.id] = fp;
    });
    if (!next.includes(me)) next.unshift(me);
    members = next;
    emit();
  }, (e) => { console.error(e); toast('기록을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'); });

  return {
    mode: 'live', me,
    get members() { return members; },
    isRead: (id, ref) => !!(read[id] && read[id][ref]),
    count: (id) => Object.keys(read[id] || {}).length,
    getPos: (id, ref) => (pos[id] && pos[id][ref]) || 0,
    async setPos(ref, v) {
      const old = pos[me.id][ref];
      if (v) pos[me.id][ref] = v; else delete pos[me.id][ref];
      emit();
      try {
        if (v) await fb.setDoc(myDoc, { pos: { [toKey(ref)]: v } }, { merge: true });
        else await fb.updateDoc(myDoc, new fb.FieldPath('pos', toKey(ref)), fb.deleteField());
      } catch (e) {
        console.error(e);
        if (old) pos[me.id][ref] = old; else delete pos[me.id][ref];
        emit(); toast('저장하지 못했어요. 인터넷 연결을 확인해 주세요.');
      }
    },
    async toggle(ref, on) {
      const hadPos = pos[me.id][ref];
      if (on) { read[me.id][ref] = 1; delete pos[me.id][ref]; } else delete read[me.id][ref];
      emit();
      try {
        if (on) {
          await fb.setDoc(myDoc, { read: { [toKey(ref)]: fb.serverTimestamp() } }, { merge: true });
          if (hadPos) await fb.updateDoc(myDoc, new fb.FieldPath('pos', toKey(ref)), fb.deleteField());
        }
        else await fb.updateDoc(myDoc, new fb.FieldPath('read', toKey(ref)), fb.deleteField());
      } catch (e) {
        console.error(e);
        if (on) delete read[me.id][ref]; else read[me.id][ref] = 1;
        emit(); toast('저장하지 못했어요. 인터넷 연결을 확인해 주세요.');
      }
    },
    async rename(name) {
      try { await fb.updateDoc(myDoc, { name }); me.name = name; emit(); }
      catch (e) { console.error(e); toast('이름을 바꾸지 못했어요.'); }
    },
    signOut,
    onChange(f) { subs.add(f); }
  };
}

// ── 통계 ─────────────────────────────────────────
function stats(id) {
  const t = Math.min(todayOffset(), PLAN.length - 1);
  let due = 0, behind = 0;
  for (let i = 0; i <= t; i++) for (const r of dayRefs(i)) { due++; if (!store.isRead(id, r)) behind++; }
  return { read: store.count(id), due, behind };
}
// 지난 날짜(오늘 제외) 분량 중 아직 안 읽은 장
function overdue(id) {
  const t = Math.min(todayOffset(), PLAN.length);
  const out = [];
  for (let i = 0; i < t; i++) for (const r of dayRefs(i)) if (!store.isRead(id, r)) out.push({ i, ref: r });
  return out;
}
function daysTogether() {
  let n = 0;
  for (let i = 0; i < PLAN.length; i++) if (dayRefs(i).every((r) => store.members.every((m) => store.isRead(m.id, r)))) n++;
  return n;
}
function dayStatus(id, i) {
  const rs = dayRefs(i), k = rs.filter((r) => store.isRead(id, r)).length;
  if (k === rs.length) return 'full';
  return k || rs.some((r) => store.getPos(id, r)) ? 'half' : '';
}

// ── 화면 ─────────────────────────────────────────
const others = () => store.members.filter((m) => m.id !== store.me.id);

function shell(inner) {
  const demo = store.mode === 'demo' ? `<div class="demo"><div class="wrap">
      <span>미리보기 모드라 이 기기에만 저장돼요. 체크하는 사람: <b>${esc(store.me.name)}</b></span>
      <span style="display:flex;gap:6px"><button class="chip" data-act="switch">체크하는 사람 바꾸기</button></span>
    </div></div>` : '';
  return `<header class="top"><div class="wrap"><span class="brand">함께 읽는 성경</span>
      ${store.mode === 'live' ? `<span style="display:flex;gap:2px"><button class="who" data-act="rename">${esc(store.me.name)}님</button><button class="who" data-act="signout">로그아웃</button></span>` : ''}
    </div></header>${demo}<main><div class="wrap">${inner}</div></main>
    <nav class="tabs"><div class="wrap">
      <a href="#today" ${state.view === 'today' ? 'aria-current="page"' : ''}>오늘</a>
      <a href="#catchup" ${state.view === 'catchup' ? 'aria-current="page"' : ''}>몰아 보기${(() => { const n = overdue(store.me.id).length; return n ? ` <span class="badge" aria-label="밀린 장 ${n}개">${n > 99 ? '99+' : n}</span>` : ''; })()}</a>
      <a href="#plan" ${state.view === 'plan' ? 'aria-current="page"' : ''}>읽기표</a>
    </div></nav>`;
}

function markBtn(m, ref) {
  const on = store.isRead(m.id, ref), mine = m.id === store.me.id;
  const v = on ? 0 : store.getPos(m.id, ref);
  const cls = on ? ' on' : v ? ' part' : '';
  const label = `${m.name} ${on ? '읽음' : v ? `${v}절까지 읽음` : '안 읽음'}`;
  const inner = `<span>${esc(m.name)}${v ? `<small>${v}절</small>` : ''}</span>`;
  return mine
    ? `<button class="mark${cls}" data-act="toggle" data-ref="${ref}" aria-pressed="${on}" aria-label="${esc(label)}, 눌러서 다 읽음으로 바꾸기">${inner}</button>`
    : `<span class="mark them${cls}" role="img" aria-label="${esc(label)}">${inner}</span>`;
}

function todayView() {
  const t = todayOffset(), i = state.day, day = PLAN[i];
  let sub;
  if (t < 0) sub = `${-t}일 뒤 ${dateLabel(PLAN[0].d).replace(/ \S+요일$/, '')}에 시작해요. 첫날 분량을 미리 볼 수 있어요.`;
  else if (i === t) sub = '오늘 읽을 분량이에요.';
  else sub = i < t ? `${t - i}일 전 분량이에요.` : `${i - t}일 뒤 분량이에요.`;
  const ordered = [store.me, ...others()];
  const ribs = day.s.map((part, si) => `<section class="rib" style="--c:${COLORS[si]}">
      <p class="kind">${KINDS[si]}</p>
      ${part.map((ref) => `<div class="row">
        <button class="open" data-act="read" data-ref="${ref}">${esc(refLabel(ref))}</button>
        <div class="marks">${ordered.map((m) => markBtn(m, ref)).join('')}</div>
      </div>`).join('')}
    </section>`).join('');
  const people = ordered.map((m) => {
    const s = stats(m.id), pct = (s.read / TOTAL) * 100;
    const note = t < 0 ? '' : s.behind ? `<p class="note late">오늘까지 분량 중 ${s.behind}장이 남았어요.</p>` : `<p class="note">오늘까지 분량을 다 읽었어요.</p>`;
    return `<div class="person"><div class="line1"><b>${esc(m.name)}</b><span class="num">${s.read.toLocaleString()} / ${TOTAL.toLocaleString()}장 (${pct < 1 && s.read ? pct.toFixed(1) : Math.round(pct)}%)</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>${note}</div>`;
  }).join('');
  return `<div class="head">
      <h1 class="date">${dateLabel(day.d)}</h1>
      <p class="sub">${sub}</p>
      <div class="nav">
        <button data-act="prev" aria-label="전날" ${i === 0 ? 'disabled' : ''}>‹</button>
        <button data-act="next" aria-label="다음날" ${i === PLAN.length - 1 ? 'disabled' : ''}>›</button>
        ${i !== clampDay(t) ? `<button class="today-btn" data-act="goto-today">${t < 0 ? '첫날로' : '오늘로'}</button>` : ''}
        <span class="spacer"></span><span class="dayno">${i + 1} / ${PLAN.length}일째</span>
      </div>
    </div>
    <div class="page">${ribs}</div>
    <p class="legend">${esc(store.me.name)} 버튼을 누르면 다 읽음으로 바뀌어요. 중간까지 읽었다면 장 이름을 눌러 본문에서 멈춘 절을 눌러 주세요.${others().length ? ` ${others().map((m) => esc(m.name)).join(', ')} 표시는 그쪽 휴대폰에서 체크하면 여기에도 바로 보여요.` : ''}</p>
    <section class="sec"><h2>전체 진도</h2>${people}
      ${others().length ? '' : '<p class="note">함께 읽을 사람이 아직 로그인하지 않았어요. 처음 로그인하면 여기에 함께 보여요.</p>'}
      <div class="together">두 사람 모두 그날 분량을 마친 날: ${daysTogether()}일</div>
    </section>`;
}

function monthsList() {
  const months = [];
  PLAN.forEach((d, i) => {
    const key = d.d.slice(0, 7);
    if (!months.length || months[months.length - 1].key !== key) months.push({ key, days: [] });
    months[months.length - 1].days.push(i);
  });
  return months;
}
const monthName = (key) => `${key.slice(0, 4)}년 ${Number(key.slice(5))}월`;

function planView() {
  const t = todayOffset(), ordered = [store.me, ...others()];
  const months = monthsList();
  if (!state.month) state.month = PLAN[clampDay(t)].d.slice(0, 7);
  const mi = Math.max(0, months.findIndex((m) => m.key === state.month));
  const m = months[mi];
  const chips = months.map((x) => `<button class="chip${x.key === m.key ? ' cur' : ''}" data-act="month" data-m="${x.key}" ${x.key === m.key ? 'aria-current="true"' : ''}>${Number(x.key.slice(5))}월</button>`).join('');
  const rows = m.days.map((i) => {
    const d = parse(PLAN[i].d);
    return `<button class="day${i === t ? ' is-today' : ''}" data-act="day" data-i="${i}">
        <span class="dt">${d.getMonth() + 1}/${d.getDate()} ${WD[d.getDay()]}</span>
        <span class="refs">${PLAN[i].s.map((p, si) => `<span style="--c:${COLORS[si]}">${partShort(p)}</span>`).join('')}</span>
        <span class="dots">${ordered.map((p) => { const st = dayStatus(p.id, i); return `<span class="dot ${st}${i < t && st !== 'full' ? ' late' : ''}" title="${esc(p.name)}"></span>`; }).join('')}</span>
      </button>`;
  }).join('');
  return `<div class="months" id="months">${chips}</div>
    <div class="mhead">
      <button data-act="month" data-m="${mi > 0 ? months[mi - 1].key : ''}" aria-label="이전 달" ${mi === 0 ? 'disabled' : ''}>‹</button>
      <h1>${monthName(m.key)}</h1>
      <button data-act="month" data-m="${mi < months.length - 1 ? months[mi + 1].key : ''}" aria-label="다음 달" ${mi === months.length - 1 ? 'disabled' : ''}>›</button>
    </div>
    <p class="sub" style="margin:0 0 10px">오른쪽 점은 ${ordered.map((p) => esc(p.name)).join(', ')} 순서예요. 빨간 테두리는 날짜가 지났는데 다 못 읽은 날이에요.</p>
    ${rows}`;
}

function catchupView() {
  const t = todayOffset();
  const head = (sub) => `<div class="head"><h1 class="date">몰아 보기</h1><p class="sub">${sub}</p></div>`;
  if (t <= 0) return head(t < 0 ? '아직 시작 전이에요. 날짜가 지났는데 못 읽은 장이 생기면 여기에 모여요.' : '첫날이라 아직 밀린 장이 없어요. 날짜가 지났는데 못 읽은 장이 생기면 여기에 모여요.');
  const mine = overdue(store.me.id);
  const people = [store.me, ...others()].map((m) => {
    const n = m.id === store.me.id ? mine.length : overdue(m.id).length;
    return `<div class="person"><div class="line1"><b>${esc(m.name)}</b><span class="num${n ? ' late' : ''}">${n ? `밀린 장 ${n}장` : '밀린 장 없음'}</span></div></div>`;
  }).join('');
  if (!mine.length) return head('지난 날짜 분량을 모두 읽었어요. 오늘 분량만 읽으면 돼요.') + `<section class="sec" style="padding-top:0">${people}</section>`;
  const groups = [];
  mine.forEach((x) => { if (!groups.length || groups[groups.length - 1].i !== x.i) groups.push({ i: x.i, refs: [] }); groups[groups.length - 1].refs.push(x.ref); });
  const list = groups.map((g) => {
    const d = parse(PLAN[g.i].d);
    return `<div class="cgroup"><p class="cdate"><b>${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일</b><span>${t - g.i}일 전</span></p>
      ${g.refs.map((ref) => `<div class="row crow" style="--c:${streamColor(ref)}">
        <button class="open" data-act="read" data-ctx="catchup" data-ref="${ref}">${esc(refLabel(ref))}</button>
        <div class="marks">${markBtn(store.me, ref)}</div>
      </div>`).join('')}</div>`;
  }).join('');
  return head(`날짜가 지났는데 아직 못 읽은 ${mine.length}장이에요. 오래된 날짜부터 모아 뒀어요.`) +
    `<button class="primary wide" data-act="read" data-ctx="catchup" data-ref="${mine[0].ref}">오래된 장부터 이어 읽기</button>
    <div class="clist">${list}</div>
    <section class="sec"><h2>두 사람 밀린 장</h2>${people}</section>`;
}

function render() {
  const keepY = window.scrollY;
  $('#app').innerHTML = shell(state.view === 'plan' ? planView() : state.view === 'catchup' ? catchupView() : todayView());
  const cur = document.querySelector('#months .cur');
  if (cur) { const box = cur.parentElement; box.scrollLeft = cur.offsetLeft - (box.clientWidth - cur.offsetWidth) / 2; }
  if (state.keepScroll) window.scrollTo(0, keepY);
  state.keepScroll = false;
  if (readerRef) paintReaderFoot();
}

// ── 본문 읽기 ────────────────────────────────────
let readerRef = null, readerFromHash = false, readerCtx = 'day', readerSel = 0, readerLen = 0;
async function loadBook(code) {
  if (!bibleCache[code]) bibleCache[code] = fetch(`bible/${code}.json`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  try { return await bibleCache[code]; } catch (e) { delete bibleCache[code]; throw e; }
}
function streamColor(ref) { const si = STREAM_OF[ref]; return COLORS[si] || 'var(--ink)'; }

async function openReader(ref, push = true) {
  readerRef = ref; readerSel = 0; readerLen = 0;
  const [code, n] = ref.split('.'), b = BMAP[code];
  const el = $('#reader');
  el.style.setProperty('--c', streamColor(ref));
  el.style.setProperty('--fs', ls.get('fs', 18) + 'px');
  $('#rtitle').innerHTML = `<i aria-hidden="true"></i>${esc(refLabel(ref))}`;
  $('#verses').innerHTML = '<p class="loading">본문을 불러오는 중…</p>';
  $('#src').innerHTML = `성경전서 개역한글판 (대한성서공회)<br><a href="https://www.bskorea.or.kr/bible/korbibReadpage.php?version=GAE&book=${b.bsk}&chap=${n}" target="_blank" rel="noopener">개역개정으로 보기 (대한성서공회 사이트)</a>`;
  el.classList.add('show');
  document.body.style.overflow = 'hidden';
  if (push) { readerFromHash = true; history.pushState(null, '', `#r-${code}-${n}`); }
  else if (location.hash !== `#r-${code}-${n}`) history.replaceState(null, '', `#r-${code}-${n}`);
  lastHash = `r-${code}-${n}`;
  paintReaderFoot();
  $('#rbody').scrollTop = 0;
  try {
    const book = await loadBook(code);
    if (readerRef !== ref) return;
    const vs = book.chapters[Number(n) - 1] || [];
    readerLen = vs.length;
    $('#verses').innerHTML = `<p class="hint">멈춘 절을 누르면 거기까지 읽었다고 표시할 수 있어요.</p>` +
      vs.map((v, k) => `<p class="v" data-v="${k + 1}"><span class="n">${k + 1}</span><span>${esc(v)}</span></p>`).join('');
    paintMarker();
    const at = store.getPos(store.me.id, ref);
    const target = at && document.querySelector(`#verses .v[data-v="${Math.min(at + 1, readerLen)}"]`);
    if (target) $('#rbody').scrollTop = target.offsetTop - 90;
  } catch {
    $('#verses').innerHTML = '<p class="loading">본문을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 열어 주세요.</p>';
  }
  $('#done').focus({ preventScroll: true });
}
function paintReaderFoot() {
  const ref = readerRef, on = store.isRead(store.me.id, ref), at = store.getPos(store.me.id, ref);
  const notes = others().map((m) => store.isRead(m.id, ref) ? `${esc(m.name)}도 이 장을 읽었어요.` : store.getPos(m.id, ref) ? `${esc(m.name)} ${store.getPos(m.id, ref)}절까지 읽음` : '').filter(Boolean);
  $('#pnote').innerHTML = notes.join(' ');
  const btn = $('#done');
  btn.className = 'done' + (on ? ' is-read' : '');
  btn.textContent = on ? '읽음 표시됨 (누르면 취소)' : '다 읽었어요';
  const here = $('#here');
  if (readerSel && !on) {
    here.hidden = false;
    here.textContent = readerSel === at ? `${at}절 표시 지우기` : readerSel === readerLen ? '끝 절이에요. 다 읽음으로 표시하기' : `${readerSel}절까지 읽었어요`;
  } else here.hidden = true;
  paintMarker();
}
function paintMarker() {
  document.querySelectorAll('#verses .v').forEach((p) => {
    const v = Number(p.dataset.v);
    p.classList.toggle('sel', v === readerSel);
    p.classList.toggle('upto', !!readerRef && v === store.getPos(store.me.id, readerRef) && !store.isRead(store.me.id, readerRef));
  });
}
function closeReader(fromPop = false) {
  readerRef = null;
  $('#reader').classList.remove('show');
  document.body.style.overflow = '';
  if (!fromPop) { if (readerFromHash) history.back(); else { history.replaceState(null, '', `#${state.view}`); lastHash = state.view; render(); } }
  readerFromHash = false;
}
function nextOverdue(ref) {
  const x = overdue(store.me.id).find((o) => o.ref !== ref);
  return x && x.ref;
}
function nextInDay(ref) {
  const rs = dayRefs(state.day), k = rs.indexOf(ref);
  return rs.slice(k + 1).concat(rs.slice(0, k)).find((r) => !store.isRead(store.me.id, r));
}

// ── 이벤트 ───────────────────────────────────────
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }

let lastHash = null;
function route() {
  const h = location.hash.slice(1);
  if (h === lastHash) return;
  lastHash = h;
  const m = h.match(/^r-([0-9A-Z]{3})-(\d+)$/);
  if (m && BMAP[m[1]]) {
    if (!$('.tabs')) render();
    if (readerRef !== `${m[1]}.${m[2]}`) openReader(`${m[1]}.${m[2]}`, false);
    return;
  }
  if (readerRef) closeReader(true);
  const prev = state.view;
  state.view = h === 'plan' || h === 'catchup' ? h : 'today';
  const changed = prev !== state.view || !$('.tabs');
  state.keepScroll = !changed;
  render();
  if (!changed) return;
  window.scrollTo(0, 0);
}

function bind() {
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'toggle') { const r = b.dataset.ref; state.keepScroll = true; await store.toggle(r, !store.isRead(store.me.id, r)); }
    else if (a === 'read') { readerCtx = b.dataset.ctx || 'day'; openReader(b.dataset.ref); }
    else if (a === 'prev' || a === 'next') { state.day = clampDay(state.day + (a === 'prev' ? -1 : 1)); render(); }
    else if (a === 'goto-today') { state.day = clampDay(todayOffset()); render(); }
    else if (a === 'day') { state.day = Number(b.dataset.i); location.hash = 'today'; }
    else if (a === 'month') { if (!b.dataset.m) return; state.month = b.dataset.m; render(); window.scrollTo(0, 0); }
    else if (a === 'switch') { state.keepScroll = true; store.switchMe(); }
    else if (a === 'signout') store.signOut();
    else if (a === 'rename') {
      const n = (window.prompt('앱에 보일 이름을 적어 주세요.', store.me.name) || '').trim().slice(0, 12);
      if (n && n !== store.me.name) store.rename(n);
    }
  });
  $('#rclose').addEventListener('click', () => closeReader());
  $('#verses').addEventListener('click', (e) => {
    const p = e.target.closest('.v');
    if (!p || !readerRef || store.isRead(store.me.id, readerRef)) return;
    if (window.getSelection && String(window.getSelection()).length) return;
    const v = Number(p.dataset.v);
    readerSel = readerSel === v ? 0 : v;
    paintReaderFoot();
  });
  $('#here').addEventListener('click', async () => {
    const ref = readerRef, v = readerSel, at = store.getPos(store.me.id, ref);
    if (!v) return;
    readerSel = 0;
    state.keepScroll = true;
    if (v === readerLen) { $('#done').click(); return; }
    if (v === at) { await store.setPos(ref, 0); toast('표시를 지웠어요.'); }
    else { await store.setPos(ref, v); toast(`${refLabel(ref)} ${v}절까지 표시했어요.`); }
    paintReaderFoot();
  });
  $('#done').addEventListener('click', async () => {
    const ref = readerRef, on = !store.isRead(store.me.id, ref);
    state.keepScroll = true;
    await store.toggle(ref, on);
    if (!on) return;
    const nx = readerCtx === 'catchup' ? nextOverdue(ref) : nextInDay(ref);
    if (nx) { toast(`${refLabel(ref)} 읽음. 다음은 ${refLabel(nx)}`); openReader(nx, false); }
    else { toast(readerCtx === 'catchup' ? '밀린 장을 다 읽었어요.' : dayRefs(state.day).includes(ref) ? '이날 분량을 다 읽었어요.' : `${refLabel(ref)} 읽음`); closeReader(); }
  });
  const fs = (d) => { const v = Math.max(15, Math.min(26, ls.get('fs', 18) + d)); ls.set('fs', v); $('#reader').style.setProperty('--fs', v + 'px'); };
  $('#fsup').addEventListener('click', () => fs(1));
  $('#fsdown').addEventListener('click', () => fs(-1));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && readerRef) closeReader(); });
  window.addEventListener('popstate', route);
  window.addEventListener('hashchange', route);
}

// ── 시작 ─────────────────────────────────────────
async function start() {
  try {
    [BOOKS, PLAN] = await Promise.all([fetch('data/books.json').then((r) => r.json()), fetch('data/plan.json').then((r) => r.json())]);
  } catch { $('#app').innerHTML = '<p class="loading">읽기표를 불러오지 못했어요. 새로고침해 주세요.</p>'; return; }
  BOOKS.forEach((b) => (BMAP[b.code] = b));
  PLAN.forEach((d) => d.s.forEach((p, si) => p.forEach((r) => (STREAM_OF[r] = si))));
  TOTAL = PLAN.reduce((n, d) => n + d.s.flat().length, 0);
  state.day = clampDay(todayOffset());

  store = CONFIG.firebase ? await firebaseStore() : demoStore();
  if (store.mode === 'signin') {
    $('#app').innerHTML = `<div class="center"><div><div class="ribbons-art" aria-hidden="true"><i style="--c:var(--r1)"></i><i style="--c:var(--r2)"></i><i style="--c:var(--r3)"></i></div>
      <h1>함께 읽는 성경</h1><p>1년에 한 번, 매일 세 곳을 나란히 읽어요. 초대받은 구글 계정으로 로그인해 주세요.</p>
      <button class="primary" id="signin">구글 계정으로 로그인</button></div></div>`;
    $('#signin').addEventListener('click', () => store.signIn());
    return;
  }
  if (store.mode === 'setup') {
    $('#app').innerHTML = `<div class="center"><div><h1>반가워요</h1><p>상대방 화면에 보일 이름을 정해 주세요. 나중에 위쪽 이름을 눌러 바꿀 수 있어요.</p>
      <form id="nf" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <input id="nm" maxlength="12" required value="${esc(store.suggested)}" aria-label="이름" style="font:inherit;font-size:16px;height:52px;padding:0 14px;border:1.5px solid var(--line);border-radius:14px;background:var(--paper);color:var(--ink);width:12em">
        <button class="primary">시작하기</button></form>
      <p style="margin-top:18px"><button class="who" id="so2" style="margin:auto">다른 계정으로 로그인</button></p></div></div>`;
    $('#nf').addEventListener('submit', (e) => { e.preventDefault(); const n = $('#nm').value.trim(); if (n) store.save(n.slice(0, 12)); });
    $('#so2').addEventListener('click', () => store.signOut());
    return;
  }
  if (store.mode === 'error') {
    $('#app').innerHTML = `<div class="center"><div><h1>연결하지 못했어요</h1><p>인터넷 연결을 확인하고 새로고침해 주세요. 계속 안 되면 Firebase 설정(config.js)과 Firestore 데이터베이스가 만들어져 있는지 확인해 주세요.</p>
      <button class="primary" onclick="location.reload()">새로고침</button></div></div>`;
    return;
  }
  if (store.mode === 'denied') {
    $('#app').innerHTML = `<div class="center"><div><h1>초대되지 않은 계정이에요</h1><p>${esc(store.email)} 계정은 이 읽기표에 등록되어 있지 않아요. 등록된 구글 계정으로 다시 로그인해 주세요. 등록은 Firebase 보안 규칙의 이메일 목록에서 해요.</p>
      <button class="primary" id="so">다른 계정으로 로그인</button></div></div>`;
    $('#so').addEventListener('click', () => store.signOut());
    return;
  }
  store.onChange(() => { state.keepScroll = true; render(); });
  bind();
  route();
}
start();
