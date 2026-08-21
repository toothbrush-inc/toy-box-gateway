// Google as the identity check inside authorize(): build the login URL,
// exchange the callback code server-side, and extract the verified email
// from the id_token. The id_token arrives directly from Google over TLS, so
// payload parsing (without local signature verification) is sufficient.

export interface GoogleLoginCreds {
  clientId: string;
  clientSecret: string;
}

export interface GoogleEndpoints {
  authUrl: string;
  tokenUrl: string;
}

export const DEFAULT_GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
};

export function googleLoginUrl(
  endpoints: GoogleEndpoints,
  creds: GoogleLoginCreds,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(endpoints.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeGoogleCode(
  endpoints: GoogleEndpoints,
  creds: GoogleLoginCreds,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ email: string; emailVerified: boolean }> {
  const response = await fetchImpl(endpoints.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    cache: "no-store",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`google login exchange failed (HTTP ${String(response.status)})`);
  }
  const payload = (await response.json()) as { id_token?: unknown };
  if (typeof payload.id_token !== "string") {
    throw new Error("google login exchange returned no id_token");
  }
  const segments = payload.id_token.split(".");
  let claims: { email?: unknown; email_verified?: unknown } = {};
  try {
    claims = JSON.parse(Buffer.from(segments[1] ?? "", "base64url").toString("utf8")) as typeof claims;
  } catch {
    throw new Error("google id_token payload is unreadable");
  }
  if (typeof claims.email !== "string" || claims.email === "") {
    throw new Error("google id_token carries no email");
  }
  return { email: claims.email.toLowerCase(), emailVerified: claims.email_verified === true };
}
