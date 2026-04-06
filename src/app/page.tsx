"use client";

import JSZip from "jszip";
import { DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";

const STEM_ORDER = [
  "drums",
  "bass",
  "rhythm_guitar",
  "lead_guitar",
  "guitar",
  "piano",
  "vocals",
  "other",
] as const;
const POLL_INTERVAL_MS = 1200;

type StemTrack = {
  name: string;
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

function formatClock(seconds: number): string {
  const mins = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}`;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [isDropActive, setIsDropActive] = useState(false);
  const [splitGuitarMode, setSplitGuitarMode] = useState(false);
  const [masterVolume, setMasterVolume] = useState(1);
  const [stemVolumeByStem, setStemVolumeByStem] = useState<Record<string, number>>({});
  const [stems, setStems] = useState<StemTrack[]>([]);
  const [downloadZip, setDownloadZip] = useState<{ url: string; fileName: string } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [separationProgress, setSeparationProgress] = useState(0);
  const [mutedByStem, setMutedByStem] = useState<Record<string, boolean>>({});
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
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
    stems.forEach((stem) => {
      const audio = audioRefs.current[stem.name];
      if (audio) {
        const stemVolume = stemVolumeByStem[stem.name] ?? 1;
        audio.volume = Math.max(0, Math.min(1, masterVolume * stemVolume));
      }
    });
  }, [masterVolume, stemVolumeByStem, stems]);

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
    setMutedByStem({});
    setStemVolumeByStem({});
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

  function handleDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDropActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDropActive(false);
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDropActive(false);

    const droppedFile = event.dataTransfer.files?.[0];
    if (!droppedFile) {
      return;
    }

    if (!droppedFile.type.startsWith("audio/")) {
      setStatus({ type: "error", message: "Please drop a valid audio file." });
      return;
    }

    setFile(droppedFile);
    setStatus({ type: "idle", message: `Ready to split: ${droppedFile.name}` });
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

  function toggleStemMute(stemName: string) {
    setMutedByStem((previous) => ({
      ...previous,
      [stemName]: !Boolean(previous[stemName]),
    }));
  }

  function setStemVolume(stemName: string, volume: number) {
    setStemVolumeByStem((previous) => ({
      ...previous,
      [stemName]: Math.max(0, Math.min(1, volume)),
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
      formData.append("splitGuitar", splitGuitarMode ? "true" : "false");

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

      setStatus({ type: "working", message: "Downloading and preparing stems in the playlist." });
      const zipResponse = await fetch(result.downloadUrl, { cache: "no-store" });

      if (!zipResponse.ok) {
        const errorData = (await zipResponse.json().catch(() => null)) as { error?: string } | null;
        const errorMessage = errorData?.error ?? `HTTP ${zipResponse.status}`;
        throw new Error(`Failed to download ZIP: ${errorMessage}`);
      }

      const zipBlob = await zipResponse.blob();
      const zip = await JSZip.loadAsync(zipBlob);
      const extractedStems: StemTrack[] = [];

      const stemMp3Files = Object.values(zip.files)
        .filter((fileEntry) => !fileEntry.dir && fileEntry.name.toLowerCase().endsWith(".mp3"))
        .sort((a, b) => {
          const aStem = a.name.replace(/\.mp3$/i, "").toLowerCase();
          const bStem = b.name.replace(/\.mp3$/i, "").toLowerCase();
          const aIndex = STEM_ORDER.indexOf(aStem as (typeof STEM_ORDER)[number]);
          const bIndex = STEM_ORDER.indexOf(bStem as (typeof STEM_ORDER)[number]);

          if (aIndex === -1 && bIndex === -1) {
            return aStem.localeCompare(bStem);
          }

          if (aIndex === -1) {
            return 1;
          }

          if (bIndex === -1) {
            return -1;
          }

          return aIndex - bIndex;
        });

      for (const stemFile of stemMp3Files) {
        const stemBlob = await stemFile.async("blob");
        extractedStems.push({
          name: stemFile.name.replace(/\.mp3$/i, "").toLowerCase(),
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
      setMutedByStem(
        extractedStems.reduce<Record<string, boolean>>((accumulator, stem) => {
          accumulator[stem.name] = false;
          return accumulator;
        }, {}),
      );
      setStemVolumeByStem(
        extractedStems.reduce<Record<string, number>>((accumulator, stem) => {
          accumulator[stem.name] = 1;
          return accumulator;
        }, {}),
      );
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
  const timelineDuration = Math.max(playbackDuration, 1);
  const playheadPercent = Math.min(100, (playbackPosition / timelineDuration) * 100);
  const rulerTicks = Array.from({ length: 9 }, (_, index) => (timelineDuration / 8) * index);

  return (
    <main className="daw-shell mx-auto min-h-screen w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
      <section className="console-frame fade-in rounded-3xl p-4 sm:p-6 lg:p-7">
        <div className="space-y-4">
          <header className="console-header rounded-2xl border px-4 py-4 sm:px-5">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-(--accent)">
              Audio Splitter DAW
            </p>
            <h1 className="text-2xl font-bold tracking-tight sm:text-4xl">Stem Separation Console</h1>
            <p className="mt-2 max-w-3xl text-sm text-(--ink-dim) sm:text-base">
              Render multi-stems with Demucs and audition each separated track in a playlist-style arrangement.
            </p>
          </header>

          <form onSubmit={handleSubmit} className="daw-panel rounded-2xl border p-4 sm:p-5">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label
                className={`block rounded-xl border border-dashed border-(--line) bg-(--surface-hi) p-4 transition ${
                  isDropActive ? "drop-active" : ""
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <span className="mb-2 block text-sm font-semibold">Source Audio</span>
                <span className="mb-3 block text-xs text-(--ink-dim)">
                  Drag and drop audio here, or select a file manually.
                </span>
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

            <label className="mt-4 flex items-start gap-3 rounded-lg border border-(--line) bg-(--surface-hi) px-3 py-2.5 text-sm">
              <input
                type="checkbox"
                checked={splitGuitarMode}
                onChange={(event) => setSplitGuitarMode(event.currentTarget.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
              />
              <span>
                Experimental: split guitar into <strong>rhythm_guitar</strong> and <strong>lead_guitar</strong>
                (heuristic, quality varies by song).
              </span>
            </label>

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

            <label className="mb-4 block">
              <span className="mb-2 flex items-center justify-between text-xs font-mono text-(--ink-dim)">
                <span>Master Volume</span>
                <span>{Math.round(masterVolume * 100)}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={masterVolume}
                onChange={(event) => setMasterVolume(Number(event.currentTarget.value))}
                className="timeline-slider w-full"
                aria-label="Master volume"
              />
            </label>

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
                max={timelineDuration}
                step={0.01}
                value={Math.min(playbackPosition, timelineDuration)}
                onChange={(event) => setSyncedPosition(Number(event.currentTarget.value))}
                className="timeline-slider w-full"
              />
            </label>
          </section>

          <section className="daw-panel rounded-2xl border p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-(--accent)">Playlist</p>
                <h2 className="text-xl font-semibold">Arrangement Tracks</h2>
              </div>
              <div className="flex items-center gap-3">
                {downloadZip && (
                  <a
                    href={downloadZip.url}
                    download={downloadZip.fileName}
                    className="transport-chip rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em]"
                  >
                    Download ZIP
                  </a>
                )}
                <p className="text-xs font-mono text-(--ink-dim)">
                  Playhead {formatClock(playbackPosition)} / {formatClock(timelineDuration)}
                </p>
              </div>
            </div>

            {stems.length === 0 ? (
              <div className="rounded-xl border border-(--line) bg-(--surface-hi) p-4 text-sm text-(--ink-dim)">
                Once stems finish rendering, each one appears as its own playlist track lane.
              </div>
            ) : (
              <div className="playlist-shell overflow-x-auto rounded-xl border border-(--line)">
                <div className="playlist-stage min-w-[640px]">
                  <div className="ruler-row">
                    <div className="lane-label lane-label-head">Track</div>
                    <div className="ruler-main">
                      <div className="ruler-grid" style={{ gridTemplateColumns: `repeat(${rulerTicks.length}, minmax(0, 1fr))` }}>
                        {rulerTicks.map((tick, index) => (
                          <span key={`tick-${index}`} className="ruler-tick">
                            {formatClock(tick)}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="playlist-body">
                    <div
                      className="playhead"
                      style={{ left: `calc(var(--lane-label-width) + ${playheadPercent} * (100% - var(--lane-label-width)) / 100)` }}
                      aria-hidden="true"
                    />

                    {stems.map((stem) => {
                      const isMuted = mutedByStem[stem.name];
                      const stemVolume = stemVolumeByStem[stem.name] ?? 1;
                      return (
                        <div key={`${stem.name}-lane`} className="track-row">
                          <div className="lane-label">
                            <div className="lane-head">
                              <p className="text-sm font-semibold capitalize">{stem.name}</p>
                              <button
                                type="button"
                                onClick={() => toggleStemMute(stem.name)}
                                className={`lane-mute-btn ${isMuted ? "lane-mute-off" : "lane-mute-on"}`}
                              >
                                {isMuted ? "Unmute" : "Mute"}
                              </button>
                            </div>
                            <p className="text-xs text-(--ink-dim)">{isMuted ? "Muted" : "Active"}</p>
                            <label className="mt-2 block">
                              <span className="mb-1 flex items-center justify-between text-[11px] font-mono text-(--ink-dim)">
                                <span>Stem Vol</span>
                                <span>{Math.round(stemVolume * 100)}%</span>
                              </span>
                              <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.01}
                                value={stemVolume}
                                onChange={(event) => setStemVolume(stem.name, Number(event.currentTarget.value))}
                                className="timeline-slider w-full"
                                aria-label={`${stem.name} volume`}
                              />
                            </label>
                          </div>

                          <div className="track-main">
                            <div className={`clip-block ${isMuted ? "clip-muted" : ""}`}>
                              <div className="clip-title">{stem.name}.mp3</div>
                              <div className="clip-wave" aria-hidden="true">
                                {Array.from({ length: 56 }, (_, barIndex) => {
                                  const height = 18 + Math.round(Math.abs(Math.sin((barIndex + 1) * 0.42)) * 72);
                                  return <span key={`${stem.name}-bar-${barIndex}`} style={{ height: `${height}%` }} />;
                                })}
                              </div>
                            </div>

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
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
