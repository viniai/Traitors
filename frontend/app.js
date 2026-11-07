(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const hue = (name) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const fmt = (n) => new Intl.NumberFormat('it-IT').format(n) + ' €';
  const roleName = (r) => (r === 'traitor' ? 'Traditore' : 'Fedele');

  const S = {
    players: new Map(),
    god: false,
    focus: null,
    es: null,
    timer: null,
    queue: [],
    health: { llm: false, model: '' },
    cast: [],
    defaults: [],
  };

  const feed = $('#feed');
  const playersEl = $('#players');

  try { S.god = localStorage.getItem('god') === '1'; } catch (_) { /* storage non disponibile */ }

  // ---------------------------------------------------------------- UI helpers
  function setGod(on) {
    S.god = on;
    document.body.classList.toggle('god', on);
    $('#btn-god').setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('god', on ? '1' : '0'); } catch (_) { /* ignore */ }
    stickToBottom();
  }

  function avatar(name, small) {
    const a = el('span', 'av' + (small ? ' sm' : ''), name.slice(0, 1).toUpperCase());
    a.style.setProperty('--h', hue(name));
    return a;
  }

  function renderPlayers() {
    playersEl.replaceChildren();
    for (const p of S.players.values()) {
      const b = el('button', 'pl' + (p.alive ? '' : ' dead') + (S.focus === p.name ? ' focus' : ''));
      b.type = 'button';
      b.title = `${p.name}, ${p.archetype}`;
      const a = avatar(p.name);
      a.dataset.role = p.role;
      a.dataset.revealed = String(p.revealed);
      b.append(a, el('span', 'nm', p.name));
      b.addEventListener('click', () => {
        S.focus = S.focus === p.name ? null : p.name;
        renderPlayers();
        applyFocus();
      });
      playersEl.append(b);
    }
  }

  function applyFocus() {
    for (const n of feed.children) {
      if (!n.dataset) continue;
      const keep = !S.focus || n.classList.contains('divider') || n.dataset.actor === S.focus || n.dataset.target === S.focus;
      n.style.display = keep ? '' : 'none';
    }
  }

  function nearBottom() {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160;
  }
  function stickToBottom() { feed.scrollTop = feed.scrollHeight; }

  function add(node, ev = {}) {
    const follow = nearBottom();
    if (ev.actor) node.dataset.actor = ev.actor;
    if (ev.target) node.dataset.target = ev.target;
    if (ev.secret) node.classList.add('secret');
    $('#empty')?.remove();
    feed.append(node);
    if (S.focus && node.dataset.actor !== S.focus && node.dataset.target !== S.focus && !node.classList.contains('divider')) {
      node.style.display = 'none';
    }
    if (follow) stickToBottom();
  }

  function setHeader(ev) {
    if (ev.text && ev.type === 'phase') $('#phase').textContent = ev.text;
  }

  function reset() {
    feed.replaceChildren();
    S.players.clear();
    S.focus = null;
    renderPlayers();
    $('#pot').textContent = fmt(0);
    $('#phase').textContent = 'In attesa';
    const e = el('div', 'empty'); e.id = 'empty';
    e.append(el('p', 'empty-title', 'Il castello si sta riempiendo…'));
    feed.append(e);
  }

  // ----------------------------------------------------------------- eventi
  function thoughtNode(ev) {
    return ev.thought ? el('div', 'thought', '💭 ' + ev.thought) : null;
  }

  function bubble(ev, secret) {
    const p = S.players.get(ev.actor);
    const wrap = el('div', 'msg');
    wrap.style.setProperty('--h', hue(ev.actor));
    const b = el('div', 'bubble');
    const who = el('div', 'who', ev.actor);
    if (p) who.append(el('small', '', p.archetype));
    if (secret) who.append(el('span', 'secret-tag', 'chat dei traditori'));
    b.append(who, el('div', 'txt', ev.text));
    const t = thoughtNode(ev);
    if (t) b.append(t);
    wrap.append(avatar(ev.actor, true), b);
    return wrap;
  }

  function markDead(name, role) {
    const p = S.players.get(name);
    if (!p) return;
    p.alive = false;
    p.revealed = true;
    p.role = role || p.role;
    renderPlayers();
  }

  function handle(ev) {
    setHeader(ev);
    switch (ev.type) {
      case 'setup':
        S.players.clear();
        for (const p of ev.players) S.players.set(p.name, { ...p, alive: true, revealed: false });
        renderPlayers();
        break;

      case 'pot':
        $('#pot').textContent = fmt(ev.pot);
        break;

      case 'phase': {
        const d = el('div', 'divider', ev.text);
        add(d, {});
        break;
      }

      case 'gm':
        add(el('div', 'note', ev.text), ev);
        break;

      case 'speech':
        add(bubble(ev, false), ev);
        break;

      case 'traitor_chat': {
        const node = bubble(ev, true);
        if (ev.target) node.querySelector('.txt').append(el('span', 'muted', `  → ${ev.target}`));
        add(node, ev);
        break;
      }

      case 'vote': {
        const v = el('div', 'vote' + (ev.runoff ? ' runoff' : ''));
        v.append(el('strong', '', ev.actor), el('span', 'arrow', '➜'), el('span', '', ev.target));
        const t = thoughtNode(ev);
        if (t) v.append(t);
        add(v, ev);
        break;
      }

      case 'tally':
        add(el('div', 'note', ev.text), {});
        break;

      case 'eliminated':
      case 'murder': {
        const kill = ev.type === 'murder';
        const c = el('div', 'card ' + (kill ? 'kill' : 'out'));
        c.append(avatar(ev.actor, false));
        c.append(el('div', 'big', kill ? `${ev.actor} è stato assassinato` : `${ev.actor} è stato eliminato`));
        c.append(el('div', 'muted', ev.archetype || ''));
        c.append(el('span', 'role ' + ev.role, 'Era ' + (ev.role === 'traitor' ? 'un Traditore' : 'un Fedele')));
        add(c, ev);
        markDead(ev.actor, ev.role);
        break;
      }

      case 'recruit': {
        const n = el('div', 'note', `🗡 ${ev.text}`);
        add(n, { ...ev, secret: true });
        if (ev.accepted) {
          const p = S.players.get(ev.target);
          if (p) { p.role = 'traitor'; renderPlayers(); }
        }
        break;
      }

      case 'end': {
        const c = el('div', 'card end');
        c.append(el('div', 'big', ev.winner === 'faithful' ? 'Vincono i Fedeli' : 'Vincono i Traditori'));
        c.append(el('div', 'muted', ev.text));
        const chips = el('div', 'roles');
        for (const r of ev.roles) chips.append(el('span', `chip ${r.role}${r.alive ? '' : ' dead'}`, `${r.name} · ${roleName(r.role)}`));
        c.append(chips);
        add(c, {});
        for (const p of S.players.values()) { p.revealed = true; const r = ev.roles.find((x) => x.name === p.name); if (r) p.role = r.role; }
        renderPlayers();
        $('#phase').textContent = 'Partita finita';
        break;
      }

      case 'warn':
        add(el('div', 'warn', ev.text), { secret: true });
        break;

      case 'error':
        add(el('div', 'warn', ev.text), {});
        break;

      default:
        break;
    }
  }

  // --------------------------------------------------------- streaming / replay
  function stop() {
    if (S.es) { S.es.close(); S.es = null; }
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    S.queue = [];
    $('#btn-skip').hidden = true;
  }

  function connect(id) {
    stop();
    reset();
    const es = new EventSource(`/api/games/${id}/events`);
    S.es = es;
    es.onmessage = (m) => handle(JSON.parse(m.data));
    es.addEventListener('done', () => { es.close(); S.es = null; });
  }

  function pace(ev) {
    if (ev.type === 'speech' || ev.type === 'traitor_chat') return 1100;
    if (ev.type === 'eliminated' || ev.type === 'murder' || ev.type === 'end') return 1500;
    if (ev.type === 'setup' || ev.type === 'pot') return 0;
    return 450;
  }

  function tick() {
    const ev = S.queue.shift();
    if (!ev) { $('#btn-skip').hidden = true; S.timer = null; return; }
    handle(ev);
    S.timer = setTimeout(tick, pace(ev));
  }

  async function replay(id) {
    stop();
    reset();
    try {
      const r = await fetch(`/api/games/${id}/transcript`);
      if (!r.ok) throw new Error('Partita non trovata');
      const data = await r.json();
      S.queue = data.events.slice();
      $('#btn-skip').hidden = false;
      tick();
    } catch (e) {
      add(el('div', 'warn', e.message), {});
    }
  }

  // ------------------------------------------------------------------ API
  async function api(path, opts) {
    const r = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!r.ok) {
      let msg = await r.text();
      try { msg = JSON.parse(msg).detail || msg; } catch (_) { /* testo semplice */ }
      throw new Error(msg);
    }
    return r.json();
  }

  async function loadHistory() {
    const ul = $('#history');
    try {
      const items = await api('/games');
      if (!items.length) return;
      ul.replaceChildren();
      for (const g of items) {
        const li = el('li');
        const when = new Date(g.created * 1000).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
        const res = !g.finished ? 'in corso' : g.result === 'faithful' ? 'Fedeli' : g.result === 'traitors' ? 'Traditori' : '—';
        const label = el('span', '', `${when} · ${g.meta?.mock ? 'demo' : g.meta?.model || 'LLM'} · ${res}`);
        const btn = el('button', 'btn', g.finished ? 'Rivedi' : 'Segui');
        btn.type = 'button';
        btn.addEventListener('click', () => { closeSheet(); g.finished ? replay(g.id) : connect(g.id); });
        li.append(label, btn);
        ul.append(li);
      }
    } catch (_) { /* elenco opzionale */ }
  }

  function updateMode() {
    const mode = $('#opt-mode').value;
    $('#model-field').style.display = mode === 'llm' ? '' : 'none';
    $('#mode-hint').textContent = mode === 'llm' && !S.health.llm
      ? 'ANTHROPIC_API_KEY non è impostata sul server: la partita non partirà.'
      : '';
    $('#opt-model').placeholder = S.health.model || 'claude-haiku-5-5';
    const note = $('#cast-note');
    note.hidden = mode !== 'mock';
    note.textContent = 'In modalità demo le risposte sono casuali: le personalità influenzano la partita solo con Claude.';
  }

  function openSheet() { $('#sheet').hidden = false; loadHistory(); }
  function closeSheet() { $('#sheet').hidden = true; }

  async function startGame() {
    const btn = $('#btn-start');
    btn.disabled = true;
    try {
      const problem = validateCast();
      if (problem) { $('#start-hint').textContent = problem; return; }
      $('#start-hint').textContent = '';
      const body = {
        mock: $('#opt-mode').value === 'mock',
        traitors: Number($('#opt-traitors').value),
        rounds: Number($('#opt-rounds').value),
        characters: S.cast.map((c) => ({ name: c.name.trim(), archetype: c.archetype.trim(), prompt: c.prompt.trim() })),
      };
      const model = $('#opt-model').value.trim();
      if (!body.mock && model) body.model = model;
      const g = await api('/games', { method: 'POST', body: JSON.stringify(body) });
      closeSheet();
      connect(g.id);
    } catch (e) {
      $('#start-hint').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------- personaggi
  const CAST_KEY = 'cast.v1';
  const MIN_CAST = 6;
  const MAX_CAST = 14;
  const BAD_NAME = /[,;:"{}\n\r\t]/;

  function loadCast() {
    try {
      const raw = JSON.parse(localStorage.getItem(CAST_KEY) || 'null');
      if (Array.isArray(raw) && raw.length >= MIN_CAST) {
        return raw.map((c) => ({ name: String(c.name || ''), archetype: String(c.archetype || ''), prompt: String(c.prompt || '') }));
      }
    } catch (_) { /* nessun cast salvato */ }
    return S.defaults.map((c) => ({ ...c }));
  }

  function saveCast() {
    try {
      localStorage.setItem(CAST_KEY, JSON.stringify(S.cast.map(({ name, archetype, prompt }) => ({ name, archetype, prompt }))));
    } catch (_) { /* ignore */ }
  }

  function validateCast() {
    if (S.cast.length < MIN_CAST) return `Servono almeno ${MIN_CAST} personaggi.`;
    const seen = new Set();
    for (const [i, c] of S.cast.entries()) {
      const name = c.name.trim();
      if (!name) return `Il personaggio ${i + 1} non ha un nome.`;
      if (BAD_NAME.test(name)) return `Il nome «${name}» contiene caratteri non ammessi.`;
      if (seen.has(name.toLowerCase())) return `Il nome «${name}» è usato due volte.`;
      seen.add(name.toLowerCase());
      if (!c.prompt.trim()) return `${name} non ha una personalità.`;
    }
    return null;
  }

  // I Traditori devono restare meno dei Fedeli: il massimo dipende dal numero di giocatori.
  function refreshTraitors() {
    const sel = $('#opt-traitors');
    const max = Math.max(1, Math.min(4, Math.floor((S.cast.length - 1) / 2)));
    const cur = Number(sel.value) || 3;
    sel.replaceChildren();
    for (let i = 1; i <= max; i++) {
      const o = el('option', '', String(i));
      o.value = String(i);
      sel.append(o);
    }
    sel.value = String(Math.min(cur, max));
  }

  function updateCastLabel() {
    $('#cast-label').textContent = `${S.cast.length} giocatori`;
    $('#cast-count').textContent = `${S.cast.length} / ${MAX_CAST}`;
  }

  function castField(label, control) {
    const l = el('label', 'field');
    l.append(el('span', '', label), control);
    return l;
  }

  function textInput(value, max, placeholder) {
    const i = el('input');
    i.type = 'text';
    i.maxLength = max;
    i.value = value;
    i.autocomplete = 'off';
    if (placeholder) i.placeholder = placeholder;
    return i;
  }

  function castCard(c, i) {
    const d = el('details', 'char');
    d.open = !!c._open;
    d.addEventListener('toggle', () => { c._open = d.open; });

    const sum = el('summary');
    const av = el('span', 'av sm');
    const meta = el('span', 'meta');
    const nm = el('span', 'nm');
    const ar = el('span', 'ar');
    meta.append(nm, ar);
    const rm = el('button', 'rm', '×');
    rm.type = 'button';
    rm.title = 'Rimuovi personaggio';
    rm.disabled = S.cast.length <= MIN_CAST;
    rm.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      S.cast.splice(i, 1);
      saveCast();
      renderCast();
      refreshTraitors();
      updateCastLabel();
    });
    sum.append(av, meta, rm);

    const paint = () => {
      const name = c.name.trim();
      av.textContent = (name[0] || '?').toUpperCase();
      av.style.setProperty('--h', hue(name || String(i)));
      nm.textContent = name || 'Nuovo personaggio';
      ar.textContent = c.archetype.trim() || 'senza archetipo';
    };

    const nameIn = textInput(c.name, 20);
    const archIn = textInput(c.archetype, 60, 'es. il Complottista');
    const promptIn = el('textarea');
    promptIn.maxLength = 800;
    promptIn.value = c.prompt;
    promptIn.placeholder = 'Come parla, come sceglie chi votare, come reagisce alle accuse…';
    const count = el('div', 'count');
    const updCount = () => { count.textContent = `${promptIn.value.length} / 800`; };

    nameIn.addEventListener('input', () => { c.name = nameIn.value; paint(); saveCast(); });
    archIn.addEventListener('input', () => { c.archetype = archIn.value; paint(); saveCast(); });
    promptIn.addEventListener('input', () => { c.prompt = promptIn.value; updCount(); saveCast(); });

    // Assistente: dalla descrizione breve scrive archetipo e personalità (e il nome, se vuoto).
    const ai = el('div', 'ai');
    ai.append(el('div', 'ai-title', 'Assistente'));
    const row = el('div', 'row');
    const brief = textInput('', 300, 'Descrivi il personaggio in poche parole…');
    const go = el('button', 'btn', '✨ Scrivi con AI');
    go.type = 'button';
    row.append(brief, go);
    const status = el('div', 'ai-status muted');
    ai.append(row, status);

    brief.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
    go.addEventListener('click', async () => {
      const text = brief.value.trim();
      status.className = 'ai-status muted';
      if (text.length < 3) { status.textContent = 'Scrivi almeno qualche parola.'; return; }
      go.disabled = true;
      status.textContent = 'Sto scrivendo la personalità…';
      try {
        const taken = S.cast.filter((_, j) => j !== i).map((x) => x.name.trim()).filter(Boolean);
        const r = await api('/characters/generate', {
          method: 'POST',
          body: JSON.stringify({ brief: text, name: c.name.trim() || null, taken }),
        });
        c.name = c.name.trim() || r.name;
        c.archetype = r.archetype;
        c.prompt = r.prompt;
        nameIn.value = c.name;
        archIn.value = c.archetype;
        promptIn.value = c.prompt;
        paint();
        updCount();
        saveCast();
        status.textContent = r.mock
          ? 'Bozza senza AI (chiave API non configurata): rivedila a mano.'
          : 'Fatto. Puoi ritoccare il testo come vuoi.';
      } catch (e) {
        status.className = 'ai-status err';
        status.textContent = e.message;
      } finally {
        go.disabled = false;
      }
    });

    const body = el('div', 'char-body');
    body.append(castField('Nome', nameIn), castField('Archetipo', archIn), castField('Personalità', promptIn), count, ai);
    d.append(sum, body);
    paint();
    updCount();
    return d;
  }

  function renderCast() {
    $('#cast-list').replaceChildren(...S.cast.map((c, i) => castCard(c, i)));
    $('#cast-add').disabled = S.cast.length >= MAX_CAST;
  }

  function openCast() { renderCast(); updateCastLabel(); $('#cast-sheet').hidden = false; }
  function closeCast() { $('#cast-sheet').hidden = true; refreshTraitors(); updateCastLabel(); }

  function addCharacter() {
    if (S.cast.length >= MAX_CAST) return;
    S.cast.push({ name: '', archetype: '', prompt: '', _open: true });
    renderCast();
    refreshTraitors();
    updateCastLabel();
    const last = $('#cast-list').lastElementChild;
    last?.scrollIntoView({ block: 'nearest' });
    last?.querySelector('input')?.focus();
  }

  function resetCast() {
    if (!confirm('Ripristinare i personaggi predefiniti? Le tue modifiche andranno perse.')) return;
    S.cast = S.defaults.map((c) => ({ ...c }));
    saveCast();
    renderCast();
    refreshTraitors();
    updateCastLabel();
  }

  // ------------------------------------------------------------------ init
  async function init() {
    document.body.classList.toggle('god', S.god);
    $('#btn-god').setAttribute('aria-pressed', String(S.god));
    $('#btn-god').addEventListener('click', () => setGod(!S.god));
    $('#btn-new').addEventListener('click', openSheet);
    $('#btn-close').addEventListener('click', closeSheet);
    $('#btn-start').addEventListener('click', startGame);
    $('#opt-mode').addEventListener('change', updateMode);
    $('#btn-cast').addEventListener('click', openCast);
    $('#cast-done').addEventListener('click', closeCast);
    $('#cast-add').addEventListener('click', addCharacter);
    $('#cast-reset').addEventListener('click', resetCast);
    $('#btn-skip').addEventListener('click', () => {
      while (S.queue.length) handle(S.queue.shift());
      if (S.timer) { clearTimeout(S.timer); S.timer = null; }
      $('#btn-skip').hidden = true;
      stickToBottom();
    });

    try {
      S.health = await api('/health');
    } catch (_) { /* server non raggiungibile */ }
    try { S.defaults = await api('/characters'); } catch (_) { S.defaults = []; }
    S.cast = loadCast();
    refreshTraitors();
    updateCastLabel();
    $('#opt-mode').value = S.health.llm ? 'llm' : 'mock';
    updateMode();
    renderPlayers();
    openSheet();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  init();
})();
