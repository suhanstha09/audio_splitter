export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center gap-6 px-6 py-16">
      <p className="text-sm font-medium text-zinc-500">Next.js + Node.js</p>
      <h1 className="text-4xl font-bold tracking-tight text-zinc-900 sm:text-5xl">
        Audio Splitter Starter
      </h1>
      <p className="max-w-2xl text-lg text-zinc-600">
        Frontend is powered by Next.js App Router. Backend logic runs on Node.js
        through route handlers under <code>/app/api</code>.
      </p>
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
        <p className="font-mono text-sm text-zinc-700">GET /api/health</p>
      </div>
    </main>
  );
}
