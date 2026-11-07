"""Genera demo.html: la PWA completa con una partita registrata, apribile senza server.

Uso (dalla cartella del progetto, con il venv del backend attivo):
    python tools/build_demo.py
"""
import asyncio
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from engine import Game  # noqa: E402
from llm import MockLLM  # noqa: E402
from personalities import CHARACTERS  # noqa: E402


async def record(seed: int = 7) -> list[dict]:
    g = Game(MockLLM(seed), "demo", n_traitors=3, rounds=2, delay=0, seed=seed)
    await g.run()
    return g.events


def js_safe(obj) -> str:
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")


SHIM = """
const __EV = %(events)s;
const __CAST = %(cast)s;
const __json = (o) => new Response(JSON.stringify(o), {status: 200, headers: {'Content-Type': 'application/json'}});
// Stessa logica della bozza lato server quando non c'è una chiave API.
const __draft = (b) => {
  let t = (b.brief || '').trim().replace(/\\.$/, '');
  const m = t.match(/^(una|uno|un|il|la|lo|l')\\s*/i);
  const fem = !!m && ['una', 'la'].includes(m[1].toLowerCase());
  const words = (m ? t.slice(m[0].length) : t).split(/\\s+/);
  const stop = ['che', 'ma', 'e', 'con', 'dal', 'del'];
  const short = [];
  for (const w of words) { if (stop.includes(w.toLowerCase()) || w.endsWith(',')) break; short.push(w.replace(/,$/, '')); if (short.length === 3) break; }
  const noun = short.join(' ') || 'personaggio';
  const art = /^[aeiou]/i.test(noun) ? "l'" : fem ? 'la ' : /^(s[^aeiou\\W]|z|gn|ps|x|y)/i.test(noun) ? 'lo ' : 'il ';
  const free = ['Ginevra', 'Matteo', 'Alessia', 'Fabio', 'Irene', 'Lorenzo'].find((n) => !(b.taken || []).includes(n));
  return {
    name: b.name || free,
    archetype: art + noun,
    prompt: t.charAt(0).toUpperCase() + t.slice(1) + '. Questo carattere guida ogni tua battuta, il modo in cui scegli chi votare e come reagisci quando vieni accusato. Resta coerente con lui in ogni momento.',
    mock: true,
  };
};
window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.endsWith('/api/health')) return __json({llm: false, model: 'demo'});
  if (u.endsWith('/api/characters')) return __json(__CAST);
  if (u.endsWith('/api/characters/generate')) return __json(__draft(JSON.parse(opts.body)));
  if (u.endsWith('/api/games') && opts && opts.method === 'POST') return __json({id: 'demo', mock: true});
  if (u.endsWith('/api/games')) return __json([]);
  return new Response('{}', {status: 404});
};
window.EventSource = class {
  constructor() { this.l = {}; this.i = 0; this.closed = false; setTimeout(() => this.step(), 300); }
  addEventListener(n, f) { this.l[n] = f; }
  close() { this.closed = true; }
  step() {
    if (this.closed) return;
    if (this.i >= __EV.length) { this.l.done && this.l.done(); return; }
    const ev = __EV[this.i++];
    this.onmessage && this.onmessage({data: JSON.stringify(ev)});
    const t = ev.type;
    const d = (t === 'speech' || t === 'traitor_chat') ? 900 : (t === 'eliminated' || t === 'murder') ? 1500 : (t === 'setup' || t === 'pot') ? 50 : 420;
    setTimeout(() => this.step(), d);
  }
};
"""


def main() -> None:
    front = ROOT / "frontend"
    html = (front / "index.html").read_text(encoding="utf-8")
    css = (front / "style.css").read_text(encoding="utf-8")
    js = (front / "app.js").read_text(encoding="utf-8")

    html = re.sub(r'<link rel="(manifest|icon|apple-touch-icon|stylesheet)"[^>]*>\n?', "", html)
    html = html.replace('<script src="/app.js"></script>', "")
    shim = SHIM % {"events": js_safe(asyncio.run(record())), "cast": js_safe(CHARACTERS)}

    out = html.replace("</head>", f"<style>\n{css}\n</style>\n</head>").replace(
        "</body>", f"<script>\n{shim}\n{js}\n</script>\n</body>"
    )
    target = ROOT / "demo.html"
    target.write_text(out, encoding="utf-8")
    print(f"{target} ({len(out) // 1024} KB)")


if __name__ == "__main__":
    main()
