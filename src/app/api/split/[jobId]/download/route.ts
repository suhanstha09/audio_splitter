import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

  if (job.status !== "completed" || !job.zipPath || !existsSync(job.zipPath)) {
    return NextResponse.json({ error: "Split job is not ready for download yet." }, { status: 409 });
  }

  const zipBytes = new Uint8Array(await readFile(job.zipPath));

  return new NextResponse(zipBytes, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${job.zipFileName ?? "stems.zip"}"`,
      "Cache-Control": "no-store",
    },
  });
}