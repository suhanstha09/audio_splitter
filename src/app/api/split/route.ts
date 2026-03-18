import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import JSZip from "jszip";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_SEGMENT_SECONDS = 5;
const MAX_SEGMENT_SECONDS = 60 * 30;

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

function clampSegmentSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return 30;
  }

  return Math.min(MAX_SEGMENT_SECONDS, Math.max(MIN_SEGMENT_SECONDS, Math.floor(value)));
}

function splitAudio(inputPath: string, outputPattern: string, segmentSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("192k")
      .outputOptions([
        "-f segment",
        `-segment_time ${segmentSeconds}`,
        "-reset_timestamps 1",
      ])
      .output(outputPattern)
      .on("end", () => resolve())
      .on("error", (error) => reject(error))
      .run();
  });
}

function sanitizeFileStem(fileName: string): string {
  const stem = path.parse(fileName).name.trim();
  const cleaned = stem.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "audio";
}

export async function POST(request: Request) {
  let tempDirPath = "";

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const segmentSecondsRaw = formData.get("segmentSeconds");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Please upload an audio file." }, { status: 400 });
    }

    const segmentSeconds = clampSegmentSeconds(Number(segmentSecondsRaw));
    tempDirPath = await mkdtemp(path.join(tmpdir(), "audio-splitter-"));

    const inputFileName = `${randomUUID()}-${file.name || "input"}`;
    const inputPath = path.join(tempDirPath, inputFileName);
    const chunksDirPath = path.join(tempDirPath, "chunks");
    const outputPattern = path.join(chunksDirPath, "chunk-%03d.mp3");

    await mkdir(chunksDirPath, { recursive: true });
    await writeFile(inputPath, Buffer.from(await file.arrayBuffer()));
    await splitAudio(inputPath, outputPattern, segmentSeconds);

    const allFiles = await readdir(chunksDirPath);
    const chunkFiles = allFiles.filter((name) => name.endsWith(".mp3")).sort();

    if (chunkFiles.length === 0) {
      return NextResponse.json(
        { error: "No audio chunks were created. Try a different file." },
        { status: 500 },
      );
    }

    const zip = new JSZip();

    for (const chunkFileName of chunkFiles) {
      const chunkPath = path.join(chunksDirPath, chunkFileName);
      const chunkBuffer = await readFile(chunkPath);
      zip.file(chunkFileName, chunkBuffer);
    }

    zip.file(
      "manifest.json",
      JSON.stringify(
        {
          originalFileName: file.name,
          segmentSeconds,
          chunkCount: chunkFiles.length,
          chunks: chunkFiles,
        },
        null,
        2,
      ),
    );

    const zipBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    const zipBytes = new Uint8Array(zipBuffer);

    const outputBaseName = sanitizeFileStem(file.name || "audio");
    const zipFileName = `${outputBaseName}-chunks.zip`;

    return new NextResponse(zipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipFileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      {
        error: "Audio split failed. Please confirm the uploaded file is valid audio.",
        detail,
      },
      { status: 500 },
    );
  } finally {
    if (tempDirPath) {
      await rm(tempDirPath, { recursive: true, force: true });
    }
  }
}