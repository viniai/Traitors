"""Generazione assistita di un personaggio a partire da una breve descrizione."""
from __future__ import annotations

import re
from typing import Optional

from engine import parse_json
from llm import BaseLLM, LLMError, MockLLM

FALLBACK_NAMES = [
    "Ginevra", "Matteo", "Alessia", "Fabio", "Irene", "Lorenzo", "Beatrice", "Edoardo",
    "Camilla", "Nicola", "Viola", "Pietro", "Aurora", "Stefano", "Greta", "Andrea",
]

SYSTEM = """Sei un autore di personaggi per un gioco di deduzione sociale in stile "The Traitors" (un castello, concorrenti che si accusano e votano).
Dato uno spunto, crea UN concorrente. Rispondi SOLO con un JSON valido:
{"name": "...", "archetype": "...", "prompt": "..."}

Regole:
- name: un nome proprio italiano, una sola parola, non presente nell'elenco dei nomi già usati.
- archetype: etichetta brevissima con articolo (es. "il Complottista", "la Stratega"), massimo 4 parole.
- prompt: 3-4 frasi in seconda persona ("Sei...", "Quando...") che descrivono comportamenti concreti: come parla, come sceglie chi votare, come reagisce se accusato, un punto debole. Massimo 450 caratteri.
- Il personaggio deve funzionare sia se sarà Fedele sia se sarà Traditore: non citare ruoli, regole o montepremi.
- Niente riferimenti a persone reali né a personaggi di opere protette."""

SYSTEM_HISTORICAL = SYSTEM.replace(
    '{"name": "...", "archetype": "...", "prompt": "..."}',
    '{"name": "...", "archetype": "...", "historical": "...", "prompt": "..."}',
).replace(
    "- name: un nome proprio italiano, una sola parola, non presente nell'elenco dei nomi già usati.",
    "- name: il nome con cui il personaggio storico è comunemente chiamato (breve, massimo 2 parole), non presente nell'elenco dei nomi già usati.\n"
    "- historical: identità completa con titolo e date (es. \"Napoleone Bonaparte, imperatore dei Francesi (1769-1821)\").",
).replace(
    "- Niente riferimenti a persone reali né a personaggi di opere protette.",
    "- Lo spunto indica un personaggio storico realmente esistito: usa carattere e mentalità fedeli alla storia.",
)


def _pick_name(taken: list[str], preferred: Optional[str] = None) -> str:
    used = {t.casefold() for t in taken}
    if preferred:
        word = preferred.strip().split()[0] if preferred.strip() else ""
        if word and word.casefold() not in used:
            return word
    for n in FALLBACK_NAMES:
        if n.casefold() not in used:
            return n
    return f"Concorrente{len(taken) + 1}"


def draft_character(brief: str, name_hint: Optional[str], taken: list[str]) -> dict:
    """Bozza senza AI, usata quando non c'è una chiave API: va rivista a mano."""
    text = brief.strip().rstrip(".")
    m = re.match(r"^(una|uno|un|il|la|lo|l')\s*", text, flags=re.I)
    feminine = bool(m) and m.group(1).lower() in ("una", "la")
    words = (text[m.end():] if m else text).split()
    short: list[str] = []
    for w in words:
        if w.lower() in ("che", "ma", "e", "con", "dal", "del") or w.endswith(","):
            break
        short.append(w.rstrip(","))
        if len(short) == 3:
            break
    noun = " ".join(short) if short else "personaggio"
    if noun[0].lower() in "aeiou":
        article = "l'"
    elif feminine:
        article = "la "
    elif re.match(r"(s[^aeiou\W]|z|gn|ps|x|y)", noun.lower()):
        article = "lo "
    else:
        article = "il "
    archetype = article + noun
    prompt = (
        f"{text[:1].upper()}{text[1:]}. Questo carattere guida ogni tua battuta, il modo in cui scegli chi votare "
        "e come reagisci quando vieni accusato. Resta coerente con lui in ogni momento."
    )
    return {"name": _pick_name(taken, name_hint), "archetype": archetype[:60], "prompt": prompt[:800]}


async def generate_character(
    llm: Optional[BaseLLM], brief: str, name_hint: Optional[str], taken: list[str], historical: bool = False
) -> dict:
    if llm is None or isinstance(llm, MockLLM):
        return {**draft_character(brief, name_hint, taken), "mock": True}

    user = f"Spunto: {brief}\nNomi già usati: {', '.join(taken) or '(nessuno)'}\n"
    if name_hint:
        user += f"Il nome del personaggio deve essere: {name_hint}\n"
    raw = await llm.complete(SYSTEM_HISTORICAL if historical else SYSTEM, user, kind="character", max_tokens=500)
    data = parse_json(raw)
    prompt = str(data.get("prompt") or "").strip()
    if not prompt:
        raise LLMError("risposta non valida dal modello, riprova")
    name = name_hint or (str(data.get("name") or "").strip()[:20] if historical and data.get("name") else _pick_name(taken, str(data.get("name") or "")))
    return {
        "name": name,
        "archetype": str(data.get("archetype") or "").strip()[:60],
        "prompt": prompt[:800],
        "historical": str(data.get("historical") or "").strip()[:160] if historical else "",
        "mock": False,
    }
