import * as vscode from "vscode";
import { OllamaError } from "./ollamaClient"; // se mantiene para _postError
import {
  HuemulError,
  login,
  listModelNames,
  getDefaultModel,
  listSessions,
  createSession,
  deleteSession,
  chatStream,
  SessionResponse,
} from "./huemulClient";

const BACKEND_URL = "http://localhost:8000";

// Decodifica el payload del JWT sin verificar firma (solo lectura de claims)
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return {};
    }
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class HuemulChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "huemul.chatView";

  private _view: vscode.WebviewView | undefined;
  private _abort: AbortController | undefined;

  // ── Estado de autenticación ───────────────────────────────
  private _token: string | undefined;
  private _userRole: string = "user";
  private _userEmail: string = "";

  // ── Estado de sesión ──────────────────────────────────────
  private _activeSessionId: string | undefined;
  private _sessions: SessionResponse[] = [];

  // ── Estado de modo y modelo ───────────────────────────────
  private _activeMode: string = "analysis";
  private _activeModel: string = "";

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    this._activeSessionId =
      this._context.globalState.get<string>("huemul.activeSessionId");
    this._activeMode =
      this._context.globalState.get<string>("huemul.activeMode") ?? "analysis";
    this._activeModel =
      this._context.globalState.get<string>("huemul.activeModel") ?? "";
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView
  ): void | Thenable<void> {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {

        // ── Inicio: verificar si hay token guardado ──────────
        case "ready": {
          const saved = await this._context.secrets.get("huemul.token");
          if (saved) {
            // Verificar que el token sigue siendo válido
            try {
              const res = await fetch(`${BACKEND_URL}/models/default`, {
                headers: { Authorization: `Bearer ${saved}` },
              });
              if (res.status === 401) {
                // Token expirado — limpiar y pedir login de nuevo
                await this._context.secrets.delete("huemul.token");
                this.postToWebview({ type: "authRequired" });
                return;
              }
            } catch {
              // Backend no disponible — intentar con el token guardado
            }
            this._token = saved;
            const payload = decodeJwtPayload(saved);
            this._userRole = String(payload["role"] ?? "user");
            this._userEmail = String(payload["email"] ?? "");
            await this._onLoginSuccess();
          } else {
            this.postToWebview({ type: "authRequired" });
          }
          break;
        }

        // ── Login ────────────────────────────────────────────
        case "login": {
          const email = String(message.email ?? "").trim();
          const password = String(message.password ?? "").trim();
          if (!email || !password) {
            this.postToWebview({
              type: "loginError",
              text: "Ingresa tu correo y contraseña.",
            });
            return;
          }
          try {
            const resp = await login(email, password, BACKEND_URL);
            this._token = resp.access_token;
            this._userRole = resp.role;
            this._userEmail = resp.email;
            await this._context.secrets.store("huemul.token", resp.access_token);
            await this._onLoginSuccess();
          } catch (e) {
            const msg =
              e instanceof HuemulError
                ? e.message
                : e instanceof Error
                  ? e.message
                  : "Error desconocido";
            this.postToWebview({ type: "loginError", text: msg });
          }
          break;
        }

        // ── Logout ───────────────────────────────────────────
        case "logout": {
          await this._context.secrets.delete("huemul.token");
          this._token = undefined;
          this._activeSessionId = undefined;
          this._sessions = [];
          await this._context.globalState.update(
            "huemul.activeSessionId",
            undefined
          );
          this.postToWebview({ type: "authRequired" });
          break;
        }

        // ── Actualizar modelos ───────────────────────────────
        case "refreshModels": {
          await this._pushModelsToWebview();
          break;
        }

        // ── Ajustes ──────────────────────────────────────────
        case "openSettings": {
          await vscode.commands.executeCommand("huemul.openSettings");
          break;
        }

        // ── Nueva sesión ─────────────────────────────────────
        case "newSession": {
          if (!this._token) {
            return;
          }
          try {
            const model = this._activeModel || "gemma4:26b";
            const session = await createSession(
              this._token,
              model,
              BACKEND_URL
            );
            this._activeSessionId = session.id;
            await this._context.globalState.update(
              "huemul.activeSessionId",
              session.id
            );
            this._sessions = await listSessions(this._token, BACKEND_URL);
            this.postToWebview({ type: "sessionCreated", session });
            this.postToWebview({
              type: "sessions",
              sessions: this._sessions,
              activeId: this._activeSessionId,
            });
          } catch (e) {
            this._postError(e);
          }
          break;
        }

        // ── Cambiar sesión activa ────────────────────────────
        case "switchSession": {
          const sid = String(message.sessionId ?? "").trim();
          if (!sid || !this._token) {
            return;
          }
          this._activeSessionId = sid;
          await this._context.globalState.update("huemul.activeSessionId", sid);
          this.postToWebview({
            type: "sessions",
            sessions: this._sessions,
            activeId: sid,
          });
          this.postToWebview({ type: "clearChat" });

          // Cargar historial desde el backend
          try {
            const res = await fetch(`${BACKEND_URL}/sessions/${sid}`, {
              headers: {
                Authorization: `Bearer ${this._token}`,
                "Content-Type": "application/json",
              },
            });
            if (res.ok) {
              const data = await res.json() as {
                messages: Array<{ role: string; content: string }>;
              };
              if (data.messages && data.messages.length > 0) {
                this.postToWebview({ type: "history", messages: data.messages });
              }
            }
          } catch {
            // Si falla, el chat queda vacío — no es crítico
          }
          break;
        }

        // ── Eliminar sesión ──────────────────────────────────
        case "deleteSession": {
          if (!this._token) {
            return;
          }
          const sid = String(message.sessionId ?? "").trim();
          try {
            await deleteSession(this._token, sid, BACKEND_URL);
            if (this._activeSessionId === sid) {
              this._activeSessionId = undefined;
              await this._context.globalState.update(
                "huemul.activeSessionId",
                undefined
              );
            }
            this._sessions = await listSessions(this._token, BACKEND_URL);
            this.postToWebview({
              type: "sessions",
              sessions: this._sessions,
              activeId: this._activeSessionId,
            });
            this.postToWebview({ type: "clearChat" });
          } catch (e) {
            this._postError(e);
          }
          break;
        }

        // ── Cambiar modo ─────────────────────────────────────
        case "changeMode": {
          const mode = String(message.mode ?? "analysis");
          this._activeMode = mode;
          await this._context.globalState.update("huemul.activeMode", mode);
          this.postToWebview({ type: "modeChanged", mode });
          break;
        }

        // ── Enviar mensaje ───────────────────────────────────
        case "ask": {
          if (!this._token) {
            this.postToWebview({ type: "authRequired" });
            return;
          }
          if (!this._activeSessionId) {
            this.postToWebview({
              type: "error",
              text: "Crea o selecciona una sesión antes de enviar un mensaje.",
            });
            return;
          }

          const text = String(message.text ?? "").trim();
          const model = String(
            message.model ?? this._activeModel ?? ""
          ).trim();

          if (!text) {
            return;
          }
          if (!model) {
            this.postToWebview({
              type: "error",
              text: "No hay modelo seleccionado. Pulsa «Actualizar modelos».",
            });
            return;
          }

          this._activeModel = model;
          await this._context.globalState.update("huemul.activeModel", model);

          this._abort?.abort();
          this._abort = new AbortController();

          this.postToWebview({ type: "loading", value: true });

          try {
            this.postToWebview({ type: "streamStart" });
            await chatStream(
              {
                backendUrl: BACKEND_URL,
                token: this._token,
                sessionId: this._activeSessionId,
                message: text,
                model,
                mode: this._activeMode,
                signal: this._abort.signal,
              },
              (chunk) => {
                this.postToWebview({ type: "streamToken", text: chunk });
              }
            );
            this.postToWebview({ type: "streamEnd" });

            // Actualizar lista de sesiones (título puede haber cambiado)
            this._sessions = await listSessions(this._token, BACKEND_URL);
            this.postToWebview({
              type: "sessions",
              sessions: this._sessions,
              activeId: this._activeSessionId,
            });
          } catch (e) {
            if (e instanceof Error && e.name === "AbortError") {
              this.postToWebview({
                type: "error",
                text: "Generación cancelada.",
              });
            } else {
              this._postError(e);
            }
          } finally {
            this.postToWebview({ type: "loading", value: false });
          }
          break;
        }

        case "stop": {
          this._abort?.abort();
          break;
        }

        default:
          break;
      }
    });
  }

  // ── Métodos privados ──────────────────────────────────────

  // ← ÚNICO _onLoginSuccess — fusión correcta de ambas versiones
  private async _onLoginSuccess(): Promise<void> {
    this.postToWebview({
      type: "loginSuccess",
      role: this._userRole,
      email: this._userEmail,
    });
    await this._pushModelsToWebview();
    await this._pushSessionsToWebview();

    // Cargar historial de la sesión activa al iniciar
    if (this._activeSessionId && this._token) {
      try {
        const res = await fetch(
          `${BACKEND_URL}/sessions/${this._activeSessionId}`,
          {
            headers: {
              Authorization: `Bearer ${this._token}`,
              "Content-Type": "application/json",
            },
          }
        );
        if (res.ok) {
          const data = await res.json() as {
            messages: Array<{ role: string; content: string }>;
          };
          if (data.messages && data.messages.length > 0) {
            this.postToWebview({ type: "history", messages: data.messages });
          }
        }
      } catch {
        // Si falla, el chat queda vacío
      }
    }
  }

  private async _pushModelsToWebview(): Promise<void> {
    if (!this._token || !this._view) {
      return;
    }
    try {
      const names = await listModelNames(this._token, BACKEND_URL);
      const defaultModel = await getDefaultModel(this._token, BACKEND_URL);
      const active =
        this._activeModel ||
        (names.includes(defaultModel) ? defaultModel : names[0] ?? "");
      this._activeModel = active;
      this.postToWebview({ type: "models", names, activeModel: active });
    } catch (e) {
      const msg =
        e instanceof HuemulError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      this.postToWebview({
        type: "models",
        names: [],
        activeModel: "",
        error: msg,
      });
    }
  }

  private async _pushSessionsToWebview(): Promise<void> {
    if (!this._token) {
      return;
    }
    try {
      this._sessions = await listSessions(this._token, BACKEND_URL);
      const stillExists = this._sessions.some(
        (s) => s.id === this._activeSessionId
      );
      if (!stillExists) {
        this._activeSessionId = undefined;
        await this._context.globalState.update(
          "huemul.activeSessionId",
          undefined
        );
      }
      this.postToWebview({
        type: "sessions",
        sessions: this._sessions,
        activeId: this._activeSessionId,
        activeMode: this._activeMode,
      });
    } catch (e) {
      this._postError(e);
    }
  }

  private _postError(e: unknown): void {
    const msg =
      e instanceof HuemulError
        ? e.message
        : e instanceof OllamaError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Error desconocido";
    this.postToWebview({ type: "error", text: msg });
  }

  public focus(): void {
    void this._view?.show?.(true);
  }

  private postToWebview(message: unknown): void {
    if (this._view) {
      void this._view.webview.postMessage(message);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const hlJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "highlight.min.js")
    );
    const hlCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "hl-theme.css")
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Huemul</title>
  <link rel="stylesheet" href="${hlCssUri}" />
  <script nonce="${nonce}" src="${hlJsUri}"></script>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-foreground, #ccc);
      --user-bg: var(--vscode-button-background, #0e639c);
      --user-fg: var(--vscode-button-foreground, #fff);
      --asst-bg: var(--vscode-input-background, #3c3c3c);
      --border: var(--vscode-widget-border, #333);
      --muted: var(--vscode-descriptionForeground, #999);
      --green: var(--vscode-testing-iconPassed, #89d185);
      --warn: var(--vscode-list-warningForeground, #cca700);
      --err: var(--vscode-errorForeground, #f88070);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 0;
      font-family: var(--vscode-font-family);
      font-size: 13px; color: var(--fg); background: var(--bg);
      height: 100vh; display: flex; flex-direction: column; overflow: hidden;
    }
    #loginScreen { display: flex; flex-direction: column; gap: 12px; padding: 24px 16px; }
    #loginScreen h2 { margin: 0 0 4px; font-size: 16px; color: var(--fg); }
    #loginScreen p { margin: 0; font-size: 12px; color: var(--muted); }
    #loginScreen input { width: 100%; padding: 7px 10px; font: inherit; color: var(--fg); background: var(--asst-bg); border: 1px solid var(--border); border-radius: 4px; }
    #loginScreen input:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
    #loginError { display: none; color: var(--err); font-size: 12px; padding: 4px 0; }
    #mainUI { display: none; flex: 1; flex-direction: column; overflow: hidden; }
    .user-bar { display: flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: 11px; color: var(--muted); border-bottom: 1px solid var(--border); background: var(--vscode-sideBarSectionHeader-background, var(--asst-bg)); }
    .user-bar .email { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge-admin { font-size: 10px; font-weight: bold; color: var(--user-fg); background: var(--user-bg); border-radius: 3px; padding: 1px 5px; }
    .sessions-bar { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .sessions-bar label { font-size: 11px; color: var(--muted); }
    #sessionSelect { flex: 1; font-size: 12px; }
    select, button { font: inherit; color: var(--fg); background: var(--asst-bg); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; }
    button:hover { filter: brightness(1.08); cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-icon { background: transparent; border: none; padding: 2px 6px; font-size: 14px; cursor: pointer; color: var(--muted); }
    .btn-icon:hover { color: var(--fg); filter: none; }
    .grow { flex: 1; min-width: 4px; }
    .mode-bar { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .mode-bar label { font-size: 11px; color: var(--muted); }
    .mode-toggle { display: flex; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
    .mode-btn { padding: 3px 12px; border: none; border-radius: 0; font-size: 12px; cursor: pointer; background: var(--asst-bg); color: var(--muted); transition: background 0.15s, color 0.15s; }
    .mode-btn.active-analysis { background: var(--user-bg); color: var(--user-fg); font-weight: bold; }
    .mode-btn.active-edit { background: var(--warn); color: #000; font-weight: bold; }
    .mode-indicator { font-size: 11px; padding: 2px 7px; border-radius: 3px; font-weight: bold; }
    .mode-indicator.analysis { background: var(--user-bg); color: var(--user-fg); }
    .mode-indicator.edit { background: var(--warn); color: #000; }
    .model-bar { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; flex-wrap: wrap; }
    .model-bar label { font-size: 11px; color: var(--muted); }
    #modelStatus { font-size: 11px; color: var(--muted); }
    #modelStatus.ok { color: var(--green); }
    #modelStatus.warn { color: var(--warn); }
    #modelStatus.err { color: var(--err); }
    #chat { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; scroll-behavior: smooth; }
    .row { display: flex; width: 100%; }
    .row.user { justify-content: flex-end; }
    .row.assistant { justify-content: flex-start; }
    .bubble { max-width: 92%; padding: 10px 12px; border-radius: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
    .bubble.user { background: var(--user-bg); color: var(--user-fg); border-bottom-right-radius: 4px; }
    .bubble.assistant { background: var(--asst-bg); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
    .bubble.assistant-rich { white-space: normal; }
    .assistant-body { display: flex; flex-direction: column; gap: 12px; }
    .md-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; color: var(--fg); }
    .code-block { border: 1px solid var(--border); border-radius: 8px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12)); overflow: hidden; }
    .code-block-summary { cursor: pointer; list-style: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; font-size: 12px; background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.15)); user-select: none; }
    .code-block-summary::-webkit-details-marker { display: none; }
    .code-lang { font-family: var(--vscode-editor-font-family, monospace); color: var(--user-bg); font-weight: 600; text-transform: lowercase; }
    .code-meta { color: var(--muted); flex: 1; }
    .code-copy { margin-left: auto; font-size: 11px; padding: 3px 10px; flex-shrink: 0; }
    .code-block-body { max-height: min(55vh, 360px); overflow: auto; border-top: 1px solid var(--border); }
    .code-block-body pre { margin: 0; padding: 10px 12px; font-size: 12px; line-height: 1.45; font-family: var(--vscode-editor-font-family, monospace); }
    .code-block-body code { font-family: inherit; }
    .code-block-body pre code.hljs { color: #dcdcdc; background: transparent; }
    .bubble.error { background: var(--asst-bg); border: 1px solid var(--vscode-inputValidation-errorBorder, #f14c4c); color: var(--err); }
    .input-area { border-top: 1px solid var(--border); padding: 8px 10px 10px; flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; }
    .input-row { display: flex; gap: 8px; align-items: flex-end; }
    #input { flex: 1; resize: none; min-height: 72px; max-height: 200px; font: inherit; color: var(--fg); background: var(--asst-bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
    #input:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
    #send { height: 36px; padding: 0 14px; background: var(--user-bg); color: var(--user-fg); border: none; }
    .loading-wrap { display: none; align-items: center; gap: 8px; padding: 0 2px; color: var(--muted); font-size: 12px; }
    .loading-wrap.on { display: flex; }
    .spinner { width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--user-bg); border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hint { font-size: 11px; color: var(--muted); padding: 0 2px; }
    #modeToast { display: none; position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%); background: var(--asst-bg); border: 1px solid var(--border); padding: 6px 14px; border-radius: 6px; font-size: 12px; color: var(--fg); white-space: nowrap; z-index: 10; }
    @keyframes fadeOut { 0% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }
    body { position: relative; }
  </style>
</head>
<body>

  <!-- LOGIN -->
  <div id="loginScreen">
    <h2>🦚 Huemul</h2>
    <p>Ingresa con tu correo universitario para continuar.</p>
    <input type="email" id="loginEmail" placeholder="usuario@uandresbello.edu" autocomplete="email" />
    <input type="password" id="loginPassword" placeholder="Contraseña" autocomplete="current-password" />
    <div id="loginError"></div>
    <button type="button" id="loginBtn" style="background:var(--user-bg);color:var(--user-fg);border:none;padding:8px;">
      Iniciar sesión
    </button>
  </div>

  <!-- MAIN UI -->
  <div id="mainUI">
    <div class="user-bar">
      <span id="userEmail" class="email"></span>
      <span id="adminBadge" class="badge-admin" style="display:none">ADMIN</span>
      <button type="button" id="logoutBtn" class="btn-icon" title="Cerrar sesión">↩</button>
    </div>
    <div class="sessions-bar">
      <label for="sessionSelect">Sesión</label>
      <select id="sessionSelect"><option value="">(sin sesiones)</option></select>
      <button type="button" class="btn-icon" id="newSessionBtn" title="Nueva sesión">＋</button>
      <button type="button" class="btn-icon" id="deleteSessionBtn" title="Eliminar sesión">🗑</button>
    </div>
    <div class="mode-bar">
      <label>Modo</label>
      <div class="mode-toggle">
        <button type="button" class="mode-btn" id="modeAnalysis">Análisis</button>
        <button type="button" class="mode-btn" id="modeEdit">Edición</button>
      </div>
      <span id="modeIndicator" class="mode-indicator analysis">ANÁLISIS</span>
    </div>
    <div class="model-bar">
      <label for="model">Modelo</label>
      <select id="model"></select>
      <span id="modelStatus"></span>
      <div class="grow"></div>
      <button type="button" id="refreshModels">Actualizar</button>
    </div>
    <div id="chat" role="log" aria-live="polite"></div>
    <div class="loading-wrap" id="loading">
      <div class="spinner" aria-hidden="true"></div>
      <span>Pensando…</span>
    </div>
    <div class="input-area">
      <div class="hint">Se incluye el archivo activo como contexto.</div>
      <div class="input-row">
        <textarea id="input" placeholder="Escribe tu mensaje…" rows="3"></textarea>
        <button type="button" id="send">Enviar</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button type="button" id="clear" style="font-size:11px;padding:3px 8px;">Limpiar</button>
        <button type="button" id="stop" style="display:none;font-size:11px;padding:3px 8px;">Detener</button>
        <span id="adminOptions" style="display:none;margin-left:auto;">
          <button type="button" id="openSettings" style="font-size:11px;padding:3px 8px;">⚙ Admin</button>
        </span>
      </div>
    </div>
    <div id="modeToast"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const loginScreen      = document.getElementById('loginScreen');
    const mainUI           = document.getElementById('mainUI');
    const loginEmail       = document.getElementById('loginEmail');
    const loginPassword    = document.getElementById('loginPassword');
    const loginBtn         = document.getElementById('loginBtn');
    const loginError       = document.getElementById('loginError');
    const userEmailEl      = document.getElementById('userEmail');
    const adminBadge       = document.getElementById('adminBadge');
    const logoutBtn        = document.getElementById('logoutBtn');
    const adminOptions     = document.getElementById('adminOptions');
    const sessionSelect    = document.getElementById('sessionSelect');
    const newSessionBtn    = document.getElementById('newSessionBtn');
    const deleteSessionBtn = document.getElementById('deleteSessionBtn');
    const modeAnalysisBtn  = document.getElementById('modeAnalysis');
    const modeEditBtn      = document.getElementById('modeEdit');
    const modeIndicator    = document.getElementById('modeIndicator');
    const modeToast        = document.getElementById('modeToast');
    const modelEl          = document.getElementById('model');
    const modelStatusEl    = document.getElementById('modelStatus');
    const chatEl           = document.getElementById('chat');
    const inputEl          = document.getElementById('input');
    const sendBtn          = document.getElementById('send');
    const clearBtn         = document.getElementById('clear');
    const stopBtn          = document.getElementById('stop');
    const loadingEl        = document.getElementById('loading');

    let streamingBubble = null;
    let codeColouringEnabled = true;
    let activeMode = 'analysis';

    // ── Login ─────────────────────────────────────────────────
    function showLogin() {
      loginScreen.style.display = 'flex';
      mainUI.style.display = 'none';
      loginError.style.display = 'none';
      loginEmail.value = '';
      loginPassword.value = '';
    }
    function showMain() {
      loginScreen.style.display = 'none';
      mainUI.style.display = 'flex';
    }
    loginBtn.addEventListener('click', () => {
      loginError.style.display = 'none';
      vscode.postMessage({ type: 'login', email: loginEmail.value.trim(), password: loginPassword.value });
    });
    loginEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginPassword.focus(); });
    loginPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginBtn.click(); });
    logoutBtn.addEventListener('click', () => {
      if (logoutBtn.dataset.confirming === 'true') {
        logoutBtn.dataset.confirming = 'false';
        logoutBtn.textContent = '↩';
        logoutBtn.style.color = '';
        vscode.postMessage({ type: 'logout' });
      } else {
        logoutBtn.dataset.confirming = 'true';
        logoutBtn.textContent = '✓';
        logoutBtn.style.color = 'var(--err)';
        setTimeout(() => {
          logoutBtn.dataset.confirming = 'false';
          logoutBtn.textContent = '↩';
          logoutBtn.style.color = '';
        }, 3000);
      }
    });

    // ── Sesiones ──────────────────────────────────────────────
    function renderSessions(sessions, activeId) {
      sessionSelect.innerHTML = '';
      if (!sessions || !sessions.length) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = '(sin sesiones)';
        sessionSelect.appendChild(o);
        return;
      }
      for (const s of sessions) {
        const o = document.createElement('option');
        o.value = s.id;
        const date = new Date(s.last_active_at).toLocaleDateString('es-CL');
        o.textContent = (s.title || 'Nueva sesión') + ' — ' + date;
        if (s.id === activeId) o.selected = true;
        sessionSelect.appendChild(o);
      }
    }
    newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    deleteSessionBtn.addEventListener('click', () => {
      const sid = sessionSelect.value;
      if (!sid) return;
      if (deleteSessionBtn.dataset.confirming === 'true') {
        deleteSessionBtn.dataset.confirming = 'false';
        deleteSessionBtn.textContent = '🗑';
        deleteSessionBtn.style.color = '';
        vscode.postMessage({ type: 'deleteSession', sessionId: sid });
      } else {
        deleteSessionBtn.dataset.confirming = 'true';
        deleteSessionBtn.textContent = '✓ Confirmar';
        deleteSessionBtn.style.color = 'var(--err)';
        setTimeout(() => {
          deleteSessionBtn.dataset.confirming = 'false';
          deleteSessionBtn.textContent = '🗑';
          deleteSessionBtn.style.color = '';
        }, 3000);
      }
    });
    sessionSelect.addEventListener('change', () => {
      const sid = sessionSelect.value;
      if (sid) vscode.postMessage({ type: 'switchSession', sessionId: sid });
    });

    // ── Modo ──────────────────────────────────────────────────
    function setMode(mode) {
      activeMode = mode;
      modeAnalysisBtn.className = 'mode-btn' + (mode === 'analysis' ? ' active-analysis' : '');
      modeEditBtn.className    = 'mode-btn' + (mode === 'edit'     ? ' active-edit'     : '');
      modeIndicator.className  = 'mode-indicator ' + mode;
      modeIndicator.textContent = mode === 'analysis' ? 'ANÁLISIS' : 'EDICIÓN';
    }
    function showModeToast(mode) {
      modeToast.textContent = mode === 'analysis' ? '✅ Modo Análisis activado' : '✏️ Modo Edición activado';
      modeToast.style.display = 'block';
      modeToast.style.animation = 'none';
      void modeToast.offsetHeight;
      modeToast.style.animation = 'fadeOut 2s forwards';
      setTimeout(() => { modeToast.style.display = 'none'; }, 2000);
    }
    modeAnalysisBtn.addEventListener('click', () => vscode.postMessage({ type: 'changeMode', mode: 'analysis' }));
    modeEditBtn.addEventListener('click',     () => vscode.postMessage({ type: 'changeMode', mode: 'edit' }));

    // ── Modelos ───────────────────────────────────────────────
    function setModelOptions(names, activeModel, error) {
      modelEl.innerHTML = '';
      modelStatusEl.className = '';
      if (error) {
        modelStatusEl.textContent = error; modelStatusEl.className = 'err';
        const o = document.createElement('option'); o.value = ''; o.textContent = '(error)';
        modelEl.appendChild(o); return;
      }
      if (!names || !names.length) {
        modelStatusEl.textContent = 'Sin modelos disponibles'; modelStatusEl.className = 'warn';
        const o = document.createElement('option'); o.value = ''; o.textContent = '(sin modelos)';
        modelEl.appendChild(o); return;
      }
      modelStatusEl.textContent = names.length + ' modelo(s)'; modelStatusEl.className = 'ok';
      for (const n of names) {
        const o = document.createElement('option');
        o.value = n; o.textContent = n;
        if (n === activeModel) o.selected = true;
        modelEl.appendChild(o);
      }
    }
    document.getElementById('refreshModels').addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));
    document.getElementById('openSettings').addEventListener('click',  () => vscode.postMessage({ type: 'openSettings' }));

    // ── Chat ──────────────────────────────────────────────────
    function scrollBottom() { chatEl.scrollTop = chatEl.scrollHeight; }

    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      appendBubble('user', text);
      inputEl.value = '';
      vscode.postMessage({ type: 'ask', text, model: modelEl.value, mode: activeMode });
    }
    sendBtn.addEventListener('click', send);
    clearBtn.addEventListener('click', () => { chatEl.innerHTML = ''; streamingBubble = null; });
    stopBtn.addEventListener('click',  () => vscode.postMessage({ type: 'stop' }));
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    function setLoading(on) {
      loadingEl.classList.toggle('on', on);
      sendBtn.disabled = on;
      stopBtn.style.display = on ? 'inline-block' : 'none';
      inputEl.disabled = on;
    }

    function appendBubble(role, text, classExtra) {
      const row = document.createElement('div');
      row.className = 'row ' + role;
      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + role + (classExtra ? ' ' + classExtra : '');
      if (role === 'assistant' && !classExtra) {
        renderAssistantRich(bubble, text);
      } else {
        bubble.textContent = text;
      }
      row.appendChild(bubble);
      chatEl.appendChild(row);
      scrollBottom();
      return bubble;
    }

    // ── renderAssistantRich ───────────────────────────────────
    function canonicalHljsLanguage(lang) {
      const raw = String(lang || '').trim().toLowerCase();
      if (!raw || raw === 'text' || raw === 'txt') return null;
      const map = { py:'python',python3:'python',js:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',sh:'bash',shell:'bash',yml:'yaml',rb:'ruby',rs:'rust',cs:'csharp',cpp:'cpp','c++':'cpp',go:'go',kt:'kotlin',md:'markdown' };
      return Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : raw;
    }
    function guessFenceLanguage(code) {
      const s = String(code || '');
      if (/\\bdef\\s+\\w+\\s*\\(/.test(s)||/\\bprint\\(/.test(s)||/\\belif\\b/.test(s)) return 'python';
      if (/\\bconst\\s+\\w+\\s*=/.test(s)||/=>/.test(s)||/\\bconsole\\.log\\(/.test(s)) return 'javascript';
      if (/^\\s*#include\\s*[<"]/m.test(s)) return 'cpp';
      return null;
    }
    function splitMarkdownFences(text) {
      const parts = []; const re = /\`\`\`([\\w+-]*)\\n?([\\s\\S]*?)\`\`\`/g;
      let last = 0, m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) parts.push({ type:'text', content:text.slice(last, m.index) });
        parts.push({ type:'code', lang:(m[1]||'').trim()||'text', content:m[2]||'' });
        last = re.lastIndex;
      }
      if (last < text.length) parts.push({ type:'text', content:text.slice(last) });
      if (!parts.length) parts.push({ type:'text', content:text });
      return parts;
    }
    function buildCodeBlock(lang, rawCode) {
      const code = String(rawCode).replace(/\\n$/, '');
      const lines = code.length ? code.split('\\n') : [];
      const hlLang = canonicalHljsLanguage(lang);
      const details = document.createElement('details'); details.className = 'code-block';
      const summary = document.createElement('summary'); summary.className = 'code-block-summary';
      const langSpan = document.createElement('span'); langSpan.className = 'code-lang'; langSpan.textContent = hlLang || lang || '…';
      const meta = document.createElement('span'); meta.className = 'code-meta'; meta.textContent = lines.length === 1 ? '1 línea' : lines.length + ' líneas';
      const copyBtn = document.createElement('button'); copyBtn.type='button'; copyBtn.className='code-copy'; copyBtn.textContent='Copiar';
      copyBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); navigator.clipboard.writeText(code).then(()=>{ copyBtn.textContent='Copiado'; setTimeout(()=>{ copyBtn.textContent='Copiar'; },1600); },()=>{}); });
      summary.appendChild(langSpan); summary.appendChild(meta); summary.appendChild(copyBtn);
      const body = document.createElement('div'); body.className = 'code-block-body';
      const pre = document.createElement('pre'); const codeEl = document.createElement('code');
      codeEl.textContent = code; if (hlLang) codeEl.className = 'language-' + hlLang;
      pre.appendChild(codeEl); body.appendChild(pre); details.appendChild(summary); details.appendChild(body);
      return details;
    }
    function renderAssistantRich(bubble, rawText) {
      bubble.innerHTML = ''; bubble.classList.add('assistant-rich');
      const body = document.createElement('div'); body.className = 'assistant-body';
      for (const p of splitMarkdownFences(rawText || '')) {
        if (p.type === 'text') { if (!p.content) continue; const d=document.createElement('div'); d.className='md-text'; d.textContent=p.content; body.appendChild(d); }
        else { body.appendChild(buildCodeBlock(p.lang, p.content)); }
      }
      bubble.appendChild(body);
      if (codeColouringEnabled && typeof hljs !== 'undefined') {
        body.querySelectorAll('pre code').forEach((el) => {
          try {
            const raw = el.textContent || '';
            const guess = guessFenceLanguage(raw);
            if (el.className && el.className.indexOf('language-') === 0) { hljs.highlightElement(el); }
            else if (guess && hljs.getLanguage(guess)) { const r=hljs.highlight(raw,{language:guess,ignoreIllegals:true}); el.innerHTML=r.value; el.className='hljs'; }
            else { const r=hljs.highlightAuto(raw); el.innerHTML=r.value; el.className='hljs'; }
          } catch { /* ignore */ }
        });
      }
    }

    // ── Mensajes desde extensión ──────────────────────────────
    window.addEventListener('message', (event) => {
      const m = event.data;
      if (!m || typeof m.type !== 'string') return;
      switch (m.type) {

        case 'history': {
          chatEl.innerHTML = '';
          streamingBubble = null;
          for (const msg of (m.messages || [])) {
            if (msg.role === 'user') appendBubble('user', msg.content);
            else if (msg.role === 'assistant') appendBubble('assistant', msg.content);
          }
          scrollBottom();
          break;
        }

        case 'authRequired': showLogin(); break;

        case 'loginSuccess':
          showMain();
          userEmailEl.textContent = m.email || '';
          adminBadge.style.display   = m.role === 'admin' ? 'inline' : 'none';
          adminOptions.style.display = m.role === 'admin' ? 'inline' : 'none';
          break;

        case 'loginError':
          loginError.textContent = m.text || 'Error de autenticación.';
          loginError.style.display = 'block';
          break;

        case 'sessions':
          renderSessions(m.sessions || [], m.activeId || '');
          if (m.activeMode) setMode(m.activeMode);
          break;

        case 'sessionCreated':
        case 'clearChat':
          chatEl.innerHTML = ''; streamingBubble = null; break;

        case 'modeChanged': setMode(m.mode); showModeToast(m.mode); break;

        case 'models': setModelOptions(m.names || [], m.activeModel || '', m.error || ''); break;

        case 'loading': setLoading(!!m.value); break;

        case 'streamStart': {
          const row = document.createElement('div'); row.className = 'row assistant';
          const bubble = document.createElement('div'); bubble.className = 'bubble assistant'; bubble.textContent = '';
          row.appendChild(bubble); chatEl.appendChild(row); streamingBubble = bubble; scrollBottom(); break;
        }

        case 'streamToken':
          if (streamingBubble) streamingBubble.textContent += m.text || '';
          scrollBottom(); break;

        case 'streamEnd':
          if (streamingBubble) { renderAssistantRich(streamingBubble, streamingBubble.textContent); scrollBottom(); }
          streamingBubble = null; break;

        case 'error':
          if (streamingBubble && streamingBubble.textContent === '') streamingBubble.closest('.row')?.remove();
          appendBubble('assistant', m.text || 'Error', 'error');
          streamingBubble = null; break;

        default: break;
      }
    });

    setMode('analysis');
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }  // ← cierre de _getHtmlForWebview
}    // ← cierre de la clase HuemulChatProvider

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}