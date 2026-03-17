# Audio Splitter

Next.js + Node.js starter project.

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

## Useful scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
```
