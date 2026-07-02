import * as vscode from "vscode";
import { OllamaError } from "./ollamaClient"; // se mantiene para _postError
import {
  HuemulError,
  login,
  register,          
  forgotPassword,
  listModelNames,
  getDefaultModel,
  listSessions,
  createSession,
  deleteSession,
  chatStream,
  SessionResponse,
  chatSuggest,
  chatEdit,
  EditRequest,
  changePassword,
} from "./huemulClient";


const BACKEND_URL = "http://localhost:8000";
const MAX_FILES_PER_REQUEST = 10;

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
            if (resp.must_change_password) {
              this.postToWebview({ type: "mustChangePassword" });
            } else {
              await this._onLoginSuccess();
            }
          } catch (e) {
            const msg = e instanceof HuemulError ? e.message : e instanceof Error ? e.message : "Error desconocido";
            this.postToWebview({ type: "loginError", text: msg });
          }
          break;
        }

        case "changePassword": {
          if (!this._token) return;
          const currentPwd = String(message.currentPassword ?? "");
          const newPwd     = String(message.newPassword ?? "");
          try {
            const resp = await changePassword(this._token, currentPwd, newPwd, BACKEND_URL);
            // Actualizar token — el nuevo JWT no tendrá must_change_password
            const loginResp = await login(this._userEmail, newPwd, BACKEND_URL);
            this._token = loginResp.access_token;
            this._userRole = loginResp.role;
            await this._context.secrets.store("huemul.token", loginResp.access_token);
            this.postToWebview({ type: "passwordChanged", text: resp.message });
            await this._onLoginSuccess();
          } catch (e) {
            const msg = e instanceof HuemulError ? e.message : e instanceof Error ? e.message : "Error desconocido";
            this.postToWebview({ type: "changePasswordError", text: msg });
          }
          break;
        }

        case "register": {
          const email = String(message.email ?? "").trim();
          const password = String(message.password ?? "").trim();
          if (!email || !password) {
            this.postToWebview({ type: "registerError", text: "Ingresa correo y contraseña." });
            return;
          }
          try {
            const resp = await register(email, password, BACKEND_URL);
            this.postToWebview({ type: "registerSuccess", text: resp.message });
          } catch (e) {
            const msg = e instanceof HuemulError ? e.message : e instanceof Error ? e.message : "Error desconocido";
            this.postToWebview({ type: "registerError", text: msg });
          }
          break;
        }

        case "forgotPassword": {
          const email = String(message.email ?? "").trim();
          if (!email) {
            this.postToWebview({ type: "forgotPasswordResult", text: "Ingresa tu correo." });
            return;
          }
          try {
            const resp = await forgotPassword(email, BACKEND_URL);
            this.postToWebview({ type: "forgotPasswordResult", text: resp.message });
          } catch (e) {
            const msg = e instanceof HuemulError ? e.message : e instanceof Error ? e.message : "Error desconocido";
            this.postToWebview({ type: "forgotPasswordResult", text: msg });
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

            const autoContext = Boolean(message.autoContext ?? true);
              if (autoContext) {
                await this._autoLoadProjectContext(session.id);
              }

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

          const activeFile = getActiveEditorContext();

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
                files: activeFile ? [activeFile] : [],  
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

        case "selectFiles": {
          const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: false,
            openLabel: "Agregar al contexto",
            filters: {
              "Código": ["ts","js","py","java","cs","cpp","c","h","go","rs","rb","php","swift","kt"],
              "Configuración": ["json","yaml","yml","toml","ini","env","xml"],
              "Documentación": ["md","txt","rst"],
              "Todos los archivos": ["*"],
            },
          });
          if (!uris || uris.length === 0) {
            return;
          }
          const files: Array<{ filename: string; content: string }> = [];
          for (const uri of uris) {
            try {
              const bytes    = await vscode.workspace.fs.readFile(uri);
              const content  = Buffer.from(bytes).toString("utf-8");
              const filename = vscode.workspace.asRelativePath(uri, false);
              files.push({ filename, content });
            } catch {
              // Si no se puede leer el archivo, se omite
            }
          }
          if (files.length > MAX_FILES_PER_REQUEST) {
            files.splice(MAX_FILES_PER_REQUEST);
            this.postToWebview({
              type: "warning",
              text: `Se incluirán solo los primeros ${MAX_FILES_PER_REQUEST} archivos.`,
            });
          }
          if (files.length > 0) {
          this.postToWebview({ type: "filesSelected", files });
        }
        break;
      }
      
      case "includeProject": {
        if (!this._token || !this._activeSessionId) {
          return;
        }

        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
          this.postToWebview({
            type: "warning",
            text: "No hay carpeta abierta. Usa File → Open Folder para abrir tu proyecto.",
          });
          return;
        }

        const pattern  = "**/*";
        const excluded = "{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/*.min.*,**/*.lock,**/package-lock.json}";
        const uris = await vscode.workspace.findFiles(pattern, excluded, 50);
        
        const files: Array<{ filename: string; content: string }> = [];
        for (const uri of uris) {
          try {
            const bytes   = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(bytes).toString("utf-8");
            if (content.length > 50000 || _isBinary(content)) {
              continue;
            }
            const filename = vscode.workspace.asRelativePath(uri, false);
            files.push({ filename, content });
          } catch {
      // Si no se puede leer, se omite
      }
    }
    if (files.length > MAX_FILES_PER_REQUEST) {
      files.splice(MAX_FILES_PER_REQUEST);
      this.postToWebview({
        type: "warning",
        text: `Se incluirán solo los primeros ${MAX_FILES_PER_REQUEST} archivos del proyecto.`,
      });
    }
    try {
      const res = await fetch(
        `${BACKEND_URL}/sessions/${this._activeSessionId}/context`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this._token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ files }),
        }
      );
      if (res.ok) {
        const data = await res.json() as { files_stored: number; files: string[] };
        this.postToWebview({
          type: "projectLoaded",
          count: data.files_stored,
          files: data.files,
        });
      }
    } catch (e) {
      this._postError(e);
    }
    break;
  }

        case "adminPanelOpened": {
          if (!this._token) return;
          try {
            const configRes = await fetch(`${BACKEND_URL}/admin/config`, {
              headers: { Authorization: `Bearer ${this._token}` },
            });
            const configData = configRes.ok
              ? await configRes.json() as { value: string }
              : { value: "" };
            const usersRes = await fetch(`${BACKEND_URL}/admin/users`, {
              headers: { Authorization: `Bearer ${this._token}` },
            });
            const users = usersRes.ok
              ? await usersRes.json() as Array<{ id: number; email: string; role: string }>
              : [];
            this.postToWebview({ type: "adminPanelData", systemPrompt: configData.value, users });
          } catch (e) { this._postError(e); }
          break;
        }

        case "saveSystemPrompt": {
          if (!this._token) return;
          const value = String(message.value ?? "").trim();
          try {
          const res = await fetch(`${BACKEND_URL}/admin/config`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${this._token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ value }),
          });
          this.postToWebview({ type: "systemPromptSaved", success: res.ok });
        } catch {
          this.postToWebview({ type: "systemPromptSaved", success: false });
        }
        break;
      }

        case "changeUserRole": {
          if (!this._token) return;
          const userId = Number(message.userId);
          const role   = String(message.role ?? "user");
          try {
            await fetch(`${BACKEND_URL}/admin/users/${userId}/role?role=${role}`, {
              method: "PUT",
              headers: { Authorization: `Bearer ${this._token}` },
            });
            this.postToWebview({ type: "userRoleChanged" });
          } catch (e) { this._postError(e); }
        break;
      }

        case "requestSuggest": {
          if (!this._token || !this._activeSessionId) return;
          const activeFile = getActiveEditorContext();
          if (!activeFile) {
            this.postToWebview({ type: "error", text: "No hay archivo activo para sugerir cambios." });
            return;
          }
          this.postToWebview({ type: "loading", value: true });
          try {
            const result = await chatSuggest(this._token, {
              sessionId: this._activeSessionId,
              message: String(message.text ?? ""),
              model: this._activeModel,
              filename: activeFile.filename,
              content: activeFile.content,
            }, BACKEND_URL);
            if (result.diff) {
              this.postToWebview({ type: "diffResult", filename: result.filename, diff: result.diff });
            } else {
              // El modelo no generó un diff válido — mostrar respuesta cruda
              this.postToWebview({ type: "assistant", text: result.raw ?? "No se pudo generar un diff." });
            }
          } catch (e) { this._postError(e); }
          finally { this.postToWebview({ type: "loading", value: false }); }
          break;
        }

        case "applyDiff": {
          // Aplica el diff usando WorkspaceEdit
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            this.postToWebview({ type: "error", text: "No hay archivo activo para aplicar el diff." });
            return;
          }
          const diff = String(message.diff ?? "");
          const original = editor.document.getText();
          const newContent = applyUnifiedDiff(original, diff);
          if (newContent === null) {
            this.postToWebview({ type: "error", text: "No se pudo aplicar el diff. Intenta con modo edición directa." });
            return;
          }
          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(original.length)
          );
          edit.replace(editor.document.uri, fullRange, newContent);
          await vscode.workspace.applyEdit(edit);
          this.postToWebview({ type: "diffApplied", filename: editor.document.fileName });
          break;
        }

        case "requestEdit": {
          if (!this._token || !this._activeSessionId) return;
          const activeFile = getActiveEditorContext();
          if (!activeFile) {
            this.postToWebview({ type: "error", text: "No hay archivo activo para editar." });
            return;
          }
          this.postToWebview({ type: "loading", value: true });
          try {
            const result = await chatEdit(this._token, {
              sessionId: this._activeSessionId,
              message: String(message.text ?? ""),
              model: this._activeModel,
              filename: activeFile.filename,
              content: activeFile.content,
            }, BACKEND_URL);
            if (result.newContent) {
              this.postToWebview({
                type: "editResult",
                filename: result.filename,
                newContent: result.newContent,
                originalContent: activeFile.content,
              });
            } else {
              this.postToWebview({ type: "assistant", text: result.raw ?? "No se pudo generar el archivo editado." });
            }
          } catch (e) { this._postError(e); }
          finally { this.postToWebview({ type: "loading", value: false }); }
          break;
        }

        case "applyEdit": {
          const editor = vscode.window.activeTextEditor;
          if (!editor) return;
          const newContent = String(message.newContent ?? "");
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            editor.document.uri,
            new vscode.Range(
              editor.document.positionAt(0),
              editor.document.positionAt(editor.document.getText().length)
            ),
            newContent
          );
          await vscode.workspace.applyEdit(edit);
          this.postToWebview({ type: "editApplied", filename: editor.document.fileName });
          break;
        }

        case "createUser": {
          if (!this._token) return;
          const email = String(message.email ?? "").trim();
          const role  = String(message.role ?? "user");
          try {
            const res = await fetch(`${BACKEND_URL}/admin/users`, {
              method: "POST",
              headers: { Authorization: `Bearer ${this._token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ email, role }),
            });
            const data = await res.json() as { message: string; temp_password?: string };
            if (res.ok) {
              this.postToWebview({
                type: "userCreated",
                message: data.message,
                temp_password: data.temp_password,
              });
              this.postToWebview({ type: "userRoleChanged" }); // recargar tabla
            } else {
              this.postToWebview({ type: "createUserError", text: (data as any).detail ?? "Error al crear usuario." });
            }
          } catch (e) { this._postError(e); }
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

  private async _autoLoadProjectContext(sessionId: string): Promise<void> {
    if (!this._token) return;
    if (!vscode.workspace.workspaceFolders?.length) return;

    const pattern  = "**/*";
    const excluded = "{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/*.min.*,**/*.lock,**/package-lock.json}";
    const uris = await vscode.workspace.findFiles(pattern, excluded, 50);

    const files: Array<{ filename: string; content: string }> = [];
    for (const uri of uris) {
      try {
        const bytes   = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString("utf-8");
        if (content.length > 50000 || _isBinary(content)) continue;
        files.push({ filename: vscode.workspace.asRelativePath(uri, false), content });
      } catch { /* ignorar */ }
    }

    if (files.length === 0) return;
    if (files.length > MAX_FILES_PER_REQUEST) files.splice(MAX_FILES_PER_REQUEST);

    try {
      const res = await fetch(`${BACKEND_URL}/sessions/${sessionId}/context`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this._token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      if (res.ok) {
        const data = await res.json() as { files_stored: number; files: string[] };
        this.postToWebview({ type: "autoContextLoaded", count: data.files_stored, files: data.files });
      }
    } catch { /* silencioso */ }
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
    .context-bar { display: flex; align-items: flex-start; gap: 6px; padding: 5px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; flex-wrap: wrap; background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.08)); }
    .context-bar-label { font-size: 11px; color: var(--muted); white-space: nowrap; padding-top: 2px; }
    .context-file-list { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; }
    .context-chip { display: inline-flex; align-items: center; gap: 4px; background: var(--asst-bg); border: 1px solid var(--border); border-radius: 3px; padding: 1px 6px; font-size: 11px; color: var(--fg); }
    .context-chip-remove { cursor: pointer; color: var(--muted); font-size: 12px; line-height: 1; background: none; border: none; padding: 0; }
    .context-chip-remove:hover { color: var(--err); filter: none; }
    .context-weight { font-size: 11px; color: var(--muted); white-space: nowrap; padding-top: 2px; }
    .context-weight.over { color: var(--err); }
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
    /* ── Diff visual ── */
    .diff-block { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; margin: 4px 0; }
    .diff-header { background: var(--asst-bg); padding: 6px 10px; font-size: 11px; color: var(--muted); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .diff-lines { max-height: 300px; overflow-y: auto; }
    .diff-line { padding: 1px 10px; white-space: pre; }
    .diff-line.added   { background: rgba(0,200,100,0.15); color: #89d185; }
    .diff-line.removed { background: rgba(220,50,50,0.15);  color: #f88070; }
    .diff-line.context { color: var(--muted); }
    .diff-line.hunk    { color: var(--user-bg); background: rgba(14,148,136,0.1); }
    .diff-actions { display: flex; gap: 6px; margin-top: 6px; }
  </style>
</head>
<body>

  <!-- LOGIN -->
  <div id="loginScreen">
    <h2>🦚 Huemul</h2>

    <!-- Formulario de login (visible por defecto) -->
    <div id="loginForm">
      <p>Ingresa con tu correo universitario para continuar.</p>
      <input type="email" id="loginEmail" placeholder="usuario@uandresbello.edu" autocomplete="email" />
      <input type="password" id="loginPassword" placeholder="Contraseña" autocomplete="current-password" />
      <div id="loginError"></div>
      <button type="button" id="loginBtn" style="background:var(--user-bg);color:var(--user-fg);border:none;padding:8px;">
        Iniciar sesión
      </button>
      <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px;">
        <a href="#" id="showForgotLink" style="color:var(--user-bg);">¿Olvidaste tu contraseña?</a>
      </div>
    </div>

    <!-- Formulario cambio de contraseña obligatorio -->
    <div id="changePasswordForm" style="display:none;">
      <p style="color:var(--warn);">⚠️ Debes cambiar tu contraseña temporal antes de continuar.</p>
      <input type="password" id="currentPassword" placeholder="Contraseña temporal" autocomplete="current-password" />
      <input type="password" id="newPasswordInput" placeholder="Nueva contraseña (mín. 8 caracteres)" autocomplete="new-password" />
      <input type="password" id="confirmNewPassword" placeholder="Confirmar nueva contraseña" autocomplete="new-password" />
      <div id="changePasswordError"></div>
      <button type="button" id="changePasswordBtn" style="background:var(--user-bg);color:var(--user-fg);border:none;padding:8px;margin-top:4px;">Cambiar contraseña</button>
    </div>

    <!-- Formulario de recuperación (oculto por defecto) -->
    <div id="forgotForm" style="display:none;">
      <p>Ingresa tu correo y te enviaremos un link para restablecer tu contraseña.</p>
      <input type="email" id="forgotEmail" placeholder="usuario@uandresbello.edu" autocomplete="email" />
      <div id="forgotResult" style="font-size:12px;color:var(--muted);"></div>
      <button type="button" id="forgotBtn" style="background:var(--user-bg);color:var(--user-fg);border:none;padding:8px;">
        Enviar link de recuperación
      </button>
      <div style="margin-top:8px;font-size:11px;">
        <a href="#" id="backToLoginFromForgot" style="color:var(--user-bg);">← Volver al login</a>
      </div>
    </div>
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
      <label style="font-size:11px;color:var(--muted);display:flex;align-items:center;gap:3px;" title="Carga contexto al crear sesión">
        <input type="checkbox" id="autoContextToggle" checked />Auto
      </label>
    </div>
    <div class="mode-bar" id="modeBarContainer">
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
    <div class="context-bar" id="contextBar" style="display:none">
      <span class="context-bar-label">Contexto</span>
      <div id="contextFileList" class="context-file-list"></div>
      <span id="contextWeight" class="context-weight"></span>
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
      <div style="display:flex;gap:6px;align-items:center;">
        <span style="font-size:11px;color:var(--muted);">Envío:</span>
        <div style="display:flex;border:1px solid var(--border);border-radius:4px;overflow:hidden;">
          <button type="button" id="modeChat"       style="font-size:11px;padding:2px 8px;border:none;border-radius:0;">💬 Chat</button>
          <button type="button" id="modeSuggest"    style="font-size:11px;padding:2px 8px;border:none;border-radius:0;">🔍 Sugerir</button>
          <button type="button" id="modeDirectEdit" style="font-size:11px;padding:2px 8px;border:none;border-radius:0;">✏️ Editar</button>
        </div>
        <span id="editModeIndicator" style="font-size:11px;color:var(--muted);"></span>
      </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button type="button" id="clear" style="font-size:11px;padding:3px 8px;">Limpiar</button>
        <button type="button" id="stop" style="display:none;font-size:11px;padding:3px 8px;">Detener</button>
        <button type="button" id="selectFilesBtn" style="font-size:11px;padding:3px 8px;" title="Agregar archivos al contexto">📎 Archivos</button>
        <button type="button" id="includeProjectBtn" style="font-size:11px;padding:3px 8px;" title="Incluir proyecto completo">📁 Proyecto</button>
        <span id="adminOptions" style="display:none;margin-left:auto;">
          <button type="button" id="openSettings" style="font-size:11px;padding:3px 8px;">⚙ Admin</button>
        </span>
      </div>
    </div>
    <!-- Panel admin -->
    <div id="adminPanel" style="display:none;position:absolute;top:0;left:0;right:0;bottom:0;background:var(--bg);z-index:20;flex-direction:column;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);font-size:13px;font-weight:bold;background:var(--vscode-sideBarSectionHeader-background,var(--asst-bg));flex-shrink:0;">
        <span>⚙ Panel de Administración</span>
        <button type="button" id="closeAdminPanel" class="btn-icon">✕</button>
      </div>
      <div style="padding:12px;border-bottom:1px solid var(--border);">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">System Prompt institucional</div>
        <div id="promptPreview" style="display:none;background:var(--asst-bg);border:1px solid var(--border);border-radius:4px;padding:8px;font-size:12px;white-space:pre-wrap;margin-bottom:6px;max-height:120px;overflow-y:auto;"></div>
        <textarea id="systemPromptInput" rows="6" style="width:100%;font:inherit;color:var(--fg);background:var(--asst-bg);border:1px solid var(--border);border-radius:4px;padding:6px 8px;resize:vertical;font-size:12px;" placeholder="Escribe el system prompt..."></textarea>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button type="button" id="previewPromptBtn" style="font-size:11px;padding:3px 8px;">Vista previa</button>
          <button type="button" id="savePromptBtn" style="font-size:11px;padding:3px 8px;background:var(--user-bg);color:var(--user-fg);border:none;">Guardar</button>
        </div>
        <div id="promptSaveStatus" style="font-size:11px;margin-top:4px;"></div>
      <div style="padding:12px;border-top:1px solid var(--border);">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">Crear nuevo usuario</div>
        <input type="email" id="newUserEmail" placeholder="correo@uandresbello.edu"
          style="width:100%;padding:6px 8px;font:inherit;color:var(--fg);background:var(--asst-bg);border:1px solid var(--border);border-radius:4px;margin-bottom:6px;" />
        <select id="newUserRole" style="width:100%;margin-bottom:6px;">
          <option value="user">Usuario</option>
          <option value="admin">Administrador</option>
        </select>
        <button type="button" id="createUserBtn"
          style="font-size:11px;padding:3px 10px;background:var(--user-bg);color:var(--user-fg);border:none;">
          Crear cuenta
        </button>
        <div id="createUserResult" style="font-size:11px;margin-top:6px;white-space:pre-wrap;"></div>
      </div>
      </div>
      <div style="padding:12px;">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">Usuarios registrados</div>
        <div id="userTable" style="font-size:12px;">Cargando…</div>
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

    let sendMode = 'chat'; // 'chat' | 'suggest' | 'directEdit'

    function setSendMode(mode) {
      sendMode = mode;
      document.getElementById('modeChat').style.background       = mode === 'chat'       ? 'var(--user-bg)' : '';
      document.getElementById('modeChat').style.color            = mode === 'chat'       ? 'var(--user-fg)' : '';
      document.getElementById('modeSuggest').style.background    = mode === 'suggest'    ? 'var(--green)'   : '';
      document.getElementById('modeSuggest').style.color         = mode === 'suggest'    ? '#000'           : '';
      document.getElementById('modeDirectEdit').style.background = mode === 'directEdit' ? 'var(--warn)'    : '';
      document.getElementById('modeDirectEdit').style.color      = mode === 'directEdit' ? '#000'           : '';
      const indicator = document.getElementById('editModeIndicator');
      indicator.textContent = mode === 'suggest'    ? '🔍 Sugerirá un diff del archivo activo'       :
                              mode === 'directEdit' ? '✏️ Editará el archivo activo directamente' : '';

      // ── NUEVO: ocultar el selector de Modo cuando no aplica ──
      const modeBarContainer = document.getElementById('modeBarContainer');
      modeBarContainer.style.display = mode === 'chat' ? 'flex' : 'none';
    }

    let contextFiles = [];
    const MAX_CONTEXT_CHARS = 12000;

    // ── Login / Registro / Recuperación ────────────────────────
    const loginForm    = document.getElementById('loginForm');
    const forgotForm   = document.getElementById('forgotForm');


    const forgotEmail  = document.getElementById('forgotEmail');
    const forgotBtn    = document.getElementById('forgotBtn');
    const forgotResult = document.getElementById('forgotResult');

    function showLoginForm() {
      loginForm.style.display = 'block';
      forgotForm.style.display = 'none';
    }
    function showForgotForm() {
      loginForm.style.display = 'none';
      forgotForm.style.display = 'block';
      forgotResult.textContent = '';
    }

    function showLogin() {
      loginScreen.style.display = 'flex';
      mainUI.style.display = 'none';
      showLoginForm();
      loginEmail.value = '';
      loginPassword.value = '';
      loginError.style.display = 'none';
    }
    function showMain() {
      loginScreen.style.display = 'none';
      mainUI.style.display = 'flex';
    }

    const changePasswordForm  = document.getElementById('changePasswordForm');
    const currentPasswordEl   = document.getElementById('currentPassword');
    const newPasswordEl       = document.getElementById('newPassword');
    const confirmNewPasswordEl = document.getElementById('confirmNewPassword');
    const changePasswordError = document.getElementById('changePasswordError');
    const changePasswordBtn   = document.getElementById('changePasswordBtn');

    function showChangePasswordForm() {
      loginForm.style.display = 'none';
      forgotForm.style.display = 'none';
      changePasswordForm.style.display = 'block';
      changePasswordError.textContent = '';
    }

    changePasswordBtn.addEventListener('click', () => {
      const current = currentPasswordEl.value;
      const newPwd  = newPasswordEl.value;
      const confirm = confirmNewPasswordEl.value;
      changePasswordError.textContent = '';

      if (newPwd.length < 8) {
        changePasswordError.textContent = 'La nueva contraseña debe tener al menos 8 caracteres.';
        return;
      }
      if (newPwd !== confirm) {
        changePasswordError.textContent = 'Las contraseñas no coinciden.';
        return;
      }
      vscode.postMessage({ type: 'changePassword', currentPassword: current, newPassword: newPwd });
    });

    loginBtn.addEventListener('click', () => {
      loginError.style.display = 'none';
      vscode.postMessage({ type: 'login', email: loginEmail.value.trim(), password: loginPassword.value });
    });
    loginEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginPassword.focus(); });
    loginPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginBtn.click(); });

    document.getElementById('showForgotLink').addEventListener('click', (e) => { e.preventDefault(); showForgotForm(); });
    document.getElementById('backToLoginFromForgot').addEventListener('click', (e) => { e.preventDefault(); showLoginForm(); });


    forgotBtn.addEventListener('click', () => {
      forgotResult.textContent = 'Enviando…';
      vscode.postMessage({ type: 'forgotPassword', email: forgotEmail.value.trim() });
    });

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
    newSessionBtn.addEventListener('click', () => {
      const autoCtx = document.getElementById('autoContextToggle');
      vscode.postMessage({ type: 'newSession', autoContext: autoCtx ? autoCtx.checked : true });
    });
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

    function renderContextBar() {
    const contextBar      = document.getElementById('contextBar');
    const contextFileList = document.getElementById('contextFileList');
    const contextWeight   = document.getElementById('contextWeight');
    contextFileList.innerHTML = '';
    if (contextFiles.length === 0) {
      contextBar.style.display = 'none';
      return;
    }
    contextBar.style.display = 'flex';
    const totalChars = contextFiles.reduce((sum, f) => sum + (f.content?.length || 0), 0);
    const pct = Math.round((totalChars / MAX_CONTEXT_CHARS) * 100);
    contextWeight.textContent = totalChars.toLocaleString() + ' / ' + MAX_CONTEXT_CHARS.toLocaleString() + ' chars (' + pct + '%)';
    contextWeight.className = 'context-weight' + (totalChars > MAX_CONTEXT_CHARS ? ' over' : '');
    for (let i = 0; i < contextFiles.length; i++) {
      const f = contextFiles[i];
      const chip = document.createElement('span');
      chip.className = 'context-chip';
      const name = document.createElement('span');
      name.textContent = f.filename.split('/').pop();
      name.title = f.filename;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'context-chip-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Quitar ' + f.filename;
      removeBtn.addEventListener('click', () => {
        contextFiles.splice(i, 1);
        renderContextBar();
      });
      chip.appendChild(name);
      chip.appendChild(removeBtn);
      contextFileList.appendChild(chip);
    }
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
    
    document.getElementById('openSettings').addEventListener('click', () => {
      document.getElementById('adminPanel').style.display = 'flex';
      vscode.postMessage({ type: 'adminPanelOpened' });
    });
    document.getElementById('closeAdminPanel').addEventListener('click', () => {
      document.getElementById('adminPanel').style.display = 'none';
    });
    document.getElementById('previewPromptBtn').addEventListener('click', () => {
      const preview = document.getElementById('promptPreview');
      const text = document.getElementById('systemPromptInput').value.trim();
      if (!text) return;
      preview.textContent = text;
      preview.style.display = preview.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('savePromptBtn').addEventListener('click', () => {
      const value = document.getElementById('systemPromptInput').value.trim();
      const status = document.getElementById('promptSaveStatus');
      if (!value) return;
      status.textContent = 'Guardando…';
      status.style.color = 'var(--muted)';
      vscode.postMessage({ type: 'saveSystemPrompt', value });
    });

    document.getElementById('selectFilesBtn').addEventListener('click',    () => vscode.postMessage({ type: 'selectFiles' }));
    document.getElementById('includeProjectBtn').addEventListener('click', () => vscode.postMessage({ type: 'includeProject' }));
    document.getElementById('modeChat').addEventListener('click',       () => setSendMode('chat'));
    document.getElementById('modeSuggest').addEventListener('click',    () => setSendMode('suggest'));
    document.getElementById('modeDirectEdit').addEventListener('click', () => setSendMode('directEdit'));
    document.getElementById('createUserBtn').addEventListener('click', () => {
      const email = document.getElementById('newUserEmail').value.trim();
      const role  = document.getElementById('newUserRole').value;
      document.getElementById('createUserResult').textContent = 'Creando…';
      vscode.postMessage({ type: 'createUser', email, role });
    });

    // ── Chat ──────────────────────────────────────────────────
    function scrollBottom() { chatEl.scrollTop = chatEl.scrollHeight; }

    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      appendBubble('user', text);
      inputEl.value = '';
      if (sendMode === 'suggest') {
        vscode.postMessage({ type: 'requestSuggest', text });
      } else if (sendMode === 'directEdit') {
        vscode.postMessage({ type: 'requestEdit', text });
      } else {
        vscode.postMessage({ type: 'ask', text, model: modelEl.value, mode: activeMode });
      }
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
      const parts = []; const re = /\u0060\u0060\u0060([\\w+-]*)\\n?([\\s\\S]*?)\u0060\u0060\u0060/g;
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

    function renderDiff(filename, diffText) {
      const wrapper = document.createElement('div');
      const header = document.createElement('div'); header.className = 'diff-header';
      header.innerHTML = '<span>📄 ' + filename + '</span>';
      const linesDiv = document.createElement('div'); linesDiv.className = 'diff-lines';
      for (const line of diffText.split('\\n')) {
        const div = document.createElement('div');
        if      (line.startsWith('+') && !line.startsWith('+++')) div.className = 'diff-line added';
        else if (line.startsWith('-') && !line.startsWith('---')) div.className = 'diff-line removed';
        else if (line.startsWith('@@'))                           div.className = 'diff-line hunk';
        else                                                       div.className = 'diff-line context';
        div.textContent = line;
        linesDiv.appendChild(div);
      }
      const actions = document.createElement('div'); actions.className = 'diff-actions';
      const applyBtn = document.createElement('button');
      applyBtn.textContent = '✅ Aplicar cambios';
      applyBtn.style.cssText = 'font-size:11px;padding:3px 10px;background:var(--green);color:#000;border:none;';
      applyBtn.addEventListener('click', () => vscode.postMessage({ type: 'applyDiff', diff: diffText }));
      const rejectBtn = document.createElement('button');
      rejectBtn.textContent = '❌ Rechazar';
      rejectBtn.style.cssText = 'font-size:11px;padding:3px 10px;';
      rejectBtn.addEventListener('click', () => wrapper.remove());
      actions.appendChild(applyBtn); actions.appendChild(rejectBtn);
      const block = document.createElement('div'); block.className = 'diff-block';
      block.appendChild(header); block.appendChild(linesDiv);
      wrapper.appendChild(block); wrapper.appendChild(actions);
      const row = document.createElement('div'); row.className = 'row assistant';
      row.appendChild(wrapper); chatEl.appendChild(row); scrollBottom();
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

        case 'filesSelected': {
          const newFiles = m.files || [];
          for (const f of newFiles) {
            if (!contextFiles.find(existing => existing.filename === f.filename)) {
              contextFiles.push(f);
            }
          }
          renderContextBar();
          break;
        }

        case 'projectLoaded':
          appendBubble('assistant', typeof m.count === 'number' ? 'Se cargaron ' + m.count + ' archivo(s) del proyecto.' : 'Proyecto incluido en el contexto.');
          break;

        case 'warning':
          appendBubble('assistant', m.text || 'Advertencia', 'error');
          break;

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

        case 'autoContextLoaded': {
          if (m.count > 0) {
            const names = (m.files || []).slice(0, 3).join(', ');
            const more  = m.count > 3 ? ' y ' + (m.count - 3) + ' más' : '';
            appendBubble('assistant', '📁 Contexto cargado automáticamente: ' + names + more);
          } 
          break;
        }

        case 'adminPanelData': {
          if (m.systemPrompt) document.getElementById('systemPromptInput').value = m.systemPrompt;
          const userTable = document.getElementById('userTable');
          userTable.innerHTML = '';
          const users = m.users || [];
          if (!users.length) { userTable.textContent = 'No hay usuarios.'; break; }
          for (const u of users) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);';
            const email = document.createElement('span');
            email.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
            email.textContent = u.email;
            const role = document.createElement('span');
            role.style.cssText = 'font-size:11px;color:var(--muted);min-width:50px;';
            role.textContent = u.role;
            const btn = document.createElement('button');
            btn.style.cssText = 'font-size:11px;padding:2px 8px;';
            btn.textContent = u.role === 'admin' ? 'Degradar' : 'Promover';
            btn.addEventListener('click', () => {
              vscode.postMessage({ type: 'changeUserRole', userId: u.id, role: u.role === 'admin' ? 'user' : 'admin' });
            });
            row.appendChild(email); row.appendChild(role); row.appendChild(btn);
            userTable.appendChild(row);
          }
          break;
        }

        case 'systemPromptSaved': {
          const status = document.getElementById('promptSaveStatus');
          status.textContent = m.success ? '✅ Guardado.' : '❌ Error al guardar.';
          status.style.color = m.success ? 'var(--green)' : 'var(--err)';
          setTimeout(() => { status.textContent = ''; }, 3000);
          break;
        }

        case 'userRoleChanged': {
          vscode.postMessage({ type: 'adminPanelOpened' });
          break;
        }

        case 'diffResult': {
          renderDiff(m.filename, m.diff);
          break;
        }

        case 'editResult': {
          // Aplica el cambio inmediatamente sin pedir confirmación
          vscode.postMessage({ type: 'applyEdit', newContent: m.newContent });
          break;
        }

        case 'diffApplied': {
          appendBubble('assistant', '✅ Diff aplicado en ' + m.filename + '. Usa Ctrl+Z para deshacer.');
          break;
        }

        case 'editApplied': {
          appendBubble('assistant', '✅ Archivo editado directamente: ' + m.filename + '. Usa Ctrl+Z para deshacer.');
          break;
        }

        case 'forgotPasswordResult': {
          forgotResult.textContent = m.text || '';
          break;
        }

        case 'mustChangePassword': {
          showChangePasswordForm();
          break;
        }

        case 'passwordChanged': {
          // _onLoginSuccess ya fue llamado desde TypeScript
          break;
        }

        case 'changePasswordError': {
          changePasswordError.textContent = m.text || 'Error al cambiar la contraseña.';
          break;
        }

        case 'userCreated': {
        const result = document.getElementById('createUserResult');
        result.style.color = 'var(--green)';
        result.textContent = m.message + '\\n\\nContrase\\u00f1a temporal: ' + m.temp_password + '\\n\\nComp\\u00e1rtela al usuario de forma segura. Deber\\u00e1 cambiarla en su primer login.';
        document.getElementById('newUserEmail').value = '';
        // Recargar tabla de usuarios
        vscode.postMessage({ type: 'adminPanelOpened' });
        break;
      }

      case 'createUserError': {
        const result = document.getElementById('createUserResult');
        result.style.color = 'var(--err)';
        result.textContent = m.text || 'Error al crear usuario.';
        break;
      }

        default: break;
      }
    });

    setMode('analysis');
    setSendMode('chat');
    console.log('HUEMUL SCRIPT LOADED - loginBtn:', document.getElementById('loginBtn'));
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

function _isBinary(content: string): boolean {
  // Detecta archivos binarios verificando caracteres no imprimibles
  for (let i = 0; i < Math.min(content.length, 512); i++) {
    const code = content.charCodeAt(i);
    if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
      return true;
    }
  }
  return false;
}

function getActiveEditorContext(): { filename: string; content: string } | null {
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  if (!doc) {
    return null;
  }
  return {
    filename: vscode.workspace.asRelativePath(doc.uri, false) || doc.fileName,
    content: doc.getText(),
  };
}

function applyUnifiedDiff(original: string, diff: string): string | null {
  try {
    const lines = original.split("\n");
    const diffLines = diff.split("\n");
    const result: string[] = [...lines];
    let offset = 0;
    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i];
      if (line.startsWith("@@")) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (!match) continue;
        const origStart = parseInt(match[1]) - 1;
        let pos = origStart + offset;
        let j = i + 1;
        const toRemove: number[] = [];
        const toAdd: string[] = [];
        while (j < diffLines.length && !diffLines[j].startsWith("@@")) {
          const dl = diffLines[j];
          if (dl.startsWith("-"))      { toRemove.push(pos); pos++; }
          else if (dl.startsWith("+")) { toAdd.push(dl.slice(1)); }
          else                          { pos++; }
          j++;
        }
        for (let k = toRemove.length - 1; k >= 0; k--) {
          result.splice(toRemove[k], 1); offset--;
        }
        result.splice(origStart + offset, 0, ...toAdd);
        offset += toAdd.length;
        i = j - 1;
      }
    }
    return result.join("\n");
  } catch { return null; }
}