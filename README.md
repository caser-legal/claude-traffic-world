# Traffic light — a 3D intersection for Claude Code sessions

A browser diorama of a four-way intersection. Cars are Claude Code tasks. The page is a local dashboard, not a hosted service.

## What the colors mean

| Signal | Meaning |
| --- | --- |
| Red | Waiting on a result, often a permission prompt |
| Yellow | Working; speed tracks progress |
| Green | Done; the car drives through |
| Crash | A tool call failed |
| Queue | Task backlog |

Civilian cars are ambient traffic. They follow the lights and do not represent tasks.

The scene is a top-down world on a canvas (`world.js`), tilted with CSS. Static road and building art is baked once. Cars, signals, and weather update every frame. `app.js` drives the UI. `session.js` reads session events. `server.py` is a stdlib-only HTTP server.

## Run

Python 3 is enough. No packages to install.

```sh
python3 server.py
```

Open **http://127.0.0.1:8765/**. The default port is 8765. Pass another port as the first argument: `python3 server.py 9000`.

Opening `index.html` as a file redirects to that local server. Weather and session tailing need the server.

## What the server does

- Serves this directory.
- `GET /api/sessions` lists the newest Claude Code transcript (`*.jsonl`) under `~/.claude/projects`, up to eight projects.
- `GET /api/tail?file=...&offset=...` returns the next chunk of one transcript. The file must stay under `~/.claude/projects`.
- `GET /api/weather?zip=...` looks up a postal code and proxies Open-Meteo. No API key.

Modes in the panel:

- **Live** tails transcripts on this computer.
- **Replay** plays a saved session faster (1×, 4×, 12×, 40×).
- **Demo** injects tasks without a Claude session (`+ task`, `fail one`, `hold 5s`).

Set a postal code in the panel if you want the sky to follow real weather. The server binds to loopback only.

## Layout

```
server.py    local API and static files
index.html   page shell
style.css    layout
world.js     intersection renderer
app.js       controls and modes
session.js   transcript parsing
```

Claude Code stores project transcripts on the machine where you run it. This app only reads those local files. It does not upload them.
