# Audio Stem Splitter

Next.js app that separates one uploaded song into AI-generated stems and returns a ZIP download.

## Stems generated

- bass
- drums
- guitar
- vocals

Model used: `Demucs htdemucs_6s`.

## Stack

- Next.js 16 (App Router)
- React 19
- TypeScript
- Tailwind CSS
- Node.js route handlers
- Python Demucs (`demucs` package in `.venv`)

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## How to use

1. Upload audio in the web UI.
2. Click `Extract Stems`.
3. Wait for server-side AI separation.
4. Use the in-app stem mixer to play all stems in sync, seek through the song, and mute/unmute each stem individually.
5. Download ZIP with `bass.mp3`, `drums.mp3`, `guitar.mp3`, `vocals.mp3`, and `manifest.json`.

## API

Health check:

```bash
curl http://localhost:3000/api/health
```

Stem separation:

```bash
curl -X POST http://localhost:3000/api/split \
  -F "file=@/absolute/path/to/song.mp3" \
  --output song-stems.zip
```

## Notes

- First run may be slower because Demucs model weights are downloaded.
- For very long tracks on CPU, processing can take several minutes.
- If needed, set custom Python path with env var `DEMUCS_PYTHON`.

## Deploying on Vercel

This app cannot run Demucs directly inside Vercel serverless functions because stem separation needs:

- Python + Demucs runtime
- long-running processing beyond typical serverless request limits
- persistent shared job state across polling requests

Use Vercel for the web app, and run the split worker on a container/VM platform.

1. Deploy this same app (or just the `/api/split*` routes) to a worker host that supports Python + ffmpeg (Railway, Render, Fly.io, ECS, etc.).
2. On that worker, install Demucs and set `DEMUCS_PYTHON` if needed.
3. In Vercel project settings, add env var:

```bash
SPLIT_WORKER_URL=https://your-worker-domain.example.com
```

When `SPLIT_WORKER_URL` is set, Vercel proxies these endpoints to the worker:

- `POST /api/split`
- `GET /api/split?jobId=...`
- `GET /api/split/:jobId/download`
