const DEFAULT_MODEL = "codellama";

export interface GenerateOptions {
  baseUrl: string;
  model: string;
  prompt: string;
  stream?: boolean;
  signal?: AbortSignal;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    public readonly causeHttpStatus?: number
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

export interface TagsResponse {
  models?: Array<{ name?: string }>;
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

export async function listModelNames(baseUrl: string): Promise<string[]> {
  const url = `${normalizeBase(baseUrl)}/api/tags`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("fetch failed") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOTFOUND")
    ) {
      throw new OllamaError(
        "No se pudo conectar con Ollama. Revisa host y puerto en Ajustes → Huemul."
      );
    }
    throw new OllamaError(`Error de red: ${msg}`);
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) {
        detail = j.error;
      }
    } catch {
      /* ignore */
    }
    throw new OllamaError(
      `Ollama respondió ${res.status}: ${detail}`,
      res.status
    );
  }

  const data = (await res.json()) as TagsResponse;
  const names = (data.models ?? [])
    .map((m) => (typeof m.name === "string" ? m.name : ""))
    .filter((n) => n.length > 0);
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

export async function generateText(options: GenerateOptions): Promise<string> {
  const url = `${normalizeBase(options.baseUrl)}/api/generate`;
  const body = {
    model: options.model || DEFAULT_MODEL,
    prompt: options.prompt,
    stream: false,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : String(e);
    if (
      msg.includes("fetch failed") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOTFOUND")
    ) {
      throw new OllamaError(
        "No se pudo conectar con Ollama. Revisa host, puerto y que el servicio esté en marcha (Ajustes → Huemul)."
      );
    }
    throw new OllamaError(`Error de red: ${msg}`);
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) {
        detail = j.error;
      }
    } catch {
      /* ignore */
    }
    throw new OllamaError(
      `Ollama respondió ${res.status}: ${detail}`,
      res.status
    );
  }

  const data = (await res.json()) as { response?: string; error?: string };
  if (data.error) {
    throw new OllamaError(data.error);
  }
  if (typeof data.response !== "string") {
    throw new OllamaError("Respuesta inesperada de Ollama (sin campo response).");
  }
  return data.response;
}

export async function generateStream(
  options: GenerateOptions,
  onToken: (chunk: string) => void
): Promise<void> {
  const url = `${normalizeBase(options.baseUrl)}/api/generate`;
  const body = {
    model: options.model || DEFAULT_MODEL,
    prompt: options.prompt,
    stream: true,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("fetch failed") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOTFOUND")
    ) {
      throw new OllamaError(
        "No se pudo conectar con Ollama. Revisa host, puerto y que el servicio esté en marcha (Ajustes → Huemul)."
      );
    }
    throw new OllamaError(`Error de red: ${msg}`);
  }

  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) {
        detail = j.error;
      }
    } catch {
      /* ignore */
    }
    throw new OllamaError(
      `Ollama respondió ${res.status}: ${detail}`,
      res.status
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushLine = (trimmed: string): void => {
    if (!trimmed) {
      return;
    }
    try {
      const obj = JSON.parse(trimmed) as {
        response?: string;
        error?: string;
      };
      if (obj.error) {
        throw new OllamaError(obj.error);
      }
      if (typeof obj.response === "string" && obj.response.length > 0) {
        onToken(obj.response);
      }
    } catch (e) {
      if (e instanceof OllamaError) {
        throw e;
      }
      /* línea incompleta o basura: ignorar */
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail) {
        flushLine(tail);
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      flushLine(line.trim());
    }
  }
}
