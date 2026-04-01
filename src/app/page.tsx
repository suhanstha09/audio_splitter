"use client";

import { FormEvent, useState } from "react";

type Status =
  | { type: "idle"; message: string }
  | { type: "working"; message: string }
  | { type: "success"; message: string }
  | { type: "error"; message: string };

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({
    type: "idle",
    message: "Upload audio to extract stems: bass, drums, guitar, vocals.",
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!file) {
      setStatus({ type: "error", message: "Choose an audio file first." });
      return;
    }

    setStatus({
      type: "working",
      message: "Separating stems with Demucs. This can take up to a few minutes.",
    });

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/split", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        throw new Error(data?.detail ?? data?.error ?? "Stem separation request failed.");
      }

      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const downloadAnchor = document.createElement("a");
      const defaultName = `${file.name.replace(/\.[^/.]+$/, "") || "audio"}-stems.zip`;
      const contentDisposition = response.headers.get("Content-Disposition");
      const serverFileName = contentDisposition?.match(/filename="?([^";]+)"?/)?.[1];

      downloadAnchor.href = href;
      downloadAnchor.download = serverFileName ?? defaultName;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      document.body.removeChild(downloadAnchor);
      URL.revokeObjectURL(href);

      setStatus({
        type: "success",
        message: "Done. Downloaded zip includes bass, drums, guitar, and vocals stems.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stem separation failed unexpectedly.";
      setStatus({ type: "error", message });
    }
  }

  return (
    <main className="relative mx-auto min-h-screen w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-10 lg:px-12 lg:py-14">
      <section className="fade-in relative grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="glass-panel relative overflow-hidden rounded-3xl p-6 sm:p-8">
          <div className="ambient-orb orb-a" aria-hidden="true" />
          <div className="ambient-orb orb-b" aria-hidden="true" />

          <div className="relative z-10 flex flex-col gap-6">
            <div className="space-y-3">
              <p className="inline-flex w-fit rounded-full border border-[var(--line)] bg-[var(--panel-strong)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--accent)]">
                Audio Splitter Studio
              </p>
              <h1 className="max-w-xl text-3xl font-bold leading-tight tracking-tight sm:text-5xl">
                Clean stem extraction for production-ready workflows.
              </h1>
              <p className="max-w-2xl text-sm leading-relaxed text-[color:color-mix(in_srgb,var(--foreground)_75%,transparent)] sm:text-base">
                Drop one track and export a zip with isolated bass, drums, guitar, and vocals.
                Backed by Demucs htdemucs_6s on your server.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 rounded-2xl border border-[var(--line)] bg-[var(--panel-strong)] p-4 sm:p-5">
              <label className="block rounded-2xl border border-dashed border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel)_70%,white_30%)] p-4 sm:p-6">
                <span className="mb-2 block text-sm font-semibold">Upload Audio File</span>
                <span className="mb-4 block text-xs text-[color:color-mix(in_srgb,var(--foreground)_65%,transparent)]">
                  Supports any browser-readable audio type.
                </span>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
                  className="block w-full rounded-xl border border-[var(--line)] bg-white/80 px-3 py-2 text-sm outline-none ring-[var(--brand-soft)] transition focus:ring-2 dark:bg-black/10"
                />
                <span className="mt-3 block text-xs font-mono text-[color:color-mix(in_srgb,var(--foreground)_75%,transparent)]">
                  {file ? `selected: ${file.name}` : "selected: none"}
                </span>
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  disabled={!file || status.type === "working"}
                  className="rounded-xl bg-[var(--brand)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(232,93,4,0.25)] transition hover:translate-y-[-1px] hover:bg-[color:color-mix(in_srgb,var(--brand)_85%,black_15%)] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {status.type === "working" ? "Separating..." : "Extract Stems"}
                </button>
                <p className="text-xs text-[color:color-mix(in_srgb,var(--foreground)_65%,transparent)] sm:text-sm">
                  Typical run time: 1-3 minutes depending on track length.
                </p>
              </div>

              <p
                className={`rounded-xl border px-3 py-2 text-sm ${
                  status.type === "error"
                    ? "border-red-300/70 bg-red-100/70 text-red-800 dark:border-red-400/40 dark:bg-red-950/40 dark:text-red-200"
                    : status.type === "success"
                      ? "border-emerald-300/70 bg-emerald-100/70 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-950/40 dark:text-emerald-200"
                      : "border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel)_75%,white_25%)] text-[color:color-mix(in_srgb,var(--foreground)_82%,transparent)]"
                }`}
              >
                {status.message}
              </p>
            </form>
          </div>
        </div>

        <aside className="glass-panel fade-in rounded-3xl p-6 sm:p-8" style={{ animationDelay: "120ms" }}>
          <div className="space-y-6">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--accent)]">
                Session Output
              </p>
              <h2 className="text-2xl font-semibold">What You Get</h2>
            </div>

            <ul className="space-y-3 text-sm">
              {[
                "Bass stem (wav)",
                "Drums stem (wav)",
                "Guitar stem (wav)",
                "Vocals stem (wav)",
              ].map((item) => (
                <li key={item} className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] px-3 py-2.5">
                  <span className="h-2 w-2 rounded-full bg-[var(--brand)]" aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] p-4">
              <p className="mb-1 text-xs uppercase tracking-[0.12em] text-[color:color-mix(in_srgb,var(--foreground)_65%,transparent)]">
                API Endpoint
              </p>
              <p className="font-mono text-sm">POST /api/split</p>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
