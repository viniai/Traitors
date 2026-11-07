"""Game master in codice: regole, ruoli segreti, voti e notti. Gli LLM recitano soltanto."""
from __future__ import annotations

import asyncio
import json
import random
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from llm import BaseLLM, LLMError
from personalities import BASE_RULES, CHARACTERS

MISSIONS = [
    ("Il tesoro nella nebbia", "cercare le urne nascoste nel parco del castello"),
    ("La cena avvelenata", "indovinare quale piatto è stato contaminato"),
    ("Il labirinto di siepi", "attraversare il labirinto bendati, guidati dalla voce dei compagni"),
    ("La biblioteca muta", "ricostruire un manoscritto senza poter parlare"),
    ("Il ponte di corda", "portare le casse d'oro oltre il fossato"),
    ("Le candele della cripta", "accendere le candele nell'ordine corretto"),
    ("Il banchetto dei sospetti", "abbinare ogni invitato al proprio calice"),
    ("La caccia alle chiavi", "trovare sette chiavi sparse nelle stanze"),
]


def parse_json(text: str) -> dict[str, Any]:
    m = re.search(r"\{.*\}", text or "", re.S)
    if m:
        try:
            data = json.loads(m.group(0))
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass
    return {}


def match_name(value: Any, options: list[str]) -> Optional[str]:
    if not value:
        return None
    v = str(value).strip().casefold()
    for o in options:
        if o.casefold() == v:
            return o
    for o in options:
        if o.casefold() in v:
            return o
    return None


def role_label(role: str) -> str:
    return "Traditore" if role == "traitor" else "Fedele"


@dataclass
class Player:
    id: int
    name: str
    archetype: str
    prompt: str
    role: str = "faithful"
    alive: bool = True
    out_text: str = ""
    thoughts: list[str] = field(default_factory=list)


class Game:
    def __init__(
        self,
        llm: BaseLLM,
        game_id: str,
        *,
        n_traitors: int = 3,
        rounds: int = 2,
        delay: float = 0.0,
        meta: Optional[dict] = None,
        save_dir: Optional[Path] = None,
        seed: Optional[int] = None,
        characters: Optional[list[dict]] = None,
    ):
        self.llm = llm
        self.id = game_id
        self.n_traitors = n_traitors
        self.rounds = rounds
        self.delay = delay
        self.meta = meta or {}
        self.save_dir = save_dir
        self.rng = random.Random(seed)
        self.characters = characters or CHARACTERS

        self.players: list[Player] = []
        self.events: list[dict] = []
        self.cond = asyncio.Condition()
        self.finished = False
        self.result: Optional[str] = None
        self.created = time.time()

        self.day = 0
        self.phase = "setup"
        self.pot = 0
        self.day_logs: dict[int, list[str]] = {}
        self.facts: dict[int, dict] = {}
        self.traitor_log: list[str] = []

    # ------------------------------------------------------------------ utilità
    def alive(self) -> list[Player]:
        return [p for p in self.players if p.alive]

    def alive_traitors(self) -> list[Player]:
        return [p for p in self.alive() if p.role == "traitor"]

    def alive_faithful(self) -> list[Player]:
        return [p for p in self.alive() if p.role == "faithful"]

    def by_name(self, name: str) -> Player:
        return next(p for p in self.players if p.name == name)

    def log(self, text: str, day: Optional[int] = None) -> None:
        self.day_logs.setdefault(day if day is not None else self.day, []).append(text)

    async def emit(self, type: str, text: str = "", *, actor: Optional[str] = None, secret: bool = False, **extra: Any):
        ev = {
            "n": len(self.events) + 1,
            "type": type,
            "day": self.day,
            "phase": self.phase,
            "actor": actor,
            "text": text,
            "secret": secret,
            **extra,
        }
        self.events.append(ev)
        async with self.cond:
            self.cond.notify_all()
        if self.delay:
            await asyncio.sleep(self.delay)

    async def set_phase(self, phase: str, label: str) -> None:
        self.phase = phase
        await self.emit("phase", label)

    # ----------------------------------------------------------------- prompt
    def system_prompt(self, p: Player) -> str:
        if p.role == "traitor":
            mates = [x.name for x in self.players if x.role == "traitor" and x is not p]
            role_txt = (
                "IL TUO RUOLO SEGRETO: sei un TRADITORE.\n"
                + (f"I tuoi complici sono: {', '.join(mates)}.\n" if mates else "Sei l'unico Traditore rimasto.\n")
                + "Di notte scegliete chi assassinare. Di giorno devi sembrare un Fedele: mentire, deviare i sospetti e "
                "sacrificare un complice solo se serve davvero sono mosse legittime. Non rivelare mai il tuo ruolo."
            )
        else:
            role_txt = (
                "IL TUO RUOLO SEGRETO: sei un FEDELE.\n"
                f"Non sai chi siano i Traditori (all'inizio erano {self.n_traitors}). "
                "Il tuo obiettivo è scoprirli ed eliminarli con il voto."
            )
        return (
            f"{BASE_RULES}\n"
            f"IL TUO PERSONAGGIO: ti chiami {p.name}, sei {p.archetype}.\n{p.prompt}\n\n{role_txt}"
        )

    def history(self) -> str:
        out: list[str] = []
        for d in sorted(self.day_logs):
            if d < self.day - 1 and d in self.facts:
                out.append(f"[Riepilogo giorno {d}] {self.summary(d)}")
            else:
                out.append(f"[Giorno {d}]")
                out.extend(self.day_logs[d])
        return "\n".join(out) if out else "(la partita è appena iniziata)"

    def summary(self, d: int) -> str:
        f = self.facts.get(d, {})
        parts = []
        if f.get("votes"):
            parts.append("Voti: " + "; ".join(f["votes"]) + ".")
        if f.get("elim"):
            parts.append(f"Eliminato dal voto: {f['elim']}.")
        if f.get("night"):
            parts.append(f"Notte: {f['night']}")
        return " ".join(parts) or "nessun evento"

    def context(self, p: Player) -> str:
        alive = self.alive()
        gone = [x for x in self.players if not x.alive]
        lines = [
            f"Siamo al giorno {self.day}. Montepremi attuale: {self.pot} €.",
            f"Ancora in gioco ({len(alive)}): {', '.join(x.name for x in alive)}.",
        ]
        if gone:
            lines.append("Usciti: " + "; ".join(f"{x.name} ({x.out_text})" for x in gone) + ".")
        if p.role == "traitor":
            others = [x.name for x in self.alive_traitors() if x is not p]
            lines.append("Complici Traditori ancora in gioco: " + (", ".join(others) if others else "nessuno") + ".")
            if self.traitor_log:
                lines.append("Chat segreta dei Traditori (ultime notti):\n" + "\n".join(self.traitor_log[-8:]))
        lines.append("\nSTORIA PUBBLICA DELLA PARTITA:\n" + self.history())
        if p.thoughts:
            lines.append("\nI TUOI ULTIMI PENSIERI PRIVATI:\n" + "\n".join(t[:300] for t in p.thoughts[-4:]))
        return "\n".join(lines)

    async def ask(
        self,
        p: Player,
        kind: str,
        task: str,
        options: Optional[list[str]] = None,
        max_tokens: int = 350,
    ) -> dict[str, Any]:
        user = self.context(p) + "\n\n" + task
        try:
            raw = await self.llm.complete(
                self.system_prompt(p), user, kind=kind, options=options, max_tokens=max_tokens, player=p.name
            )
        except LLMError as exc:
            await self.emit("warn", f"{p.name}: errore LLM, uso una scelta di riserva ({exc})", secret=True)
            return {}
        data = parse_json(raw)
        if not data and kind in ("speak", "murder") and raw.strip():
            data = {"say": raw.strip()[:400]}
        thought = data.get("thought")
        if thought:
            p.thoughts.append(f"G{self.day}: {thought}")
        return data

    # ----------------------------------------------------------------- fasi
    async def setup(self) -> None:
        self.players = [
            Player(
                id=i,
                name=c["name"],
                archetype=c.get("archetype") or "un concorrente",
                prompt=c["prompt"],
            )
            for i, c in enumerate(self.characters)
        ]
        for p in self.rng.sample(self.players, self.n_traitors):
            p.role = "traitor"
        await self.emit(
            "setup",
            f"{len(self.players)} concorrenti entrano nel castello.",
            players=[{"id": p.id, "name": p.name, "archetype": p.archetype, "role": p.role} for p in self.players],
        )
        await self.emit(
            "gm",
            f"{len(self.players)} concorrenti, {self.n_traitors} Traditori nascosti tra loro. Che il gioco abbia inizio.",
        )
        names = ", ".join(p.name for p in self.players if p.role == "traitor")
        await self.emit("gm", f"I Traditori sono: {names}.", secret=True)
        await self.emit("pot", pot=self.pot)

    async def mission(self) -> None:
        await self.set_phase("mission", f"Giorno {self.day} · Missione")
        title, desc = self.rng.choice(MISSIONS)
        gain = 250 * self.rng.randint(1, 6)
        self.pot += gain
        text = f"Missione «{title}»: {desc}. La squadra guadagna {gain} €."
        self.log(f"Missione: {title}. Montepremi +{gain} € (totale {self.pot} €).")
        await self.emit("gm", text)
        await self.emit("pot", pot=self.pot)

    async def discussion(self) -> None:
        await self.set_phase("discussion", f"Giorno {self.day} · Discussione")
        for r in range(1, self.rounds + 1):
            order = self.alive()[:]
            self.rng.shuffle(order)
            for p in order:
                others = [x.name for x in self.alive() if x is not p]
                task = (
                    f"COMPITO: discussione, giro {r} di {self.rounds}. Parla agli altri: puoi accusare, difenderti, "
                    f"difendere qualcuno o proporre chi votare stasera. Nomi validi: {', '.join(others)}.\n"
                    'Rispondi SOLO con un JSON valido, senza altro testo:\n'
                    '{"thought": "ragionamento privato (1-2 frasi, nessuno lo legge)", "say": "ciò che dici ad alta voce"}'
                )
                data = await self.ask(p, "speak", task, options=others)
                say = str(data.get("say") or "...").strip()
                self.log(f"{p.name}: {say}")
                await self.emit("speech", say, actor=p.name, thought=data.get("thought"))

    async def collect_votes(self, voters: list[Player], candidates: list[str], label: str) -> list[tuple[Player, str, Optional[str]]]:
        async def one(p: Player):
            opts = [c for c in candidates if c != p.name]
            note = "Ricorda: non votare i tuoi complici, salvo sacrificio strategico." if p.role == "traitor" else ""
            task = (
                f"COMPITO: {label}. Vota chi vuoi eliminare. Opzioni valide: {', '.join(opts)}. {note}\n"
                'Rispondi SOLO con un JSON valido, senza altro testo:\n'
                '{"thought": "perché voti così (1-2 frasi, privato)", "vote": "NomeEsatto"}'
            )
            data = await self.ask(p, "vote", task, options=opts, max_tokens=250)
            choice = match_name(data.get("vote"), opts) or self.rng.choice(opts)
            return p, choice, data.get("thought")

        results = await asyncio.gather(*[one(p) for p in voters])
        results = list(results)
        self.rng.shuffle(results)
        return results

    async def roundtable(self) -> Player:
        await self.set_phase("roundtable", f"Giorno {self.day} · Tavola rotonda")
        candidates = [p.name for p in self.alive()]
        votes = await self.collect_votes(self.alive(), candidates, "tavola rotonda")
        for p, target, thought in votes:
            await self.emit("vote", f"{p.name} vota {target}", actor=p.name, target=target, thought=thought)
        counts = Counter(t for _, t, _ in votes)
        await self.emit("tally", "Conteggio: " + ", ".join(f"{n} {c}" for n, c in counts.most_common()), counts=dict(counts))
        vote_lines = [f"{p.name}→{t}" for p, t, _ in votes]
        top = max(counts.values())
        tied = [n for n, c in counts.items() if c == top]

        if len(tied) > 1:
            await self.emit("gm", f"Parità tra {', '.join(tied)}. Si rivota solo tra loro.")
            revote = await self.collect_votes(self.alive(), tied, "spareggio")
            for p, target, thought in revote:
                await self.emit("vote", f"{p.name} vota {target}", actor=p.name, target=target, thought=thought, runoff=True)
            vote_lines += [f"{p.name}→{t} (spareggio)" for p, t, _ in revote]
            counts2 = Counter(t for _, t, _ in revote)
            await self.emit("tally", "Spareggio: " + ", ".join(f"{n} {c}" for n, c in counts2.most_common()), counts=dict(counts2))
            top2 = max(counts2.values())
            tied2 = [n for n, c in counts2.items() if c == top2]
            if len(tied2) > 1:
                await self.emit("gm", "Ancora parità: decide il destino.")
            out_name = self.rng.choice(tied2)
        else:
            out_name = tied[0]

        out = self.by_name(out_name)
        out.alive = False
        out.out_text = f"eliminato dal voto, era {role_label(out.role)}"
        self.facts[self.day] = {"votes": vote_lines, "elim": f"{out.name} (era {role_label(out.role)})"}
        self.log("Voti: " + "; ".join(vote_lines))
        self.log(f"ELIMINATO dal voto: {out.name}, era {role_label(out.role)}.")
        await self.emit(
            "eliminated",
            f"{out.name} lascia il castello.",
            actor=out.name,
            role=out.role,
            archetype=out.archetype,
        )
        return out

    async def night(self) -> None:
        await self.set_phase("night", f"Notte {self.day}")
        await self.emit("gm", "Cala la notte sul castello. I Traditori si riuniscono...")
        traitors = self.alive_traitors()[:]
        self.rng.shuffle(traitors)
        victims_pool = [p.name for p in self.alive_faithful()]
        can_recruit = len(traitors) == 1 and len(victims_pool) >= 3
        proposals: list[tuple[Player, str, str]] = []

        for t in traitors:
            so_far = "\n".join(f"- {pl.name} propone {tg}" for pl, tg, _ in proposals) or "(nessuna ancora)"
            recruit_txt = (
                'Sei l\'ultimo Traditore: puoi invece reclutare un Fedele ("action": "recruit") che potrà accettare '
                'o rifiutare (chi rifiuta viene assassinato). Altrimenti "action": "murder".\n'
                if can_recruit
                else ""
            )
            task = (
                f"COMPITO: è notte. Scegli con i complici chi assassinare. Vittime possibili: {', '.join(victims_pool)}.\n"
                f"Proposte dei complici finora:\n{so_far}\n{recruit_txt}"
                'Rispondi SOLO con un JSON valido, senza altro testo:\n'
                '{"thought": "ragionamento privato", "say": "messaggio ai complici (max 40 parole)", '
                '"target": "NomeEsatto", "action": "murder"}'
            )
            data = await self.ask(t, "murder", task, options=victims_pool)
            target = match_name(data.get("target"), victims_pool) or self.rng.choice(victims_pool)
            action = "recruit" if (can_recruit and data.get("action") == "recruit") else "murder"
            say = str(data.get("say") or f"Propongo {target}.").strip()
            proposals.append((t, target, action))
            self.traitor_log.append(f"Notte {self.day} — {t.name}: {say} (propone: {target})")
            await self.emit("traitor_chat", say, actor=t.name, secret=True, target=target, thought=data.get("thought"))

        counts = Counter(tg for _, tg, _ in proposals)
        top = max(counts.values())
        best = [n for n, c in counts.items() if c == top]
        target = next(tg for _, tg, _ in proposals if tg in best)  # in parità vince il primo a parlare
        recruiter, _, action = proposals[0]
        next_day = self.day + 1

        if action == "recruit":
            accepted = await self.recruit(recruiter, target)
            if accepted:
                self.facts.setdefault(self.day, {})["night"] = "nessun assassinio."
                self.log("Stanotte nessuno è stato assassinato.", day=next_day)
                self.phase = "morning"
                await self.emit("gm", "Alba sul castello: stanotte nessuno è stato assassinato.")
                return

        victim = self.by_name(target)
        victim.alive = False
        victim.out_text = "assassinato"
        self.facts.setdefault(self.day, {})["night"] = f"{victim.name} assassinato."
        self.log(f"ASSASSINATO nella notte: {victim.name}.", day=next_day)
        self.phase = "morning"
        await self.emit("murder", f"{victim.name} è stato assassinato nella notte.", actor=victim.name, role=victim.role, archetype=victim.archetype)

    async def recruit(self, recruiter: Player, target_name: str) -> bool:
        target = self.by_name(target_name)
        await self.emit("gm", f"{recruiter.name} offre a {target.name} di unirsi ai Traditori.", secret=True)
        task = (
            "COMPITO: di notte il Traditore ti offre di unirti a lui. Se accetti diventi Traditore e vinci con loro; "
            "se rifiuti verrai assassinato.\n"
            'Rispondi SOLO con un JSON valido, senza altro testo:\n'
            '{"thought": "ragionamento privato", "accept": true}  oppure  {"thought": "...", "accept": false}'
        )
        data = await self.ask(target, "recruit", task, options=[])
        raw = data.get("accept")
        accepted = raw is True or str(raw).strip().lower() in ("true", "si", "sì", "yes")
        if accepted:
            target.role = "traitor"
            self.traitor_log.append(f"Notte {self.day} — {target.name} è stato reclutato da {recruiter.name}.")
        await self.emit(
            "recruit",
            f"{target.name} {'accetta e diventa Traditore' if accepted else 'rifiuta'}.",
            actor=recruiter.name,
            target=target.name,
            accepted=accepted,
            secret=True,
            thought=data.get("thought"),
        )
        return accepted

    # --------------------------------------------------------------- fine
    def check_end(self) -> Optional[str]:
        t, f = len(self.alive_traitors()), len(self.alive_faithful())
        if t == 0:
            return "faithful"
        if t >= f:
            return "traitors"
        return None

    async def finish(self, winner: str) -> None:
        self.result = winner
        self.phase = "end"
        winners = self.alive_faithful() if winner == "faithful" else self.alive_traitors()
        share = self.pot // max(1, len(winners))
        label = "I Fedeli" if winner == "faithful" else "I Traditori"
        await self.emit(
            "end",
            f"{label} vincono! Montepremi {self.pot} €, {share} € a testa a "
            + ", ".join(p.name for p in winners) + ".",
            winner=winner,
            share=share,
            roles=[{"name": p.name, "role": p.role, "alive": p.alive} for p in self.players],
        )

    async def run(self) -> None:
        try:
            await self.setup()
            while True:
                self.day += 1
                await self.mission()
                await self.discussion()
                await self.roundtable()
                winner = self.check_end()
                if winner:
                    break
                await self.night()
                winner = self.check_end()
                if winner:
                    break
            await self.finish(winner)
        except asyncio.CancelledError:
            await self.emit("error", "Partita interrotta.", secret=False)
            raise
        except Exception as exc:  # noqa: BLE001
            await self.emit("error", f"Errore nel motore di gioco: {type(exc).__name__}: {exc}")
        finally:
            self.finished = True
            async with self.cond:
                self.cond.notify_all()
            self.save()

    def save(self) -> None:
        if not self.save_dir:
            return
        self.save_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "id": self.id,
            "created": self.created,
            "result": self.result,
            "meta": self.meta,
            "events": self.events,
        }
        (self.save_dir / f"{self.id}.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
