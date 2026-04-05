"use client";

import JSZip from "jszip";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

const STEM_ORDER = ["bass", "drums", "guitar", "vocals"] as const;
const POLL_INTERVAL_MS = 1200;

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

type SplitJobStatusResponse = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  message: string;
  error?: string;
  fileName?: string;
  downloadUrl?: string | null;
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [stems, setStems] = useState<StemTrack[]>([]);
  const [downloadZip, setDownloadZip] = useState<{ url: string; fileName: string } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [separationProgress, setSeparationProgress] = useState(0);
  const [mutedByStem, setMutedByStem] = useState<Record<StemName, boolean>>({
    bass: false,
    drums: false,
    guitar: false,
    vocals: false,
  });
  const audioRefs = useRef<Partial<Record<StemName, HTMLAudioElement | null>>>({});
  const [status, setStatus] = useState<Status>({
    type: "idle",
    message: "Drop a track and render stems through the DAW rack below.",
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
    setSeparationProgress(0);
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
        message: "Playback was blocked by the browser. Click the page and try Play again.",
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

  async function waitForSplitCompletion(jobId: string): Promise<SplitJobStatusResponse> {
    while (true) {
      const response = await fetch(`/api/split?jobId=${encodeURIComponent(jobId)}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Unable to poll split status.");
      }

      const job = (await response.json()) as SplitJobStatusResponse;
      setSeparationProgress(clampPercent(job.progress));

      if (job.status === "completed") {
        return job;
      }

      if (job.status === "failed") {
        throw new Error(job.error ?? job.message ?? "Stem separation failed.");
      }

      setStatus({
        type: "working",
        message: job.message || "Separating stems...",
      });

      await sleep(POLL_INTERVAL_MS);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!file) {
      setStatus({ type: "error", message: "Choose an audio file first." });
      return;
    }

    clearStemAssets();
    setSeparationProgress(2);
    setStatus({
      type: "working",
      message: "Creating a split job and warming up Demucs.",
    });

    try {
      const formData = new FormData();
      formData.append("file", file);

      const startResponse = await fetch("/api/split", {
        method: "POST",
        body: formData,
      });

      if (!startResponse.ok) {
        const data = (await startResponse.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        throw new Error(data?.detail ?? data?.error ?? "Unable to start stem separation.");
      }

      const started = (await startResponse.json()) as { jobId?: string; error?: string };

      if (!started.jobId) {
        throw new Error(started.error ?? "Split job id was not returned by the server.");
      }

      const result = await waitForSplitCompletion(started.jobId);

      if (!result.downloadUrl) {
        throw new Error("Split completed without a downloadable zip artifact.");
      }

      setStatus({ type: "working", message: "Downloading and preparing stems in the mixer." });
      const zipResponse = await fetch(result.downloadUrl, { cache: "no-store" });

      if (!zipResponse.ok) {
        throw new Error("Split finished, but the zip could not be downloaded.");
      }

      const zipBlob = await zipResponse.blob();
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
      const serverFileName = result.fileName;

      setDownloadZip({
        url: URL.createObjectURL(zipBlob),
        fileName: serverFileName ?? defaultName,
      });
      setStems(extractedStems);
      setIsPlaying(false);
      setPlaybackPosition(0);
      setPlaybackDuration(0);
      setMutedByStem({
        bass: false,
        drums: false,
        guitar: false,
        vocals: false,
      });
      setSeparationProgress(100);

      setStatus({
        type: "success",
        message: "Stems loaded. Use the transport controls and channel mutes to preview your mix.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stem separation failed unexpectedly.";
      setStatus({ type: "error", message });
    }
  }

  const isWorking = status.type === "working";
  const progressLabel = `${clampPercent(separationProgress)}%`;

  return (
    <main className="daw-shell mx-auto min-h-screen w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <section className="console-frame fade-in grid gap-5 rounded-3xl p-4 sm:p-6 lg:grid-cols-[1.2fr_0.8fr] lg:p-7">
        <div className="space-y-4">
          <header className="console-header rounded-2xl border px-4 py-4 sm:px-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-(--accent)">
              Audio Splitter DAW
            </p>
            <h1 className="text-2xl font-bold tracking-tight sm:text-4xl">Stem Separation Console</h1>
            <p className="mt-2 max-w-3xl text-sm text-(--ink-dim) sm:text-base">
              Render bass, drums, guitar, and vocals into synchronized channels, then audition in a mixer-style layout.
            </p>
          </header>

          <form onSubmit={handleSubmit} className="daw-panel rounded-2xl border p-4 sm:p-5">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="block rounded-xl border border-dashed border-(--line) bg-(--surface-hi) p-4">
                <span className="mb-2 block text-sm font-semibold">Source Audio</span>
                <span className="mb-3 block text-xs text-(--ink-dim)">Any browser-readable audio format.</span>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
                  className="daw-input block w-full rounded-lg px-3 py-2 text-sm"
                />
                <span className="mt-3 block text-xs font-mono text-(--ink-dim)">
                  {file ? `selected: ${file.name}` : "selected: none"}
                </span>
              </label>

              <button
                type="submit"
                disabled={!file || isWorking}
                className="transport-button h-fit rounded-xl px-5 py-3 text-sm font-semibold uppercase tracking-widest disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isWorking ? "Rendering..." : "Render Stems"}
              </button>
            </div>

            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between text-xs font-mono text-(--ink-dim)">
                <span>Separation Progress</span>
                <span>{progressLabel}</span>
              </div>
              <div className="progress-track h-2 w-full overflow-hidden rounded-full">
                <div
                  className="progress-fill h-full rounded-full"
                  style={{ width: `${clampPercent(separationProgress)}%` }}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={clampPercent(separationProgress)}
                  aria-label="Separation progress"
                />
              </div>
            </div>

            <p
              className={`mt-4 rounded-xl border px-3 py-2 text-sm ${
                status.type === "error"
                  ? "border-red-400/55 bg-red-950/45 text-red-100"
                  : status.type === "success"
                    ? "border-emerald-400/45 bg-emerald-950/40 text-emerald-100"
                    : "border-(--line) bg-(--surface-hi) text-(--ink)"
              }`}
            >
              {status.message}
            </p>
          </form>

          <section className="daw-panel rounded-2xl border p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-(--accent)">Transport</p>
                <h2 className="text-xl font-semibold">Master Timeline</h2>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={togglePlayAll} className="transport-chip rounded-lg px-4 py-2 text-sm font-semibold" disabled={stems.length === 0}>
                  {isPlaying ? "Pause" : "Play"}
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
                  className="transport-chip rounded-lg px-3 py-2 text-sm"
                  disabled={stems.length === 0}
                >
                  -5s
                </button>
                <button
                  type="button"
                  onClick={() => setSyncedPosition(0)}
                  className="transport-chip rounded-lg px-3 py-2 text-sm"
                  disabled={stems.length === 0}
                >
                  Start
                </button>
              </div>
            </div>

            <label className="block">
              <span className="mb-2 flex items-center justify-between text-xs font-mono text-(--ink-dim)">
                <span>
                  {Math.floor(playbackPosition / 60)
                    .toString()
                    .padStart(2, "0")}
                  :
                  {Math.floor(playbackPosition % 60)
                    .toString()
                    .padStart(2, "0")}
                </span>
                <span>
                  {Math.floor(playbackDuration / 60)
                    .toString()
                    .padStart(2, "0")}
                  :
                  {Math.floor(playbackDuration % 60)
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
                className="timeline-slider w-full"
              />
            </label>
          </section>
        </div>

        <aside className="daw-panel rounded-2xl border p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-(--accent)">Mixer</p>
              <h2 className="text-xl font-semibold">Channel Strips</h2>
            </div>
            {downloadZip && (
              <a href={downloadZip.url} download={downloadZip.fileName} className="transport-chip rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em]">
                Download ZIP
              </a>
            )}
          </div>

          {stems.length === 0 ? (
            <div className="rounded-xl border border-(--line) bg-(--surface-hi) p-4 text-sm text-(--ink-dim)">
              Render stems to populate channel strips.
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
              {stems.map((stem) => {
                const isMuted = mutedByStem[stem.name];

                return (
                  <li key={stem.name} className="channel-strip rounded-xl border border-(--line) p-3">
                    <p className="text-xs uppercase tracking-[0.12em] text-(--ink-dim)">Channel</p>
                    <p className="mt-1 text-sm font-semibold capitalize">{stem.name}</p>
                    <div className="vu-stack mt-3" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                      <span />
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleStemMute(stem.name)}
                      className={`mt-3 w-full rounded-md px-2 py-2 text-xs font-semibold uppercase tracking-[0.08em] ${
                        isMuted ? "mute-off" : "mute-on"
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
          )}

          <div className="mt-4 rounded-xl border border-(--line) bg-(--surface-hi) p-3 text-xs text-(--ink-dim)">
            Endpoint: <span className="font-mono">POST /api/split</span> and progress polling via <span className="font-mono">GET /api/split?jobId=...</span>
          </div>
        </aside>
      </section>
    </main>
  );
}
