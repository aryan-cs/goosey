import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { readWorkerReadiness } from "@/lib/worker-health";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    const readiness = await readWorkerReadiness(db);
    return NextResponse.json(
      {
        status: readiness.ready ? "ready" : "not_ready",
        service: "goosey",
        worker: readiness.worker,
        backlog: readiness.backlog,
        reasons: readiness.reasons,
        checkedAt: readiness.checkedAt,
      },
      {
        status: readiness.ready ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return NextResponse.json(
      {
        status: "not_ready",
        service: "goosey",
        reasons: [{ code: "READINESS_CHECK_FAILED", message: "Readiness dependencies could not be verified." }],
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
