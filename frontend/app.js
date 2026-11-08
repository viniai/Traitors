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
    set: 'default',
    defaultsBy: { default: [], historical: [] },
    mine: new Set(),
    gameId: null,
    live: false,
    turns: new Map(),
    selected: null,
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
      const badges = (p.human ? '👤' : '') + (p.immune ? '🛡' : '') + (p.shield && (S.god || S.mine.has(p.name)) ? '🔰' : '');
      if (badges) b.append(el('span', 'tag', badges));
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
    if (ev.secret) {
      node.classList.add('secret');
      if (ev.to && ev.to.some((n) => S.mine.has(n))) node.classList.add('mine');
    }
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
    S.mine = new Set();
    S.turns.clear();
    renderTurn();
    document.body.classList.remove('traitor-view');
    renderPlayers();
    $('#pot').textContent = fmt(0);
    $('#bounty').textContent = '🗡 ' + fmt(0);
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
    for (const q of S.players.values()) q.immune = false;
    updateTraitorView();
    renderPlayers();
  }

  function handle(ev) {
    setHeader(ev);
    switch (ev.type) {
      case 'setup':
        S.players.clear();
        S.mine = new Set(ev.players.filter((p) => p.human).map((p) => p.name));
        for (const p of ev.players) {
          S.players.set(p.name, { ...p, alive: true, revealed: S.mine.has(p.name), immune: false, shield: false });
        }
        updateTraitorView();
        renderPlayers();
        break;

      case 'pot':
        $('#pot').textContent = fmt(ev.pot);
        if (ev.bounty != null) $('#bounty').textContent = '🗡 ' + fmt(ev.bounty);
        break;

      case 'sabotage': {
        const n = el('div', 'note sabotage', `${ev.sabotage ? '🗡' : '🤝'} ${ev.text}`);
        const t = thoughtNode(ev);
        if (t) n.append(t);
        add(n, ev);
        break;
      }

      case 'human_turn':
        if (S.live) { S.turns.set(ev.turn, ev); renderTurn(); }
        break;

      case 'human_done':
        S.turns.delete(ev.turn);
        renderTurn();
        break;

      case 'phase': {
        const d = el('div', 'divider', ev.text);
        add(d, {});
        break;
      }

      case 'gm': {
        add(el('div', 'note', ev.text), ev);
        const h = ev.holder && S.players.get(ev.holder);
        if (h && ev.perk === 'immunity') h.immune = true;
        if (h && ev.perk === 'shield') h.shield = true;
        const used = ev.shield_used && S.players.get(ev.shield_used);
        if (used) used.shield = false;
        if (h || used) renderPlayers();
        break;
      }

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
          if (p) { p.role = 'traitor'; updateTraitorView(); renderPlayers(); }
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

  function updateTraitorView() {
    const on = [...S.mine].some((n) => S.players.get(n)?.role === 'traitor');
    document.body.classList.toggle('traitor-view', on);
  }

  // ------------------------------------------------------- turni del giocatore umano
  async function sendTurn(ev, payload) {
    try {
      await api(`/games/${S.gameId}/turn`, { method: 'POST', body: JSON.stringify({ turn: ev.turn, ...payload }) });
    } catch (e) {
      alert(e.message);
    }
    S.turns.delete(ev.turn);
    renderTurn();
  }

  function renderTurn() {
    const box = $('#turn');
    const ev = S.turns.values().next().value;
    if (!ev) { box.hidden = true; box.replaceChildren(); S.selected = null; return; }
    box.hidden = false;
    box.replaceChildren();
    const info = ev.info || {};
    const who = ev.actor;
    const btn = (label, fn, cls = '') => {
      const b = el('button', 'btn ' + cls, label);
      b.type = 'button';
      b.addEventListener('click', fn);
      return b;
    };
    const area = (ph) => { const t = el('textarea'); t.maxLength = 500; t.placeholder = ph; return t; };
    const opts = (names, onPick) => {
      const row = el('div', 'opts');
      for (const n of names) {
        const b = btn(n, () => {
          S.selected = n;
          for (const x of row.children) x.classList.toggle('sel', x.textContent === n);
          if (onPick) onPick(n);
        });
        if (S.selected === n) b.classList.add('sel');
        row.append(b);
      }
      return row;
    };
    S.selected = null;

    switch (ev.kind) {
      case 'speak': {
        box.append(el('h3', '', `Tocca a ${who}: parla`));
        box.append(el('p', 'sub', 'Accusa, difenditi o proponi chi votare.'));
        const t = area('Cosa dici agli altri?');
        box.append(t, btn('Parla', () => sendTurn(ev, { say: t.value.trim() || '...' }), 'primary'));
        break;
      }
      case 'vote': {
        box.append(el('h3', '', `Tocca a ${who}: vota`));
        box.append(el('p', 'sub', 'Chi vuoi eliminare?'));
        box.append(opts(ev.options, (n) => sendTurn(ev, { vote: n })));
        break;
      }
      case 'murder': {
        box.append(el('h3', '', `Tocca a ${who}: scegli la vittima`));
        if (info.proposals) box.append(el('p', 'sub', 'Proposte finora: ' + info.proposals.replace(/\n/g, ' ')));
        box.append(opts(ev.options));
        const t = area('Messaggio ai complici');
        let rec = null;
        if (info.can_recruit) {
          const row = el('label', 'chk-row');
          rec = el('input'); rec.type = 'checkbox';
          row.append(rec, el('span', '', 'Recluta invece di uccidere'));
          box.append(row);
        }
        box.append(t, btn('Conferma', () => {
          if (!S.selected) { alert('Scegli un bersaglio.'); return; }
          sendTurn(ev, { target: S.selected, say: t.value.trim() || `Propongo ${S.selected}.`, action: rec?.checked ? 'recruit' : 'murder' });
        }, 'primary'));
        break;
      }
      case 'recruit':
        box.append(el('h3', '', `${who}: ti offrono di unirti ai Traditori`));
        box.append(el('p', 'sub', 'Se rifiuti verrai assassinato.'));
        box.append(el('div', 'opts'));
        box.lastChild.append(btn('Accetta', () => sendTurn(ev, { accept: true }), 'primary'), btn('Rifiuta', () => sendTurn(ev, { accept: false })));
        break;
      case 'sabotage': {
        box.append(el('h3', '', `${who}: sabotare «${info.title}»?`));
        const perk = info.perk === 'shield' ? ' In palio uno scudo.' : info.perk === 'immunity' ? ' In palio l\'immunità.' : '';
        box.append(el('p', 'sub', `Posta ${fmt(info.stake)}.${perk} Bottino attuale ${fmt(info.bounty)}. Sabotare rende soldi al bottino ma insospettisce i Fedeli.`));
        const row = el('div', 'opts');
        row.append(btn('Sabota', () => sendTurn(ev, { sabotage: true }), 'primary'), btn('Non sabotare', () => sendTurn(ev, { sabotage: false })));
        box.append(row);
        break;
      }
      default:
        box.append(el('h3', '', `Tocca a ${who}`));
    }
    if (S.turns.size > 1) box.append(el('p', 'sub', `Altri turni in attesa: ${S.turns.size - 1}`));
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
    S.gameId = id;
    S.live = true;
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
    S.live = false;
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
      ? 'Nessuna chiave LLM configurata sul server: imposta ANTHROPIC_API_KEY oppure OPENROUTER_API_KEY.'
      : '';
    $('#opt-model').placeholder = S.health.model || 'Modello predefinito del provider';
    const note = $('#cast-note');
    note.hidden = mode !== 'mock';
    note.textContent = 'In modalità demo le risposte sono casuali: le personalità influenzano la partita solo con un LLM.';
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
        historical: S.set === 'historical',
        human: S.cast.filter((c) => c.human).map((c) => c.name.trim()),
        characters: S.cast.map((c) => ({
          name: c.name.trim(), archetype: c.archetype.trim(), prompt: c.prompt.trim(),
          historical: S.set === 'historical' ? (c.historical || '').trim() : '',
        })),
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
  const castKey = () => (S.set === 'historical' ? 'cast.hist.v1' : 'cast.v1');
  const MIN_CAST = 6;
  const MAX_CAST = 14;
  const BAD_NAME = /[,;:"{}\n\r\t]/;

  function loadCast() {
    try {
      const raw = JSON.parse(localStorage.getItem(castKey()) || 'null');
      if (Array.isArray(raw) && raw.length >= MIN_CAST) {
        return raw.map((c) => ({
          name: String(c.name || ''), archetype: String(c.archetype || ''), prompt: String(c.prompt || ''),
          historical: String(c.historical || ''), human: !!c.human,
        }));
      }
    } catch (_) { /* nessun cast salvato */ }
    return S.defaults.map((c) => ({ ...c, human: false }));
  }

  function saveCast() {
    try {
      localStorage.setItem(castKey(), JSON.stringify(S.cast.map(({ name, archetype, prompt, historical, human }) => ({ name, archetype, prompt, historical, human }))));
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
    if (S.cast.filter((c) => c.human).length >= S.cast.length) return 'Almeno un personaggio deve restare all\'IA.';
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
    const humans = S.cast.filter((c) => c.human).length;
    $('#cast-label').textContent = `${S.cast.length} giocatori` + (humans ? ` · ${humans} controllati da te` : '');
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
    const you = el('span', 'you', '👤 tu');
    sum.append(av, meta, you, rm);

    const paint = () => {
      you.style.display = c.human ? '' : 'none';
      const name = c.name.trim();
      av.textContent = (name[0] || '?').toUpperCase();
      av.style.setProperty('--h', hue(name || String(i)));
      nm.textContent = name || 'Nuovo personaggio';
      ar.textContent = c.archetype.trim() || 'senza archetipo';
    };

    const nameIn = textInput(c.name, 20);
    const histIn = textInput(c.historical || '', 160, 'es. Napoleone Bonaparte, imperatore dei Francesi (1769-1821)');
    histIn.addEventListener('input', () => { c.historical = histIn.value; saveCast(); });
    const humanRow = el('label', 'chk-row');
    const humanIn = el('input'); humanIn.type = 'checkbox'; humanIn.checked = !!c.human;
    humanRow.append(humanIn, el('span', '', 'Lo controllo io'));
    humanIn.addEventListener('change', () => { c.human = humanIn.checked; paint(); saveCast(); updateCastLabel(); });
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
          body: JSON.stringify({ brief: text, name: c.name.trim() || null, taken, historical: S.set === 'historical' }),
        });
        c.name = c.name.trim() || r.name;
        c.archetype = r.archetype;
        c.prompt = r.prompt;
        if (r.historical) { c.historical = r.historical; histIn.value = r.historical; }
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
    body.append(castField('Nome', nameIn));
    if (S.set === 'historical') body.append(castField('Identità storica', histIn));
    body.append(humanRow, castField('Archetipo', archIn), castField('Personalità', promptIn), count, ai);
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
    S.cast.push({ name: '', archetype: '', prompt: '', historical: '', human: false, _open: true });
    renderCast();
    refreshTraitors();
    updateCastLabel();
    const last = $('#cast-list').lastElementChild;
    last?.scrollIntoView({ block: 'nearest' });
    last?.querySelector('input')?.focus();
  }

  function resetCast() {
    if (!confirm('Ripristinare i personaggi predefiniti? Le tue modifiche andranno perse.')) return;
    S.cast = S.defaults.map((c) => ({ ...c, human: false }));
    saveCast();
    renderCast();
    refreshTraitors();
    updateCastLabel();
  }

  function switchSet(set) {
    saveCast();
    S.set = set;
    S.defaults = S.defaultsBy[set];
    S.cast = loadCast();
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
    try { S.defaultsBy.default = await api('/characters'); } catch (_) { /* ignore */ }
    try { S.defaultsBy.historical = await api('/characters?set=historical'); } catch (_) { /* ignore */ }
    S.defaults = S.defaultsBy.default;
    $('#opt-historical').addEventListener('change', (e) => switchSet(e.target.checked ? 'historical' : 'default'));
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
