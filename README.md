# Audio Splitter

Web app that splits an uploaded audio file into equal-length MP3 chunks and downloads them as a ZIP.

## Stack

- Next.js 16 (App Router)
- React 19
- TypeScript
- Tailwind CSS
- Node.js runtime route handlers

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## How to use

1. Open the app in your browser.
2. Upload any audio file.
3. Choose segment length in seconds.
4. Click `Split And Download`.
5. Downloaded zip contains `chunk-000.mp3`, `chunk-001.mp3`, and `manifest.json`.

## API example

Health check endpoint:

```bash
curl http://localhost:3000/api/health
```

Expected response:

```json
{
	"status": "ok",
	"runtime": "nodejs",
	"timestamp": "2026-03-17T00:00:00.000Z"
}
```

Split endpoint:

```bash
curl -X POST http://localhost:3000/api/split \
	-F "file=@/absolute/path/to/audio.mp3" \
	-F "segmentSeconds=30" \
	--output audio-chunks.zip
```

## Useful scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
```
