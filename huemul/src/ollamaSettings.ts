import * as vscode from "vscode";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 11434;

/** URL base normalizada, p. ej. http://127.0.0.1:11434 */
export function getOllamaBaseUrl(): string {
  const conf = vscode.workspace.getConfiguration("huemul");
  let host = String(conf.get("ollamaHost") ?? DEFAULT_HOST).trim();
  if (!host) {
    host = DEFAULT_HOST;
  }
  host = stripHostFromUrl(host);

  let port = Number(conf.get("ollamaPort"));
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    port = DEFAULT_PORT;
  }
  port = Math.floor(port);

  return `http://${host}:${port}`;
}

function stripHostFromUrl(host: string): string {
  const h = host.replace(/^https?:\/\//i, "");
  const noPath = h.split("/")[0] ?? h;
  const noPort = noPath.includes("]") ? noPath : noPath.split(":")[0];
  return noPort || DEFAULT_HOST;
}
