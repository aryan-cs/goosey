import { NextResponse } from "next/server";
import { db, requireDatabaseStartup } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireDatabaseStartup();
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json(
      { status: "ok", service: "goosey", database: "reachable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "error", service: "goosey", database: "unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
