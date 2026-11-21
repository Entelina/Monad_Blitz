import { NextResponse } from "next/server";
import { refundDemoTaskOnchain } from "@/lib/verifier";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const taskId = body.taskId as `0x${string}`;
    if (!taskId || !taskId.startsWith("0x") || taskId.length !== 66) {
      return NextResponse.json({ error: "Invalid taskId" }, { status: 400 });
    }
    const res = await refundDemoTaskOnchain(taskId);
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
