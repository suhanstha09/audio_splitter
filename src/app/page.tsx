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
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center gap-6 px-6 py-16">
      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">AI Stem Splitter</p>
      <h1 className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100 sm:text-5xl">
        Separate Bass, Drums, Guitar, Vocals
      </h1>
      <p className="max-w-2xl text-lg text-zinc-600 dark:text-zinc-300">
        Powered by Demucs (`htdemucs_6s`) running on your backend.
      </p>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-700 dark:bg-zinc-900/50"
      >
        <label className="flex flex-col gap-2 text-sm text-zinc-700 dark:text-zinc-200">
          Audio file
          <input
            type="file"
            accept="audio/*"
            onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          />
        </label>

        <button
          type="submit"
          disabled={!file || status.type === "working"}
          className="mt-1 w-fit rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {status.type === "working" ? "Separating..." : "Extract Stems"}
        </button>

        <p
          className={`text-sm ${
            status.type === "error"
              ? "text-red-600 dark:text-red-400"
              : status.type === "success"
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-zinc-600 dark:text-zinc-300"
          }`}
        >
          {status.message}
        </p>
      </form>

      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-900/40">
        <p className="font-mono text-sm text-zinc-700 dark:text-zinc-200">POST /api/split</p>
      </div>
    </main>
  );
}
