// The one place that knows where the API lives and what its responses look
// like. Every screen goes through here, so the error envelope is parsed once.

// Baked in at build time by Vite. The production URL is never committed: the
// local default lives in client/.env.example and the deploy supplies its own.
const BASE_URL = import.meta.env.VITE_API_BASE_URL;

if (!BASE_URL) {
  // Failing at module load is deliberate. A bundle built without this variable
  // would otherwise fall back to the page's own origin and 404 every call,
  // which looks like a routing bug rather than a build misconfiguration.
  throw new Error('VITE_API_BASE_URL is not set. See client/.env.example.');
}

// The session is an httpOnly cookie, which a browser attaches to cross-site
// requests on its own. It cannot attach a custom header without a preflight
// the attacker's origin fails, so this header is what proves a state-changing
// request came from our own code. The server requires it on cookie-
// authenticated writes.
const CSRF_HEADER = 'X-Requested-With';
const CSRF_VALUE = 'show-rush';

// Carries the server's stable error code. Screens branch on `code`; `message`
// is for humans and may change without notice.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers[CSRF_HEADER] = CSRF_VALUE;

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      // Without this the session cookie is never sent and every authenticated
      // call 401s. It is also what makes CORS require an exact origin on the
      // server rather than a wildcard.
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // A CORS rejection and an unreachable server are indistinguishable here —
    // the browser deliberately tells scripts nothing about either.
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server');
  }

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'UNKNOWN',
      payload?.error?.message ?? 'Request failed',
    );
  }

  return payload;
}
