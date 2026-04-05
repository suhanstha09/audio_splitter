"use client";

import JSZip from "jszip";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

const STEM_ORDER = ["bass", "drums", "guitar", "vocals"] as const;

type StemName = (typeof STEM_ORDER)[number];

type StemTrack = {
  name: StemName;
  url: string;
};

type Status =
  | { type: "idle"; message: string }
  | { type: "working"; message: string }
  | { type: "success"; message: string }
  | { type: "error"; message: string };

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [stems, setStems] = useState<StemTrack[]>([]);
  const [downloadZip, setDownloadZip] = useState<{ url: string; fileName: string } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [mutedByStem, setMutedByStem] = useState<Record<StemName, boolean>>({
    bass: false,
    drums: false,
    guitar: false,
    vocals: false,
  });
  const audioRefs = useRef<Partial<Record<StemName, HTMLAudioElement | null>>>({});
  const [status, setStatus] = useState<Status>({
    type: "idle",
    message: "Upload audio to extract stems: bass, drums, guitar, vocals.",
  });

  const availableStemNames = useMemo(() => stems.map((stem) => stem.name), [stems]);

  useEffect(() => {
    return () => {
      stems.forEach((stem) => URL.revokeObjectURL(stem.url));

      if (downloadZip) {
        URL.revokeObjectURL(downloadZip.url);
      }
    };
  }, [downloadZip, stems]);

  useEffect(() => {
    stems.forEach((stem) => {
      const audio = audioRefs.current[stem.name];
      if (audio) {
        audio.muted = mutedByStem[stem.name];
      }
    });
  }, [mutedByStem, stems]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const leader = stems.map((stem) => audioRefs.current[stem.name]).find(Boolean);

      if (!leader) {
        return;
      }

      setPlaybackPosition(leader.currentTime);

      if (leader.ended) {
        setIsPlaying(false);
      }
    }, 120);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isPlaying, stems]);

  function resetStemState() {
    setIsPlaying(false);
    setPlaybackPosition(0);
    setPlaybackDuration(0);
    setMutedByStem({
      bass: false,
      drums: false,
      guitar: false,
      vocals: false,
    });
  }

  function clearStemAssets() {
    stems.forEach((stem) => URL.revokeObjectURL(stem.url));

    if (downloadZip) {
      URL.revokeObjectURL(downloadZip.url);
    }

    setStems([]);
    setDownloadZip(null);
    resetStemState();
  }

  function setSyncedPosition(seconds: number) {
    const nextPosition = Number.isFinite(seconds) ? seconds : 0;
    stems.forEach((stem) => {
      const audio = audioRefs.current[stem.name];

      if (audio) {
        audio.currentTime = nextPosition;
      }
    });
    setPlaybackPosition(nextPosition);
  }

  async function togglePlayAll() {
    if (stems.length === 0) {
      return;
    }

    const syncedPlayers = stems
      .map((stem) => audioRefs.current[stem.name])
      .filter((audio): audio is HTMLAudioElement => Boolean(audio));

    if (syncedPlayers.length === 0) {
      return;
    }

    if (isPlaying) {
      syncedPlayers.forEach((audio) => audio.pause());
      setPlaybackPosition(syncedPlayers[0].currentTime);
      setIsPlaying(false);
      return;
    }

    syncedPlayers.forEach((audio) => {
      audio.currentTime = playbackPosition;
    });

    const results = await Promise.allSettled(syncedPlayers.map((audio) => audio.play()));
    const started = results.some((result) => result.status === "fulfilled");

    if (!started) {
      setStatus({
        type: "error",
        message: "Playback was blocked by the browser. Click the page and try Play All again.",
      });
      setIsPlaying(false);
      return;
    }

    setIsPlaying(true);
  }

  function toggleStemMute(stemName: StemName) {
    setMutedByStem((previous) => ({
      ...previous,
      [stemName]: !previous[stemName],
    }));
  }

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
    clearStemAssets();

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

      const zipBlob = await response.blob();
      const zip = await JSZip.loadAsync(zipBlob);
      const extractedStems: StemTrack[] = [];

      for (const stemName of STEM_ORDER) {
        const stemFile = zip.file(`${stemName}.mp3`);

        if (!stemFile) {
          continue;
        }

        const stemBlob = await stemFile.async("blob");
        extractedStems.push({
          name: stemName,
          url: URL.createObjectURL(stemBlob),
        });
      }

      if (extractedStems.length === 0) {
        throw new Error("No playable stem files were found in the split result.");
      }

      const defaultName = `${file.name.replace(/\.[^/.]+$/, "") || "audio"}-stems.zip`;
      const contentDisposition = response.headers.get("Content-Disposition");
      const serverFileName = contentDisposition?.match(/filename="?([^";]+)"?/)?.[1];

      setDownloadZip({
        url: URL.createObjectURL(zipBlob),
        fileName: serverFileName ?? defaultName,
      });
      setStems(extractedStems);
      resetStemState();

      setStatus({
        type: "success",
        message: "Done. Stems are ready to play together below, with per-stem mute controls.",
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

            {stems.length > 0 && (
              <section className="space-y-4 rounded-2xl border border-[var(--line)] bg-[var(--panel-strong)] p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--accent)]">
                      Stem Mixer
                    </p>
                    <h2 className="text-xl font-semibold">Play all stems in sync</h2>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={togglePlayAll}
                      className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition hover:translate-y-[-1px] hover:bg-[color:color-mix(in_srgb,var(--accent)_85%,black_15%)]"
                    >
                      {isPlaying ? "Pause All" : "Play All"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const firstAudio = stems
                          .map((stem) => audioRefs.current[stem.name])
                          .find((audio): audio is HTMLAudioElement => Boolean(audio));
                        const nextPosition = firstAudio ? Math.max(0, firstAudio.currentTime - 5) : 0;
                        setSyncedPosition(nextPosition);
                      }}
                      className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm font-medium transition hover:bg-[color:color-mix(in_srgb,var(--panel)_60%,white_40%)]"
                    >
                      -5s
                    </button>
                    <button
                      type="button"
                      onClick={() => setSyncedPosition(0)}
                      className="rounded-xl border border-[var(--line)] px-3 py-2 text-sm font-medium transition hover:bg-[color:color-mix(in_srgb,var(--panel)_60%,white_40%)]"
                    >
                      Restart
                    </button>
                  </div>
                </div>

                <label className="block space-y-2">
                  <span className="flex items-center justify-between text-xs font-mono text-[color:color-mix(in_srgb,var(--foreground)_74%,transparent)]">
                    <span>
                      {Math.floor(playbackPosition / 60)
                        .toString()
                        .padStart(2, "0")}
                      :{Math.floor(playbackPosition % 60)
                        .toString()
                        .padStart(2, "0")}
                    </span>
                    <span>
                      {Math.floor(playbackDuration / 60)
                        .toString()
                        .padStart(2, "0")}
                      :{Math.floor(playbackDuration % 60)
                        .toString()
                        .padStart(2, "0")}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(playbackDuration, 1)}
                    step={0.01}
                    value={Math.min(playbackPosition, Math.max(playbackDuration, 1))}
                    onChange={(event) => setSyncedPosition(Number(event.currentTarget.value))}
                    className="w-full accent-[var(--brand)]"
                  />
                </label>

                <ul className="grid gap-2 sm:grid-cols-2">
                  {stems.map((stem) => {
                    const isMuted = mutedByStem[stem.name];

                    return (
                      <li
                        key={stem.name}
                        className="flex items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[color:color-mix(in_srgb,var(--panel)_70%,white_30%)] px-3 py-2.5"
                      >
                        <div>
                          <p className="text-sm font-semibold capitalize">{stem.name}</p>
                          <p className="text-xs text-[color:color-mix(in_srgb,var(--foreground)_65%,transparent)]">
                            {isMuted ? "Muted" : "Live"}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleStemMute(stem.name)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] transition ${
                            isMuted
                              ? "border border-[var(--line)] bg-transparent text-[var(--foreground)] hover:bg-[color:color-mix(in_srgb,var(--panel)_55%,white_45%)]"
                              : "bg-[var(--brand)] text-white hover:bg-[color:color-mix(in_srgb,var(--brand)_85%,black_15%)]"
                          }`}
                        >
                          {isMuted ? "Unmute" : "Mute"}
                        </button>

                        <audio
                          ref={(node) => {
                            audioRefs.current[stem.name] = node;
                          }}
                          src={stem.url}
                          preload="metadata"
                          onLoadedMetadata={(event) => {
                            const currentDuration = event.currentTarget.duration;
                            if (Number.isFinite(currentDuration)) {
                              setPlaybackDuration((previousDuration) => Math.max(previousDuration, currentDuration));
                            }
                          }}
                          onEnded={() => {
                            if (stem.name === availableStemNames[0]) {
                              setIsPlaying(false);
                            }
                          }}
                          className="hidden"
                        />
                      </li>
                    );
                  })}
                </ul>

                {downloadZip && (
                  <a
                    href={downloadZip.url}
                    download={downloadZip.fileName}
                    className="inline-flex rounded-xl border border-[var(--line)] px-4 py-2 text-sm font-semibold transition hover:bg-[color:color-mix(in_srgb,var(--panel)_55%,white_45%)]"
                  >
                    Download Stems ZIP
                  </a>
                )}
              </section>
            )}
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
