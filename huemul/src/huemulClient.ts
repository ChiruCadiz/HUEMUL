// ── Constantes ─────────────────────────────────────────────────
const DEFAULT_BACKEND_URL = "http://localhost:8000";

// ── Error personalizado ────────────────────────────────────────
export class HuemulError extends Error {
  constructor(
    message: string,
    public readonly causeHttpStatus?: number
  ) {
    super(message);
    this.name = "HuemulError";
  }
}

// ── Interfaces ─────────────────────────────────────────────────
export interface LoginResponse {
  access_token: string;
  role: string;
  email: string;
}

export interface SessionResponse {
  id: string;
  title: string | null;
  model_used: string;
  is_active: boolean;
  created_at: string;
  last_active_at: string;
}

export interface StreamOptions {
  backendUrl: string;
  token: string;
  sessionId: string;
  message: string;
  model: string;
  mode: string;
  files?: Array<{ filename: string; content: string }>;
  signal?: AbortSignal;
}

// ── Helpers ────────────────────────────────────────────────────
function normalizeBase(url: string): string {
  return url.replace(/\/$/, "");
}

function buildHeaders(token?: string): HeadersInit {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    h["Authorization"] = `Bearer ${token}`;
  }
  return h;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j?.detail) {
        detail = j.detail;
      }
    } catch {
      /* ignore */
    }
    throw new HuemulError(
      `El backend respondió ${res.status}: ${detail}`,
      res.status
    );
  }
  return res.json() as Promise<T>;
}

function wrapNetworkError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND")
  ) {
    throw new HuemulError(
      "No se pudo conectar con el backend Huemul. Verifica que esté corriendo en " +
        DEFAULT_BACKEND_URL
    );
  }
  throw new HuemulError(`Error de red: ${msg}`);
}

// ══════════════════════════════════════════════════════════════
// Auth
// ══════════════════════════════════════════════════════════════

export async function login(
  email: string,
  password: string,
  backendUrl = DEFAULT_BACKEND_URL
): Promise<LoginResponse> {
  let res: Response;
  try {
    res = await fetch(`${normalizeBase(backendUrl)}/auth/login`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    wrapNetworkError(e);
  }
  return handleResponse<LoginResponse>(res!);
}

// ══════════════════════════════════════════════════════════════
// Modelos
// ══════════════════════════════════════════════════════════════

export async function listModelNames(
  token: string,
  backendUrl = DEFAULT_BACKEND_URL
): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${normalizeBase(backendUrl)}/models`, {
      method: "GET",
      headers: buildHeaders(token),
    });
  } catch (e) {
    wrapNetworkError(e);
  }
  const data = await handleResponse<{ models: string[]; message?: string }>(
    res!
  );
  return data.models ?? [];
}

export async function getDefaultModel(
  token: string,
  backendUrl = DEFAULT_BACKEND_URL
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${normalizeBase(backendUrl)}/models/default`, {
      method: "GET",
      headers: buildHeaders(token),
    });
  } catch (e) {
    wrapNetworkError(e);
  }
  const data = await handleResponse<{ default_model: string }>(res!);
  return data.default_model ?? "";
}

// ══════════════════════════════════════════════════════════════
// Sesiones
// ══════════════════════════════════════════════════════════════

export async function listSessions(
  token: string,
  backendUrl = DEFAULT_BACKEND_URL
): Promise<SessionResponse[]> {
  let res: Response;
  try {
    res = await fetch(`${normalizeBase(backendUrl)}/sessions`, {
      method: "GET",
      headers: buildHeaders(token),
    });
  } catch (e) {
    wrapNetworkError(e);
  }
  return handleResponse<SessionResponse[]>(res!);
}

export async function createSession(
  token: string,
  model: string,
  backendUrl = DEFAULT_BACKEND_URL
): Promise<SessionResponse> {
  let res: Response;
  try {
    res = await fetch(`${normalizeBase(backendUrl)}/sessions`, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({ model }),
    });
  } catch (e) {
    wrapNetworkError(e);
  }
  return handleResponse<SessionResponse>(res!);
}

export async function deleteSession(
  token: string,
  sessionId: string,
  backendUrl = DEFAULT_BACKEND_URL
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      `${normalizeBase(backendUrl)}/sessions/${sessionId}`,
      {
        method: "DELETE",
        headers: buildHeaders(token),
      }
    );
  } catch (e) {
    wrapNetworkError(e);
  }
  await handleResponse<unknown>(res!);
}

// ══════════════════════════════════════════════════════════════
// Chat con streaming
// ══════════════════════════════════════════════════════════════

export async function chatStream(
  options: StreamOptions,
  onToken: (chunk: string) => void
): Promise<void> {
  const { backendUrl, token, sessionId, message, model, mode, signal } =
    options;

  let res: Response;
  try {
    res = await fetch(`${normalizeBase(backendUrl)}/chat/message`, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({
        session_id: sessionId,
        message,
        model,
        mode,
        files: options.files ?? [],
      }),
      signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("AbortError") || e instanceof DOMException) {
      throw e; // dejar que el AbortError suba tal cual
    }
    wrapNetworkError(e);
  }

  if (!res!.ok || !res!.body) {
    let detail = res!.statusText;
    try {
      const j = (await res!.json()) as { detail?: string };
      if (j?.detail) {
        detail = j.detail;
      }
    } catch {
      /* ignore */
    }
    throw new HuemulError(
      `El backend respondió ${res!.status}: ${detail}`,
      res!.status
    );
  }

  // Leer stream de texto plano (tokens separados sin delimitador)
  const reader = res!.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = decoder.decode(value, { stream: true });
    if (chunk) {
      onToken(chunk);
    }
  }
}