"""Livello LLM: client Anthropic, OpenRouter e modalità demo (MockLLM)."""
from __future__ import annotations

import asyncio
import json
import os
import random
from typing import Optional

class LLMError(Exception):
    pass


def configured_provider() -> str:
    provider = os.getenv("TRAITORS_PROVIDER", "").strip().lower()
    if provider:
        if provider not in {"anthropic", "openrouter"}:
            raise LLMError("TRAITORS_PROVIDER deve essere 'anthropic' oppure 'openrouter'.")
        return provider
    if os.getenv("OPENROUTER_API_KEY") and not os.getenv("ANTHROPIC_API_KEY"):
        return "openrouter"
    return "anthropic"


def has_llm_key() -> bool:
    key_name = "OPENROUTER_API_KEY" if configured_provider() == "openrouter" else "ANTHROPIC_API_KEY"
    return bool(os.getenv(key_name))


DEFAULT_MODEL = os.getenv("TRAITORS_MODEL") or (
    "openai/gpt-6-luna" if configured_provider() == "openrouter" else "claude-haiku-5-5"
)


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
            retry_max_tokens = max_tokens
            for attempt in range(3):
                try:
                    resp = await self.client.messages.create(
                        model=self.model,
                        max_tokens=retry_max_tokens,
                        system=system,
                        messages=[{"role": "user", "content": user}],
                    )
                    if resp.stop_reason == "max_tokens":
                        if attempt < 2:
                            retry_max_tokens *= 2
                            continue
                        raise LLMError(
                            f"La risposta di {self.model} è stata troncata anche dopo tre tentativi. "
                            "Prova un modello con un limite di output maggiore."
                        )
                    return "".join(b.text for b in resp.content if b.type == "text")
                except LLMError:
                    raise
                except Exception as exc:  # rete, rate limit, ecc.
                    last = exc
                    await asyncio.sleep(1.5 * (attempt + 1))
            raise LLMError(f"{type(last).__name__}: {last}")


class OpenRouterLLM(BaseLLM):
    """Chiama OpenRouter tramite la sua API compatibile con OpenAI."""

    def __init__(self, model: Optional[str] = None, concurrency: int = 6):
        import openai

        self.client = openai.AsyncOpenAI(
            api_key=os.environ["OPENROUTER_API_KEY"],
            base_url="https://openrouter.ai/api/v1",
        )
        self.model = model or DEFAULT_MODEL
        self.name = self.model
        self._sem = asyncio.Semaphore(concurrency)

    async def complete(self, system, user, *, kind, options=None, max_tokens=400, player=""):
        async with self._sem:
            last: Exception | None = None
            retry_max_tokens = max_tokens
            for attempt in range(3):
                try:
                    resp = await self.client.chat.completions.create(
                        model=self.model,
                        max_tokens=retry_max_tokens,
                        messages=[
                            {"role": "system", "content": system},
                            {"role": "user", "content": user},
                        ],
                    )
                    choice = resp.choices[0]
                    content = choice.message.content
                    if choice.finish_reason == "length":
                        if attempt < 2:
                            retry_max_tokens *= 2
                            continue
                        raise LLMError(
                            f"La risposta di {self.model} è stata troncata anche dopo tre tentativi. "
                            "Prova un modello con un limite di output maggiore."
                        )
                    if not isinstance(content, str) or not content.strip():
                        reason = f", motivo: {choice.finish_reason}" if choice.finish_reason else ""
                        raise LLMError(
                            f"OpenRouter non ha restituito testo dal modello {self.model}{reason}. "
                            "Verifica il modello selezionato o impostane uno compatibile con TRAITORS_MODEL."
                        )
                    return content
                except LLMError:
                    raise
                except Exception as exc:  # rete, rate limit, ecc.
                    last = exc
                    await asyncio.sleep(1.5 * (attempt + 1))
            raise LLMError(f"{type(last).__name__}: {last}")


def create_llm(model: Optional[str] = None) -> BaseLLM:
    if configured_provider() == "openrouter":
        return OpenRouterLLM(model=model)
    return ClaudeLLM(model=model)


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
