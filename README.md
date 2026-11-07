# The Traitors · simulazione con 10 agenti LLM

Backend Python (FastAPI) + frontend PWA. Dieci agenti LLM, ognuno con una personalità diversa, giocano una partita completa di *The Traitors*; la PWA la mostra in diretta.

## Avvio rapido

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Configura uno dei provider; senza chiave parte la modalità demo (risposte casuali)
export ANTHROPIC_API_KEY=sk-ant-...
# In alternativa:
# export OPENROUTER_API_KEY=sk-or-...
# export TRAITORS_MODEL=openai/gpt-4o-mini
# Se entrambe le chiavi sono configurate, puoi selezionare il provider:
# export TRAITORS_PROVIDER=openrouter  # oppure anthropic

python main.py        # oppure: uvicorn main:app --host 0.0.0.0 --port 8000
```

Apri http://localhost:8000. Da telefono, usa l'IP del computer nella stessa rete; per installare la PWA serve HTTPS (o `localhost`), ad esempio con un tunnel come Cloudflare Tunnel o ngrok.

## Come funziona

| Parte | File | Ruolo |
|---|---|---|
| Game master | `backend/engine.py` | Codice puro: ruoli segreti, missioni, voti, spareggi, notti, reclutamento, condizioni di vittoria. Gli LLM non possono barare né sbagliare le regole. |
| Generazione personaggi | `backend/characters.py` | Dato un breve spunto scrive nome, archetipo e personalità (LLM configurato, o bozza semplice senza chiave). |
| Personalità | `backend/personalities.py` | Regole comuni + 10 caratteri (Paranoica, Diplomatico, Logica, Teatrale, Silenziosa, Leale, Seduttrice, Burbero, Istintiva, Comico). |
| LLM | `backend/llm.py` | `ClaudeLLM` (API Anthropic), `OpenRouterLLM` (API OpenRouter) e `MockLLM` (demo gratuita). |
| API | `backend/main.py` | Crea partite, streaming eventi via SSE, replay delle partite salvate, serve la PWA. |
| Frontend | `frontend/` | PWA in JS puro, nessuna build. Service worker per la shell offline. |

**Separazione delle informazioni.** Ogni agente riceve solo: le regole, il proprio personaggio e ruolo, la storia pubblica e i propri pensieri privati. I Traditori vedono in più i complici e la propria chat notturna. I Fedeli non sanno nulla degli altri.

**Output.** Ogni agente risponde con un JSON `{"thought": ..., "say"/"vote"/"target": ...}`. Il `thought` è privato: non entra nel log pubblico ma lo vedi con **Vista dio**. Se il JSON è sbagliato o il nome non è valido, il motore usa una scelta di riserva.

**Memoria.** Il contesto non esplode: gli ultimi due giorni sono nel log completo, quelli più vecchi diventano un riepilogo (voti, eliminato, vittima).

## Regole implementate

- 10 giocatori, 2-4 Traditori (default 3), ruoli casuali.
- Ogni giorno: missione (montepremi +250…1500 €) → discussione (1-3 giri) → tavola rotonda → notte.
- Voti segreti raccolti in parallelo, poi rivelati uno a uno. Parità: spareggio solo tra i pari; ancora parità: decide il caso.
- Notte: i Traditori parlano a turno e propongono una vittima; vince la più votata, in parità la prima proposta.
- **Reclutamento**: se resta un solo Traditore (e almeno 3 Fedeli) può reclutare invece di uccidere. Chi rifiuta viene assassinato.
- Vincono i Fedeli se eliminano tutti i Traditori; vincono i Traditori se restano pari o più dei Fedeli.

## API

| Metodo | Percorso | Descrizione |
|---|---|---|
| GET | `/api/health` | Dice se la chiave API del provider configurato è disponibile |
| GET | `/api/characters` | Personaggi predefiniti |
| POST | `/api/characters/generate` | `{brief, name?, taken?}` → `{name, archetype, prompt, mock}` (generazione assistita) |
| POST | `/api/games` | `{mock, traitors, rounds, delay, model, seed, characters?}` → `{id}` (`characters`: 6-14 elementi `{name, archetype, prompt}`) |
| GET | `/api/games` | Elenco partite (salvate e in corso) |
| GET | `/api/games/{id}/events` | Stream SSE degli eventi (riprende con `Last-Event-ID`) |
| GET | `/api/games/{id}/transcript` | Tutti gli eventi della partita |
| DELETE | `/api/games/{id}` | Interrompe la partita |

Le partite finite vengono salvate in `backend/games/<id>.json` e si possono rivedere dall'app con **Rivedi**.

## Personalizzare

- **Personaggi dall'app**: in «Nuova partita» tocca *Personaggi e personalità*. Puoi modificare nome, archetipo e personalità, aggiungere o rimuovere giocatori (da 6 a 14) e ripristinare quelli predefiniti. Il cast viene ricordato dal browser. Il numero massimo di Traditori si adatta ai giocatori (sempre meno dei Fedeli).
- **Provider LLM**: usa `ANTHROPIC_API_KEY` per Anthropic oppure `OPENROUTER_API_KEY` per OpenRouter. Se è impostata solo la chiave OpenRouter, viene selezionato automaticamente; se sono presenti entrambe, Anthropic resta il provider predefinito. Imposta `TRAITORS_PROVIDER=openrouter` o `anthropic` per scegliere esplicitamente. `TRAITORS_MODEL` sovrascrive il modello predefinito (per OpenRouter, ad esempio, `openai/gpt-4o-mini`).
- **Scrivi con AI**: in ogni personaggio descrivi il carattere in poche parole (es. «un ex poliziotto che sospetta di tutti») e l'assistente scrive archetipo e personalità; se il nome è vuoto lo sceglie lui. Con una chiave API usa il provider configurato; senza, produce una bozza semplice da rivedere a mano.
- **Personaggi predefiniti**: sono la lista `CHARACTERS` in `personalities.py` (riavvia il server dopo averla cambiata).
- **Modelli diversi a confronto**: aggiungi un campo `model` a ogni personaggio e passalo al client del provider per giocatore (oggi il modello è unico per partita).
- **Più realismo**: scudo di immunità, pugnale, missioni con esito legato ai Traditori, finale con voto "chiudere o continuare". Il punto giusto dove inserirli è `Game.run()`.
- **Costi**: una partita da 10 giocatori usa circa 150-300 chiamate. Con Haiku resta economica; i turni di discussione sono la parte più costosa.

## Limiti noti

- Le partite in corso vivono in memoria: se riavvii il server si perdono quelle non finite.
- Nessuna autenticazione: pensata per uso locale o privato.
- La modalità demo è casuale, quindi non rappresenta l'equilibrio reale del gioco (vincono quasi sempre i Traditori).
