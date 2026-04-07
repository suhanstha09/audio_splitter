"use client";

import JSZip from "jszip";
import { CSSProperties, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";

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
const DEFAULT_WAVE_BARS = 72;

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

function buildFallbackWaveformBars(barCount: number): number[] {
  return Array.from({ length: barCount }, (_, index) =>
    18 + Math.round(Math.abs(Math.sin((index + 2) * 0.44)) * 68),
  );
}

async function extractWaveformBars(audioBytes: ArrayBuffer, barCount: number): Promise<number[]> {
  if (typeof window === "undefined") {
    return buildFallbackWaveformBars(barCount);
  }

  const audioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!audioContextCtor) {
    return buildFallbackWaveformBars(barCount);
  }

  const audioContext = new audioContextCtor();

  try {
    const decoded = await audioContext.decodeAudioData(audioBytes.slice(0));
    const channels = decoded.numberOfChannels;
    if (channels === 0 || decoded.length === 0) {
      return buildFallbackWaveformBars(barCount);
    }

    const aggregate = new Float32Array(decoded.length);
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const data = decoded.getChannelData(channelIndex);
      for (let sampleIndex = 0; sampleIndex < data.length; sampleIndex += 1) {
        aggregate[sampleIndex] += Math.abs(data[sampleIndex]);
      }
    }

    for (let sampleIndex = 0; sampleIndex < aggregate.length; sampleIndex += 1) {
      aggregate[sampleIndex] /= channels;
    }

    const samplesPerBar = Math.max(1, Math.floor(aggregate.length / barCount));
    const bars: number[] = [];
    let maxValue = 0;

    for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
      const start = barIndex * samplesPerBar;
      const end = Math.min(aggregate.length, start + samplesPerBar);
      let sum = 0;

      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        sum += aggregate[sampleIndex];
      }

      const avg = end > start ? sum / (end - start) : 0;
      bars.push(avg);
      if (avg > maxValue) {
        maxValue = avg;
      }
    }

    if (maxValue <= 0.0001) {
      return buildFallbackWaveformBars(barCount);
    }

    return bars.map((value) => {
      const normalized = value / maxValue;
      return Math.max(10, Math.min(100, Math.round(normalized * 100)));
    });
  } catch {
    return buildFallbackWaveformBars(barCount);
  } finally {
    void audioContext.close();
  }
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
  const [soloByStem, setSoloByStem] = useState<Record<string, boolean>>({});
  const [armedByStem, setArmedByStem] = useState<Record<string, boolean>>({});
  const [waveformByStem, setWaveformByStem] = useState<Record<string, number[]>>({});
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
    const hasSolo = Object.values(soloByStem).some(Boolean);

    stems.forEach((stem) => {
      const audio = audioRefs.current[stem.name];
      if (audio) {
        const isMuted = Boolean(mutedByStem[stem.name]);
        const isSoloed = Boolean(soloByStem[stem.name]);
        audio.muted = isMuted || (hasSolo && !isSoloed);
      }
    });
  }, [mutedByStem, soloByStem, stems]);

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
    setSoloByStem({});
    setArmedByStem({});
    setStemVolumeByStem({});
    setWaveformByStem({});
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

  function toggleStemSolo(stemName: string) {
    setSoloByStem((previous) => ({
      ...previous,
      [stemName]: !Boolean(previous[stemName]),
    }));
  }

  function toggleStemArm(stemName: string) {
    setArmedByStem((previous) => ({
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

  function rewindFiveSeconds() {
    const firstAudio = stems
      .map((stem) => audioRefs.current[stem.name])
      .find((audio): audio is HTMLAudioElement => Boolean(audio));
    const nextPosition = firstAudio ? Math.max(0, firstAudio.currentTime - 5) : 0;
    setSyncedPosition(nextPosition);
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
      const extractedWaveforms: Record<string, number[]> = {};

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
        const stemName = stemFile.name.replace(/\.mp3$/i, "").toLowerCase();
        const stemBytes = await stemBlob.arrayBuffer();

        extractedWaveforms[stemName] = await extractWaveformBars(stemBytes, DEFAULT_WAVE_BARS);
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
      setMutedByStem(
        extractedStems.reduce<Record<string, boolean>>((accumulator, stem) => {
          accumulator[stem.name] = false;
          return accumulator;
        }, {}),
      );
      setSoloByStem(
        extractedStems.reduce<Record<string, boolean>>((accumulator, stem) => {
          accumulator[stem.name] = false;
          return accumulator;
        }, {}),
      );
      setArmedByStem(
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
      setWaveformByStem(extractedWaveforms);
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
  const hasSolo = Object.values(soloByStem).some(Boolean);
  const progressLabel = `${clampPercent(separationProgress)}%`;
  const timelineDuration = Math.max(playbackDuration, 1);
  const playheadPercent = Math.min(100, (playbackPosition / timelineDuration) * 100);
  const rulerTicks = Array.from({ length: 9 }, (_, index) => (timelineDuration / 8) * index);

  function meterLevelForStem(stemName: string, stemVolume: number): number {
    if (!isPlaying) {
      return 0;
    }

    const waveformBars = waveformByStem[stemName];
    if (!waveformBars || waveformBars.length === 0) {
      return Math.round(stemVolume * 24);
    }

    const barIndex = Math.min(
      waveformBars.length - 1,
      Math.max(0, Math.floor((playbackPosition / timelineDuration) * waveformBars.length)),
    );
    return Math.round(waveformBars[barIndex] * stemVolume);
  }

  return (
    <main className="daw-shell min-h-screen w-full px-0 py-0">
      <section className="console-frame fl-frame fade-in min-h-screen w-full rounded-none p-3 sm:p-4">
        <header className="studio-menu-bar">
          <div className="studio-menu-left">
            <span className="studio-logo-dot" aria-hidden="true" />
            <span className="studio-title">Playlist</span>
            <nav className="studio-menu-items" aria-label="Main menu">
              <button type="button">File</button>
              <button type="button">Edit</button>
              <button type="button">Add</button>
              <button type="button">Tools</button>
              <button type="button">View</button>
            </nav>
          </div>
          <div className="studio-menu-right">
            <button
              type="button"
              onClick={togglePlayAll}
              className="studio-transport-btn"
              disabled={stems.length === 0}
            >
              {isPlaying ? "Pause" : "Play"}
            </button>
            <button
              type="button"
              onClick={rewindFiveSeconds}
              className="studio-transport-btn"
              disabled={stems.length === 0}
            >
              -5s
            </button>
            <button
              type="button"
              onClick={() => setSyncedPosition(0)}
              className="studio-transport-btn"
              disabled={stems.length === 0}
            >
              Start
            </button>
            <span className="studio-time-chip">
              {formatClock(playbackPosition)} / {formatClock(timelineDuration)}
            </span>
            <span className="studio-chip">Song</span>
            <span className="studio-chip">120 BPM</span>
            <span className="studio-chip">4/4</span>
          </div>
        </header>

        {isWorking && (
          <div className="render-popup" role="status" aria-live="polite">
            <div className="flex items-center justify-between text-xs font-mono text-(--ink-dim)">
              <span>Rendering Stems</span>
              <span>{progressLabel}</span>
            </div>
            <div className="progress-track mt-2 h-2 w-full overflow-hidden rounded-full">
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
            <p className="mt-2 text-xs text-(--ink-dim)">{status.message}</p>
          </div>
        )}

        <div className="fl-workspace mt-0">
          <aside className="fl-sidebar space-y-3">
            <form onSubmit={handleSubmit} className="daw-panel fl-card browser-panel rounded-2xl border p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-(--accent)">Browser</p>
              <label
                className={`block rounded-xl border border-dashed border-(--line) bg-(--surface-hi) p-3 transition ${
                  isDropActive ? "drop-active" : ""
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <span className="mb-2 block text-xs text-(--ink-dim)">Drop source audio</span>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
                  className="daw-input block w-full rounded-lg px-2.5 py-2 text-sm"
                />
                <span className="mt-2 block text-[11px] font-mono text-(--ink-dim)">{file ? file.name : "no file selected"}</span>
              </label>

              <button
                type="submit"
                disabled={!file || isWorking}
                className="transport-button mt-3 w-full rounded-xl px-4 py-2.5 text-sm font-semibold uppercase tracking-[0.14em] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isWorking ? "Rendering..." : "Render Stems"}
              </button>

              <label className="mt-3 flex items-start gap-2.5 rounded-lg border border-(--line) bg-(--surface-hi) px-2.5 py-2 text-xs">
                <input
                  type="checkbox"
                  checked={splitGuitarMode}
                  onChange={(event) => setSplitGuitarMode(event.currentTarget.checked)}
                  className="mt-0.5 h-4 w-4 accent-(--accent)"
                />
                <span>Split guitar into rhythm and lead (experimental).</span>
              </label>

              <p
                className={`mt-3 rounded-lg border px-2.5 py-2 text-xs ${
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

            <section className="daw-panel fl-card rounded-2xl border p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-(--accent)">Mixer</p>
              <label className="mb-3 block">
                <span className="mb-1.5 flex items-center justify-between text-[11px] font-mono text-(--ink-dim)">
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
                <span className="mb-1.5 flex items-center justify-between text-[11px] font-mono text-(--ink-dim)">
                  <span>{formatClock(playbackPosition)}</span>
                  <span>{formatClock(playbackDuration)}</span>
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

              {downloadZip && (
                <a
                  href={downloadZip.url}
                  download={downloadZip.fileName}
                  className="transport-chip mt-3 block rounded-lg px-3 py-2 text-center text-xs font-semibold uppercase tracking-[0.08em]"
                >
                  Download ZIP
                </a>
              )}
            </section>
          </aside>

          <section className="daw-panel fl-arrangement rounded-2xl border p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-(--accent)">Arrangement</p>
                <h2 className="text-base font-semibold sm:text-lg">Track Playlist</h2>
              </div>
              <p className="text-[11px] font-mono text-(--ink-dim)">{availableStemNames.length} tracks loaded</p>
            </div>

            {stems.length === 0 ? (
              <div className="playlist-shell overflow-x-auto rounded-xl border border-(--line)">
                <div className="playlist-stage min-w-195">
                  <div className="ruler-row">
                    <div className="lane-label lane-label-head">Track</div>
                    <div className="ruler-main">
                      <div className="ruler-grid" style={{ gridTemplateColumns: `repeat(${rulerTicks.length}, minmax(0, 1fr))` }}>
                        {rulerTicks.map((tick, index) => (
                          <span key={`demo-tick-${index}`} className="ruler-tick">
                            {formatClock(tick)}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="playlist-body">
                    <div className="track-row empty-track-row">
                      <div className="lane-label">
                        <p className="text-sm font-semibold">No Tracks</p>
                        <p className="text-xs text-(--ink-dim)">Render stems to populate playlist lanes.</p>
                      </div>
                      <div className="track-main empty-track-main">
                        <p className="text-sm text-(--ink-dim)">Waveforms will appear here after stem generation.</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="playlist-shell overflow-x-auto rounded-xl border border-(--line)">
                <div className="playlist-stage min-w-195">
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

                    {stems.map((stem, index) => {
                      const isMuted = Boolean(mutedByStem[stem.name]);
                      const isSoloed = Boolean(soloByStem[stem.name]);
                      const isArmed = Boolean(armedByStem[stem.name]);
                      const isEffectivelyMuted = isMuted || (hasSolo && !isSoloed);
                      const stemVolume = stemVolumeByStem[stem.name] ?? 1;
                      const waveformBars = waveformByStem[stem.name] ?? buildFallbackWaveformBars(DEFAULT_WAVE_BARS);
                      const meterLevel = meterLevelForStem(stem.name, stemVolume);
                      const laneStyle = {
                        "--clip-hue": `${(index * 44 + 28) % 360}`,
                      } as CSSProperties;

                      return (
                        <div key={`${stem.name}-lane`} className="track-row" style={laneStyle}>
                          <div className="lane-label">
                            <div className="lane-head">
                              <span className="lane-color" aria-hidden="true" />
                              <p className="text-sm font-semibold capitalize">{stem.name}</p>
                            </div>

                            <div className="lane-controls">
                              <button
                                type="button"
                                onClick={() => toggleStemArm(stem.name)}
                                className={`lane-mode-btn ${isArmed ? "lane-mode-on" : "lane-mode-off"}`}
                              >
                                Arm
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleStemSolo(stem.name)}
                                className={`lane-mode-btn ${isSoloed ? "lane-mode-on" : "lane-mode-off"}`}
                              >
                                Solo
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleStemMute(stem.name)}
                                className={`lane-mode-btn ${isMuted ? "lane-mode-on" : "lane-mode-off"}`}
                              >
                                Mute
                              </button>
                              <div className="lane-meter" aria-label={`${stem.name} output meter`}>
                                {Array.from({ length: 12 }, (_, meterIndex) => {
                                  const threshold = ((meterIndex + 1) / 12) * 100;
                                  return (
                                    <span
                                      key={`${stem.name}-meter-${meterIndex}`}
                                      className={meterLevel >= threshold ? "lane-meter-on" : "lane-meter-off"}
                                    />
                                  );
                                })}
                              </div>
                            </div>

                            <p className="text-xs text-(--ink-dim)">{isEffectivelyMuted ? "Muted" : "Active"}</p>
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
                            <div className={`clip-block ${isEffectivelyMuted ? "clip-muted" : ""}`}>
                              <div className="clip-title">{stem.name}.mp3</div>
                              <div
                                className="clip-wave"
                                style={{ gridTemplateColumns: `repeat(${waveformBars.length}, minmax(0, 1fr))` }}
                                aria-hidden="true"
                              >
                                {waveformBars.map((height, barIndex) => (
                                  <span
                                    key={`${stem.name}-bar-${barIndex}`}
                                    style={{ ["--wave-height" as string]: `${height}%` } as CSSProperties}
                                  />
                                ))}
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
