"""API FastAPI: crea partite, le trasmette in streaming (SSE) e serve la PWA."""
from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from characters import generate_character
from engine import Game
from llm import DEFAULT_MODEL, ClaudeLLM, LLMError, MockLLM
from personalities import CHARACTERS

BASE = Path(__file__).parent
FRONTEND = BASE.parent / "frontend"
GAMES_DIR = BASE / "games"
MAX_IN_MEMORY = 20

app = FastAPI(title="Traitors · simulazione con LLM")
GAMES: dict[str, Game] = {}
TASKS: dict[str, asyncio.Task] = {}


def has_key() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY"))


class CharacterIn(BaseModel):
    name: str = Field(max_length=20)
    archetype: str = Field("", max_length=60)
    prompt: str = Field(max_length=800)


class NewGame(BaseModel):
    mock: Optional[bool] = None
    traitors: int = Field(3, ge=1, le=4)
    rounds: int = Field(2, ge=1, le=3)
    delay: Optional[float] = Field(None, ge=0, le=5)
    model: Optional[str] = None
    seed: Optional[int] = None
    characters: Optional[list[CharacterIn]] = Field(None, min_length=6, max_length=14)


class GenerateIn(BaseModel):
    brief: str = Field(min_length=3, max_length=500)
    name: Optional[str] = Field(None, max_length=20)
    taken: list[str] = Field(default_factory=list, max_length=20)
    model: Optional[str] = None


BAD_NAME = re.compile(r'[,;:"{}\n\r\t]')


def clean_cast(chars: list[CharacterIn], n_traitors: int) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for c in chars:
        name = " ".join(c.name.split())
        if not name or BAD_NAME.search(name):
            raise HTTPException(422, f"Nome non valido: «{name}»")
        if name.casefold() in seen:
            raise HTTPException(422, f"Nome duplicato: {name}")
        seen.add(name.casefold())
        if not c.prompt.strip():
            raise HTTPException(422, f"{name}: manca la personalità")
        out.append({"name": name, "archetype": c.archetype.strip(), "prompt": c.prompt.strip()})
    if n_traitors * 2 >= len(out):
        raise HTTPException(422, "Troppi Traditori per questo numero di giocatori")
    return out


@app.get("/api/health")
def health():
    return {"llm": has_key(), "model": DEFAULT_MODEL}


@app.get("/api/characters")
def default_characters():
    return [{"name": c["name"], "archetype": c["archetype"], "prompt": c["prompt"]} for c in CHARACTERS]


@app.post("/api/characters/generate")
async def characters_generate(body: GenerateIn):
    """Scrive nome, archetipo e personalità di un personaggio a partire da una breve descrizione."""
    llm = None
    if has_key():
        try:
            llm = ClaudeLLM(model=body.model or None)
        except Exception as exc:
            raise HTTPException(500, f"Impossibile avviare il client LLM: {exc}")
    try:
        return await generate_character(llm, body.brief.strip(), (body.name or "").strip() or None, body.taken)
    except LLMError as exc:
        raise HTTPException(502, f"Generazione non riuscita: {exc}")


@app.post("/api/games")
async def create_game(body: NewGame):
    chars = clean_cast(body.characters, body.traitors) if body.characters else None
    mock = body.mock if body.mock is not None else not has_key()
    if not mock and not has_key():
        raise HTTPException(400, "ANTHROPIC_API_KEY non impostata: usa la modalità demo o configura la chiave.")
    try:
        llm = MockLLM(seed=body.seed) if mock else ClaudeLLM(model=body.model or None)
    except Exception as exc:  # pacchetto mancante, ecc.
        raise HTTPException(500, f"Impossibile avviare il client LLM: {exc}")

    gid = uuid.uuid4().hex[:8]
    delay = body.delay if body.delay is not None else (0.7 if mock else 0.15)
    game = Game(
        llm,
        gid,
        n_traitors=body.traitors,
        rounds=body.rounds,
        delay=delay,
        meta={"mock": mock, "model": llm.name, "traitors": body.traitors, "rounds": body.rounds},
        save_dir=GAMES_DIR,
        seed=body.seed,
        characters=chars,
    )
    GAMES[gid] = game
    TASKS[gid] = asyncio.create_task(game.run())
    while len(GAMES) > MAX_IN_MEMORY:  # scarta le più vecchie già finite
        old = next((k for k, g in GAMES.items() if g.finished), None)
        if not old:
            break
        GAMES.pop(old, None)
        TASKS.pop(old, None)
    return {"id": gid, "mock": mock, "model": llm.name}


def _load_saved(gid: str) -> Optional[dict]:
    path = GAMES_DIR / f"{gid}.json"
    if gid.isalnum() and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return None


@app.get("/api/games")
def list_games():
    items: dict[str, dict] = {}
    for f in sorted(GAMES_DIR.glob("*.json")) if GAMES_DIR.exists() else []:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            items[d["id"]] = {"id": d["id"], "created": d["created"], "finished": True, "result": d.get("result"), "meta": d.get("meta", {})}
        except (OSError, ValueError, KeyError):
            continue
    for gid, g in GAMES.items():
        items[gid] = {"id": gid, "created": g.created, "finished": g.finished, "result": g.result, "meta": g.meta}
    return sorted(items.values(), key=lambda x: x["created"], reverse=True)[:30]


@app.get("/api/games/{gid}/transcript")
def transcript(gid: str):
    g = GAMES.get(gid)
    if g:
        return {"id": gid, "result": g.result, "events": g.events}
    saved = _load_saved(gid)
    if not saved:
        raise HTTPException(404, "Partita non trovata")
    return saved


@app.get("/api/games/{gid}/events")
async def stream_events(gid: str, request: Request, last: int = 0):
    game = GAMES.get(gid)
    if not game:
        raise HTTPException(404, "Partita non trovata")
    try:
        start = int(request.headers.get("last-event-id", last))
    except ValueError:
        start = last

    async def gen():
        idx = start
        while True:
            if await request.is_disconnected():
                return
            while idx < len(game.events):
                ev = game.events[idx]
                idx += 1
                yield f"id: {idx}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
            if game.finished and idx >= len(game.events):
                yield "event: done\ndata: {}\n\n"
                return
            try:
                async with game.cond:
                    await asyncio.wait_for(
                        game.cond.wait_for(lambda: idx < len(game.events) or game.finished), timeout=15
                    )
            except asyncio.TimeoutError:
                yield ": ping\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/api/games/{gid}")
async def stop_game(gid: str):
    task = TASKS.get(gid)
    if not task:
        raise HTTPException(404, "Partita non trovata")
    task.cancel()
    return {"stopped": True}


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="web")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
