import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getSplitJob } from "../../jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: {
    params: Promise<{ jobId: string }>;
  },
) {
  const { jobId } = await context.params;
  const job = getSplitJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Split job was not found or has expired." }, { status: 404 });
  }

  if (job.status !== "completed") {
    return NextResponse.json({ error: "Split job is not completed yet." }, { status: 409 });
  }

  if (!job.zipPath) {
    return NextResponse.json({ error: "Split job has no zip file associated." }, { status: 409 });
  }

  if (!existsSync(job.zipPath)) {
    return NextResponse.json(
      { error: "ZIP file not found on disk. It may have been cleaned up." },
      { status: 410 },
    );
  }

  try {
    // Verify the file is readable and get its size
    const stats = await stat(job.zipPath);
    if (stats.size === 0) {
      return NextResponse.json({ error: "ZIP file is empty." }, { status: 409 });
    }

    const zipBytes = new Uint8Array(await readFile(job.zipPath));

    return new NextResponse(zipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${job.zipFileName ?? "stems.zip"}"`,
        "Cache-Control": "no-store",
        "Content-Length": zipBytes.length.toString(),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to read ZIP file: ${detail}` },
      { status: 500 },
    );
  }
}