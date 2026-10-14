/** Server-side access to the Hub: its address and the token the console adds to every call. */

export const HUB_URL = `http://127.0.0.1:${process.env.ASO_HUB_PORT ?? "7420"}`;

export function hubHeaders(json = false): Record<string, string> {
  const token = process.env.ASO_TOKEN;
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) };
}

/** Use up a one-time sign-in code at the Hub. False when it is unknown, used or expired. */
export async function redeemSignInCode(code: string): Promise<boolean> {
  try {
    const res = await fetch(`${HUB_URL}/api/sign-in-codes/redeem`, {
      method: "POST",
      headers: hubHeaders(true),
      body: JSON.stringify({ code }),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}
