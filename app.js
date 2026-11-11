// 주간 오답 실모 앱. 자료는 비공개 GitHub 저장소에 두고 GitHub API 로 읽고 쓴다.
//   inbox/<일요일>/<이름>.jpg + <이름>.json   틀린 문제 사진과 메모·분석 상태
//   app-data/exams/<일요일>-<과목>.json       실모 정보 (정답, 배점, 유형, PDF 경로). 과목: math | korean | english
//   app-data/results/<일요일>-<과목>.json     채점 결과
(() => {
  const $ = (id) => document.getElementById(id);
  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ── 날짜 (한국 시간 기준) ─────────────────────────────
  const kstToday = () => {
    const t = new Date(Date.now() + 9 * 3600e3);
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  };
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
  const fmtDate = (s) => { const [, m, d] = s.split('-').map(Number); return `${m}월 ${d}일`; };
  // 이번에 받을 실모의 일요일. 오늘이 일요일이고 오늘 실모가 이미 나왔으면 다음 주 일요일.
  function targetSunday() {
    const today = kstToday();
    const dow = today.getUTCDay();
    let sun = addDays(today, (7 - dow) % 7);
    if (dow === 0 && exams.some((e) => e.date === iso(today))) sun = addDays(today, 7);
    return iso(sun);
  }

  // ── GitHub API ─────────────────────────────────────
  let cfg = null;
  let token = store.get('gh-token');
  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  async function api(path, { method = 'GET', body, raw = false } = {}) {
    const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (!res.ok) throw new ApiError(res.status, `GitHub ${res.status}`);
    return res;
  }
  const b64FromBytes = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const b64FromText = (text) => b64FromBytes(new TextEncoder().encode(text));
  const textFromB64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

  async function listDir(dir) {
    try { return await (await api(`contents/${enc(dir)}?ref=${encodeURIComponent(cfg.branch)}`)).json(); }
    catch (e) { if (e.status === 404) return []; throw e; }
  }
  async function readJson(path) {
    try {
      const f = await (await api(`contents/${enc(path)}?ref=${encodeURIComponent(cfg.branch)}`)).json();
      return { data: JSON.parse(textFromB64(f.content)), sha: f.sha };
    } catch (e) { if (e.status === 404) return null; throw e; }
  }
  const readBlob = async (path) => (await api(`contents/${enc(path)}?ref=${encodeURIComponent(cfg.branch)}`, { raw: true })).blob();
  // 같은 브랜치에 연달아 쓰면 충돌(409)이 날 수 있어 한 번에 하나씩, 실패하면 한 번 더 시도한다.
  let writeQueue = Promise.resolve();
  function write(fn) {
    const run = writeQueue.then(async () => {
      try { return await fn(); }
      catch (e) { if (e.status !== 409) throw e; await new Promise((r) => setTimeout(r, 1200)); return fn(); }
    });
    writeQueue = run.catch(() => {});
    return run;
  }
  const putFile = (path, b64, message, sha) => write(async () =>
    (await api(`contents/${enc(path)}`, { method: 'PUT', body: { message, content: b64, branch: cfg.branch, sha } })).json());
  const putJson = (path, data, message, sha) => putFile(path, b64FromText(JSON.stringify(data, null, 2) + '\n'), message, sha);
  const delFile = (path, sha, message) => write(() => api(`contents/${enc(path)}`, { method: 'DELETE', body: { message, sha, branch: cfg.branch } }));

  // ── 상태 ───────────────────────────────────────────
  const SUBJECTS = ['수학', '국어', '영어'];
  let subject = SUBJECTS.includes(store.get('subject')) ? store.get('subject') : '수학';
  let wrongs = [], exams = [], results = {};
  let loaded = false;
  let openOmr = null;
  let uploading = 0;
  const thumbs = new Map();   // 사진 sha → blob URL

  const setStatus = (msg, isErr) => {
    const el = $('status');
    el.hidden = !msg; el.textContent = msg || ''; el.classList.toggle('err', !!isErr);
  };
  function fail(e, what) {
    if (e && e.status === 401) { store.del('gh-token'); token = null; showSetup('토큰이 만료됐습니다. 새 토큰을 넣어 주세요.'); return; }
    if (e && e.status === 403) { setStatus(`${what} 토큰의 Contents 권한(Read and write)을 확인하세요.`, true); return; }
    setStatus(`${what} 인터넷을 확인하세요.`, true);
  }

  // ── 화면 전환 ───────────────────────────────────────
  function route() {
    if (!token) return;
    const view = location.hash === '#exams' ? 'exams' : location.hash === '#stats' ? 'stats' : 'wrong';
    $('view-wrong').hidden = view !== 'wrong';
    $('view-exams').hidden = view !== 'exams';
    $('view-stats').hidden = view !== 'stats';
    for (const v of ['wrong', 'exams', 'stats']) {
      if (v === view) $('tab-' + v).setAttribute('aria-current', 'page');
      else $('tab-' + v).removeAttribute('aria-current');
    }
  }
  addEventListener('hashchange', route);

  function showSetup(msg) {
    for (const id of ['tabs', 'view-wrong', 'view-exams', 'view-stats', 'foot']) $(id).hidden = true;
    $('setup').hidden = false;
    $('setup-repo').textContent = `${cfg.owner}/${cfg.repo}`;
    setStatus(msg || '', !!msg);
  }
  function showApp() {
    $('setup').hidden = true; $('tabs').hidden = false; $('foot').hidden = false;
    route();
  }

  // ── 오답 화면 ───────────────────────────────────────
  function thumb(w) {
    const box = h('div', { class: 'shot' });
    const show = (url) => box.replaceChildren(h('img', { src: url, alt: '틀린 문제 사진' }));
    if (thumbs.has(w.sha)) show(thumbs.get(w.sha));
    else {
      box.append(h('div', { class: 'ph', text: '…' }));
      readBlob(w.path).then((b) => { const url = URL.createObjectURL(b); thumbs.set(w.sha, url); show(url); })
        .catch(() => box.replaceChildren(h('div', { class: 'ph', text: '불러오기 실패' })));
    }
    return box;
  }

  function wrongCard(w) {
    const m = w.meta;
    const chip = m.status === 'recorded' ? h('span', { class: 'chip done', text: '분석 완료' })
      : m.status === 'unclear' ? h('span', { class: 'chip redo', text: '재촬영' })
      : h('span', { class: 'chip new', text: '접수' });
    const saved = h('span', { class: 'saved', text: '' });
    const memo = h('input', {
      type: 'text', id: 'memo-' + w.name, value: m.memo || '', maxlength: '200',
      placeholder: '메모', 'aria-label': '틀린 이유나 정답 메모',
      onchange: async (e) => {
        saved.textContent = '저장 중…';
        try {
          m.memo = e.target.value.trim();
          const r = await putJson(w.metaPath, m, '오답 메모 수정', w.metaSha);
          w.metaSha = r.content.sha; saved.textContent = '저장됨';
        } catch (err) { saved.textContent = ''; fail(err, '메모 저장 실패.'); }
      },
    });
    let armed = false;
    const del = h('button', {
      class: 'linkbtn', type: 'button', text: '삭제',
      onclick: async () => {
        if (!armed) { armed = true; del.textContent = '삭제 확인'; del.classList.add('sure'); setTimeout(() => { armed = false; del.textContent = '삭제'; del.classList.remove('sure'); }, 4000); return; }
        del.disabled = true;
        try {
          await delFile(w.path, w.sha, '오답 사진 삭제');
          if (w.metaSha) await delFile(w.metaPath, w.metaSha, '오답 메모 삭제');
          wrongs = wrongs.filter((x) => x !== w); renderWrongs();
        } catch (err) { del.disabled = false; fail(err, '삭제 실패.'); }
      },
    });
    const when = m.createdAt ? new Date(m.createdAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' }) : '';
    return h('article', { class: 'card' },
      thumb(w),
      h('div', { class: 'body' },
        h('div', { class: 'meta' }, h('span', { text: m.pages > 1 ? `${when} · ${m.page}/${m.pages}` : when }), chip),
        m.type ? h('p', { class: 'type', text: m.type }) : null,
        m.note ? h('p', { class: 'note', text: m.note }) : null,
        memo,
        h('div', { class: 'acts' }, saved, m.status === 'recorded' ? null : del)));
  }

  function renderHeader() {
    const week = targetSunday();
    const days = Math.round((new Date(week + 'T00:00:00Z') - kstToday()) / 864e5);
    $('dday-label').textContent = `${fmtDate(week)} 실모`;
    $('dday').textContent = days === 0 ? 'D-DAY' : `D-${days}`;
    $('week-title').textContent = subject === '수학' ? '이번 주 오답' : '이번 주 지문';
    for (const b of document.querySelectorAll('#subjects button')) b.setAttribute('aria-pressed', String(b.dataset.s === subject));
  }

  function renderWrongs() {
    renderHeader();
    const mine = wrongs.filter((w) => (w.meta.subject || '수학') === subject);
    $('week-count').textContent = uploading ? `올리는 중 ${uploading}` : mine.length ? `${mine.length}` : '';
    const active = document.activeElement;
    if (!(active && active.id && active.id.startsWith('memo-'))) $('wrong-list').replaceChildren(...mine.map(wrongCard));
    $('wrong-empty').hidden = !loaded || mine.length > 0 || uploading > 0;
    $('wrong-empty').textContent = subject === '수학' ? '틀린 문제 사진을 추가하세요' : '지문 사진을 추가하세요 · 한 지문이 여러 장이면 한 번에 선택';
  }

  async function loadWrongs() {
    const week = targetSunday();
    const files = await listDir(`inbox/${week}`);
    const images = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name));
    const metas = new Map(files.filter((f) => f.name.endsWith('.json')).map((f) => [f.name.replace(/\.json$/, ''), f]));
    const list = await Promise.all(images.map(async (f) => {
      const base = f.name.replace(/\.[^.]+$/, '');
      const mf = metas.get(base);
      const metaPath = `inbox/${week}/${base}.json`;
      const got = mf ? await readJson(metaPath).catch(() => null) : null;
      return { name: base, path: f.path, sha: f.sha, metaPath, metaSha: got ? got.sha : undefined, meta: got ? got.data : {} };
    }));
    wrongs = list.sort((a, b) => (b.meta.createdAt || b.name).localeCompare(a.meta.createdAt || a.name));
  }

  // 큰 사진은 긴 변 2400px JPEG 로 줄여서 올린다.
  async function toJpeg(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
    if (!blob) throw new Error('encode');
    return blob;
  }

  $('file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    setStatus('');
    const week = targetSunday();
    let failed = 0, lastErr = null;
    uploading = files.length; renderWrongs();
    // 국어·영어는 한 번에 고른 사진들을 한 지문으로 묶는다.
    const group = subject !== '수학' && files.length > 1 ? `g${Date.now().toString(36)}` : null;
    let page = 0;
    for (const f of files) {
      page++;
      try {
        const blob = await toJpeg(f);
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
        const base = `${stamp}-${String(page).padStart(2, '0')}-${Math.random().toString(36).slice(2, 6)}`;
        const meta = { subject, memo: '', status: 'new', createdAt: new Date().toISOString() };
        if (group) Object.assign(meta, { group, page, pages: files.length });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const img = await putFile(`inbox/${week}/${base}.jpg`, b64FromBytes(bytes), '오답 사진 추가');
        const mj = await putJson(`inbox/${week}/${base}.json`, meta, '오답 메모 추가');
        thumbs.set(img.content.sha, URL.createObjectURL(blob));
        wrongs.unshift({ name: base, path: img.content.path, sha: img.content.sha, metaPath: `inbox/${week}/${base}.json`, metaSha: mj.content.sha, meta });
      } catch (err) { failed++; lastErr = err; }
      uploading--; renderWrongs();
    }
    if (failed) {
      if (lastErr && lastErr.status) fail(lastErr, `${failed}장 업로드 실패.`);
      else setStatus(`${failed}장 업로드 실패. JPG·PNG 사진인지 확인하세요.`, true);
    }
  });

  // ── 실모 화면 ───────────────────────────────────────
  const CIRC = ['①', '②', '③', '④', '⑤'];
  const draftKey = (id) => 'omr-draft-' + id;
  const timerKey = (id) => 'omr-timer-' + id;
  let tick = null;

  function grade(exam, answers) {
    let score = 0; const wrong = [];
    exam.answers.forEach((a, i) => {
      if (answers[i] != null && answers[i] !== '' && Number(answers[i]) === Number(a)) score += exam.points[i];
      else wrong.push(i + 1);
    });
    return { score, wrong };
  }

  function timerBox(exam) {
    const mins = exam.minutes;
    const out = h('output', { text: `${mins}:00` });
    const btn = h('button', { class: 'btn quiet', type: 'button' });
    const paint = () => {
      const end = store.get(timerKey(exam.id));
      if (!end) { out.textContent = `${mins}:00`; btn.textContent = `${mins}분 시작`; return; }
      const left = Math.max(0, Math.round((end - Date.now()) / 1000));
      out.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
      btn.textContent = left ? '초기화' : '종료 · 초기화';
    };
    btn.addEventListener('click', () => {
      if (store.get(timerKey(exam.id))) store.del(timerKey(exam.id));
      else store.set(timerKey(exam.id), Date.now() + mins * 60e3);
      paint();
    });
    clearInterval(tick); tick = setInterval(paint, 1000); paint();
    return h('div', { class: 'timer' }, out, btn);
  }

  function omrPanel(exam, result) {
    const done = !!result;
    const answers = done ? result.answers.slice() : (store.get(draftKey(exam.id)) || Array(exam.answers.length).fill(null));
    const rows = exam.answers.map((correct, i) => {
      const n = i + 1;
      const isShort = exam.formats[i] === '단답';
      const isEssay = exam.formats[i] === '서술';
      let field;
      if (isEssay) {
        // 서술형은 해설지의 모범 답안과 견주어 스스로 표시한다.
        const marks = [['○', 1], ['✕', 0]].map(([label, v]) => h('button', {
          class: 'bub self', type: 'button', text: label, 'aria-pressed': String(answers[i] === v), 'aria-label': `${n}번 ${v ? '맞음' : '틀림'}`, disabled: done,
          onclick: () => {
            answers[i] = answers[i] === v ? null : v;
            marks.forEach((b, j) => b.setAttribute('aria-pressed', String(answers[i] === (j === 0 ? 1 : 0))));
            store.set(draftKey(exam.id), answers);
          },
        }));
        field = h('div', { class: 'bubbles' }, h('span', { class: 'essay', text: '서술형' }), marks);
      } else if (isShort) {
        field = h('input', {
          type: 'text', inputmode: 'numeric', maxlength: '3', id: `a-${exam.id}-${n}`, value: answers[i] ?? '',
          'aria-label': `${n}번 답`, disabled: done,
          oninput: (e) => { e.target.value = e.target.value.replace(/\D/g, ''); answers[i] = e.target.value === '' ? null : Number(e.target.value); store.set(draftKey(exam.id), answers); },
        });
      } else {
        const bubs = CIRC.map((_, k) => h('button', {
          class: 'bub', type: 'button', text: String(k + 1), 'aria-pressed': String(answers[i] === k + 1), 'aria-label': `${n}번 ${k + 1}번 선택지`, disabled: done,
          onclick: () => {
            answers[i] = answers[i] === k + 1 ? null : k + 1;
            bubs.forEach((b, j) => b.setAttribute('aria-pressed', String(answers[i] === j + 1)));
            store.set(draftKey(exam.id), answers);
          },
        }));
        field = h('div', { class: 'bubbles' }, bubs);
      }
      let cls = 'q', mark = h('span', { class: 'mark', text: `${exam.points[i]}점` });
      if (done) {
        const ok = !result.wrong.includes(n);
        cls += ok ? ' ok' : ' ng';
        mark = h('span', { class: 'mark', text: ok ? '○' : isEssay ? '✕' : `정답 ${isShort ? correct : CIRC[correct - 1]}` });
      }
      return h('div', { class: cls }, h('span', { class: 'n', text: n + '.' }), field, mark);
    });

    const msg = h('p', { class: 'hint', text: '' });
    const submit = h('button', {
      class: 'btn primary', type: 'button', text: '채점',
      onclick: async () => {
        const blank = answers.filter((a) => a == null).length;
        if (blank && submit.dataset.sure !== '1') { submit.dataset.sure = '1'; submit.textContent = `미입력 ${blank}문항 · 그대로 채점`; return; }
        submit.disabled = true; submit.textContent = '채점 중…';
        const g = grade(exam, answers);
        const data = { id: exam.id, date: exam.date, subject: exam.subject, answers, score: g.score, wrong: g.wrong, submittedAt: new Date().toISOString() };
        try {
          await putJson(`app-data/results/${exam.id}.json`, data, `제${exam.round ?? ''}회 ${exam.subject} 채점 결과`);
          results[exam.id] = data;
          store.del(draftKey(exam.id)); store.del(timerKey(exam.id));
          renderExams(); renderStats();
        } catch (err) { submit.disabled = false; submit.textContent = '채점'; fail(err, '채점 저장 실패.'); }
      },
    });
    return h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      done || !exam.minutes ? null : timerBox(exam),
      h('div', { class: 'omr' }, rows),
      done ? null : h('div', {}, submit, msg));
  }

  // PDF 는 비공개 저장소에 있어 토큰으로 받아 온 뒤 기기에 저장해 연다.
  function pdfButton(label, path, filename, primary) {
    const btn = h('button', { class: 'btn' + (primary ? ' primary' : ''), type: 'button', text: label });
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '…';
      try {
        const blob = await readBlob(path);
        const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        const a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (err) { fail(err, 'PDF 받기 실패.'); }
      btn.disabled = false; btn.textContent = label;
    });
    return btn;
  }

  function examCard(exam) {
    const result = results[exam.id];
    const valid = Array.isArray(exam.answers) && exam.answers.length > 0 && Array.isArray(exam.points) && Array.isArray(exam.formats);
    const kids = [
      h('div', { class: 'rowhead' },
        h('h3', {}, `${exam.subject} 제${exam.round ?? '–'}회`, h('span', { class: 'when', text: fmtDate(exam.date) })),
        result ? h('div', { class: 'score' }, h('b', { text: String(result.score) }), h('span', { text: `/${exam.total}` })) : null),
      exam.summary ? h('p', { class: 'sub', text: exam.summary }) : null,
      h('div', { class: 'links' },
        exam.examPdf ? pdfButton('문제지', exam.examPdf, `${exam.subject}-제${exam.round ?? ''}회-문제지.pdf`, true) : null,
        exam.solPdf ? pdfButton('해설지', exam.solPdf, `${exam.subject}-제${exam.round ?? ''}회-해설지.pdf`, false) : null,
        valid ? h('button', { class: 'btn quiet', type: 'button', text: openOmr === exam.id ? '접기' : result ? '결과' : '채점',
          onclick: () => { openOmr = openOmr === exam.id ? null : exam.id; renderExams(); } }) : null),
    ];
    if (result && result.wrong.length) {
      kids.push(h('ul', { class: 'misses' }, result.wrong.map((n) =>
        h('li', {}, h('span', { class: 'no', text: `${n}번` }), h('span', { text: (exam.types && exam.types[n - 1]) || '' })))));
    }
    if (valid && openOmr === exam.id) kids.push(omrPanel(exam, result));
    return h('article', { class: 'exam' }, kids);
  }

  function renderExams() {
    clearInterval(tick);
    $('exam-list').replaceChildren(...exams.map(examCard));
    const empty = $('exam-empty');
    empty.hidden = !loaded || exams.length > 0;
    if (!empty.hidden) empty.textContent = `첫 실모 · ${fmtDate(targetSunday())}(일)`;
  }

  async function loadExams() {
    const pick = async (dir) => {
      const files = (await listDir(dir)).filter((f) => f.name.endsWith('.json'));
      return (await Promise.all(files.map((f) => readJson(f.path).catch(() => null)))).filter(Boolean).map((r) => r.data);
    };
    const [ex, rs] = await Promise.all([pick('app-data/exams'), pick('app-data/results')]);
    const norm = (e) => ({ subject: '수학', minutes: null, ...e, id: e.id || e.date, total: e.total ?? (e.points || []).reduce((a, b) => a + b, 0) });
    exams = ex.map(norm).sort((a, b) => b.date.localeCompare(a.date) || SUBJECTS.indexOf(a.subject) - SUBJECTS.indexOf(b.subject));
    results = Object.fromEntries(rs.map((r) => [r.id || r.date, r]));
  }

  // ── 통계 화면 ───────────────────────────────────────
  // 채점한 실모만 집계한다. 유형은 "단원 · 유형"의 앞부분(단원)으로 묶는다.
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  function subjectStats(subj) {
    const done = exams.filter((e) => e.subject === subj && results[e.id] && Array.isArray(e.points)).sort((a, b) => a.date.localeCompare(b.date));
    if (!done.length) return null;
    const rounds = done.map((e) => ({ label: `${e.round ?? ''}회`, date: e.date, score: results[e.id].score, total: e.total, p: pct(results[e.id].score, e.total) }));
    const groups = new Map(), exact = new Map();
    for (const e of done) {
      const wrong = new Set(results[e.id].wrong);
      (e.types || []).forEach((t, i) => {
        const key = (t || '기타').split(' · ')[0];
        const g = groups.get(key) || { key, n: 0, miss: 0 };
        g.n++; if (wrong.has(i + 1)) { g.miss++; exact.set(t, (exact.get(t) || 0) + 1); }
        groups.set(key, g);
      });
    }
    const weak = [...groups.values()].filter((g) => g.miss > 0).sort((a, b) => b.miss / b.n - a.miss / a.n || b.miss - a.miss).slice(0, 6);
    const repeat = [...exact.entries()].filter(([t]) => t.includes(' · ')).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { rounds, weak, repeat, avg: Math.round(rounds.reduce((s, r) => s + r.p, 0) / rounds.length) };
  }

  function statCard(subj, st) {
    const last = st.rounds.at(-1), prev = st.rounds.at(-2);
    const diff = prev ? last.p - prev.p : null;
    const recent = st.rounds.slice(-12);
    return h('article', { class: 'exam' },
      h('div', { class: 'rowhead' },
        h('h3', { text: subj }),
        h('div', { class: 'score' }, h('b', { text: `${last.p}` }), h('span', { text: '%' }))),
      h('p', { class: 'sub', text: `최근 ${last.score}/${last.total}점${diff == null ? '' : ` · 지난 회차 대비 ${diff > 0 ? '+' : ''}${diff}%p`} · 평균 ${st.avg}% · ${st.rounds.length}회` }),
      h('div', { class: 'trend', role: 'img', 'aria-label': `${subj} 회차별 득점률` }, recent.map((r) =>
        h('div', { class: 'tcol', title: `${r.label} ${fmtDate(r.date)} · ${r.score}/${r.total}점 (${r.p}%)`, tabindex: '0' },
          h('span', { class: 'tval', text: `${r.p}` }),
          h('div', { class: 'tbar' }, h('i', { style: `height:${Math.max(r.p, 2)}%` })),
          h('span', { class: 'tlab', text: r.label })))),
      st.weak.length ? h('div', { class: 'weak' },
        h('h4', { text: '약한 영역' }),
        st.weak.map((g) => h('div', { class: 'wrow', title: `${g.key} · ${g.n}문항 중 ${g.miss}문항 오답` },
          h('span', { class: 'wname', text: g.key }),
          h('div', { class: 'wbar' }, h('i', { style: `width:${pct(g.miss, g.n)}%` })),
          h('span', { class: 'wval', text: `${g.miss}/${g.n}` })))) : h('p', { class: 'sub', text: '틀린 문항 없음' }),
      st.repeat.length ? h('div', { class: 'weak' },
        h('h4', { text: '틀린 유형' }),
        h('ul', { class: 'misses' }, st.repeat.map(([t, c]) => h('li', {}, h('span', { class: 'no', text: `×${c}` }), h('span', { text: t.split(' · ').slice(1).join(' · ') }))))) : null);
  }

  function renderStats() {
    const cards = SUBJECTS.map((subj) => [subj, subjectStats(subj)]).filter(([, st]) => st).map(([subj, st]) => statCard(subj, st));
    $('stat-list').replaceChildren(...cards);
    $('stat-empty').hidden = !loaded || cards.length > 0;
  }

  // ── 시작 ───────────────────────────────────────────
  let busy = false;
  async function refresh() {
    if (busy || !token) return;
    busy = true;
    if (!loaded) setStatus('불러오는 중');
    try {
      await loadExams();       // 이번 회차 일요일을 정하려면 실모 목록이 먼저 필요하다.
      await loadWrongs();
      loaded = true; setStatus('');
      renderWrongs(); renderExams(); renderStats();
    } catch (e) { fail(e, '불러오기 실패.'); }
    busy = false;
  }

  $('connect').addEventListener('click', async () => {
    const value = $('token').value.trim();
    if (!value) { setStatus('토큰을 넣어 주세요.', true); return; }
    token = value; $('connect').disabled = true; setStatus('확인 중');
    try {
      await api(`contents/README.md?ref=${encodeURIComponent(cfg.branch)}`);
      store.set('gh-token', token); $('token').value = '';
      showApp(); await refresh();
    } catch (e) {
      token = null;
      setStatus(e.status === 401 ? '토큰이 올바르지 않습니다.'
        : e.status === 404 || e.status === 403 ? `이 토큰으로 ${cfg.owner}/${cfg.repo} 에 접근할 수 없습니다. 2·3번을 확인하세요.`
        : '연결 실패. 인터넷을 확인하세요.', true);
    }
    $('connect').disabled = false;
  });
  let logoutArmed = false;
  $('logout').addEventListener('click', () => {
    if (!logoutArmed) { logoutArmed = true; $('logout').textContent = '해제 확인'; setTimeout(() => { logoutArmed = false; $('logout').textContent = '연결 해제'; }, 4000); return; }
    store.del('gh-token'); token = null; loaded = false; wrongs = []; exams = []; results = {};
    $('logout').textContent = '연결 해제'; logoutArmed = false; showSetup();
  });
  for (const b of document.querySelectorAll('#subjects button')) b.addEventListener('click', () => { subject = b.dataset.s; store.set('subject', subject); renderWrongs(); });
  $('refresh').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && loaded) refresh(); });

  (async () => {
    try { cfg = await (await fetch('config.json', { cache: 'no-cache' })).json(); }
    catch { setStatus('앱 설정을 불러오지 못했습니다. 인터넷에 연결한 뒤 다시 열어 주세요.', true); return; }
    renderHeader();
    if (!token) showSetup(); else { showApp(); refresh(); }
  })();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
