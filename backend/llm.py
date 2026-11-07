"""Livello LLM: client Claude e modalità demo (MockLLM) senza chiave API."""
from __future__ import annotations

import asyncio
import json
import os
import random
from typing import Optional

DEFAULT_MODEL = os.getenv("TRAITORS_MODEL", "claude-haiku-5-5")


class LLMError(Exception):
    pass


class BaseLLM:
    name = "base"

    async def complete(
        self,
        system: str,
        user: str,
        *,
        kind: str,
        options: Optional[list[str]] = None,
        max_tokens: int = 400,
        player: str = "",
    ) -> str:
        raise NotImplementedError


class ClaudeLLM(BaseLLM):
    """Chiama l'API di Claude. Richiede ANTHROPIC_API_KEY nell'ambiente."""

    def __init__(self, model: Optional[str] = None, concurrency: int = 6):
        import anthropic  # import locale: la demo funziona anche senza il pacchetto

        self.client = anthropic.AsyncAnthropic()
        self.model = model or DEFAULT_MODEL
        self.name = self.model
        self._sem = asyncio.Semaphore(concurrency)

    async def complete(self, system, user, *, kind, options=None, max_tokens=400, player=""):
        async with self._sem:
            last: Exception | None = None
            for attempt in range(3):
                try:
                    resp = await self.client.messages.create(
                        model=self.model,
                        max_tokens=max_tokens,
                        system=system,
                        messages=[{"role": "user", "content": user}],
                    )
                    return "".join(b.text for b in resp.content if b.type == "text")
                except Exception as exc:  # rete, rate limit, ecc.
                    last = exc
                    await asyncio.sleep(1.5 * (attempt + 1))
            raise LLMError(f"{type(last).__name__}: {last}")


_SPEAK = [
    "Non mi fido di {x}: ieri era troppo sicuro di sé.",
    "Secondo me {x} nasconde qualcosa. Guardate come evita le domande.",
    "Io sono un Fedele, lo giuro. Guardate {x}, piuttosto.",
    "Ho notato che {x} ha cambiato voto all'ultimo momento. Strano, no?",
    "Dobbiamo restare uniti, ma qualcuno qui mente. Io penso a {x}.",
    "Votiamo {x} e vediamo cosa succede: peggio di così non può andare.",
    "{x} difende sempre gli stessi nomi. A me puzza di complicità.",
    "Ho un brutto presentimento su {x}, non so spiegarlo.",
]
_THOUGHT = [
    "Devo sembrare innocente e spostare l'attenzione.",
    "Vediamo se qualcuno abbocca.",
    "Meglio non espormi troppo adesso.",
    "Questo voto può cambiare tutto.",
]


class MockLLM(BaseLLM):
    """Risposte casuali ma ben formate: serve a provare UI e motore senza spendere token."""

    name = "demo"

    def __init__(self, seed: Optional[int] = None):
        self.rng = random.Random(seed)

    async def complete(self, system, user, *, kind, options=None, max_tokens=400, player=""):
        await asyncio.sleep(0.01)
        opts = options or ["qualcuno"]
        pick = self.rng.choice(opts)
        thought = self.rng.choice(_THOUGHT)
        if kind == "speak":
            return json.dumps({"thought": thought, "say": self.rng.choice(_SPEAK).format(x=pick)}, ensure_ascii=False)
        if kind == "vote":
            return json.dumps({"thought": thought, "vote": pick}, ensure_ascii=False)
        if kind == "murder":
            action = "recruit" if '"recruit"' in user and self.rng.random() < 0.5 else "murder"
            return json.dumps(
                {"thought": thought, "say": f"Stanotte colpiamo {pick}.", "target": pick, "action": action},
                ensure_ascii=False,
            )
        if kind == "recruit":
            return json.dumps({"thought": thought, "accept": self.rng.random() < 0.6}, ensure_ascii=False)
        return "{}"
