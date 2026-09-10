import {NextResponse} from "next/server";
import {cookies} from "next/headers";
import {SESSION_COOKIE, decodeSession} from "@/lib/session";

/** Who, if anyone, is signed in on this browser. */
export async function GET() {
  const jar = await cookies();
  const session = decodeSession(jar.get(SESSION_COOKIE)?.value);
  return NextResponse.json({session: session ?? null});
}
