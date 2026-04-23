import * as vscode from "vscode";
import { buildPrompt } from "./promptBuilder";
import {
  generateStream,
  generateText,
  listModelNames,
  OllamaError,
} from "./ollamaClient";
import { getOllamaBaseUrl } from "./ollamaSettings";

export class HuemulChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "huemul.chatView";

  private _view: vscode.WebviewView | undefined;
  private _abort: AbortController | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    context: vscode.ExtensionContext
  ) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("huemul")) {
          void this.pushModelsToWebview();
          this.pushCodeColouringToWebview();
        }
      })
    );
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
        case "ready":
        case "refreshModels": {
          await this.pushModelsToWebview();
          this.pushCodeColouringToWebview();
          break;
        }
        case "openSettings": {
          await vscode.commands.executeCommand("huemul.openSettings");
          break;
        }
        case "ask": {
          const text = String(message.text ?? "").trim();
          const model = String(message.model ?? "").trim();
          const useStream = Boolean(message.stream);
          if (!text || !this._view) {
            return;
          }
          if (!model) {
            this.postToWebview({
              type: "error",
              text:
                "No hay modelo seleccionado. Revisa la conexión, pulsa «Actualizar modelos» o instala uno con `ollama pull`.",
            });
            return;
          }
          this._abort?.abort();
          this._abort = new AbortController();

          const { fileLabel, code } = getActiveEditorContext();
          const baseUrl = getOllamaBaseUrl();

          const prompt = buildPrompt({
            filename: fileLabel,
            code,
            message: text,
          });

          this.postToWebview({ type: "loading", value: true });

          try {
            if (useStream) {
              this.postToWebview({ type: "streamStart" });
              await generateStream(
                {
                  baseUrl,
                  model,
                  prompt,
                  stream: true,
                  signal: this._abort.signal,
                },
                (chunk) => {
                  this.postToWebview({ type: "streamToken", text: chunk });
                }
              );
              this.postToWebview({ type: "streamEnd" });
            } else {
              const reply = await generateText({
                baseUrl,
                model,
                prompt,
                stream: false,
                signal: this._abort.signal,
              });
              this.postToWebview({ type: "assistant", text: reply });
            }
          } catch (e) {
            if (e instanceof Error && e.name === "AbortError") {
              this.postToWebview({
                type: "error",
                text: "Generación cancelada.",
              });
            } else if (e instanceof OllamaError) {
              this.postToWebview({ type: "error", text: e.message });
            } else {
              const msg = e instanceof Error ? e.message : String(e);
              this.postToWebview({
                type: "error",
                text: msg || "Error desconocido",
              });
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

  public focus(): void {
    void this._view?.show?.(true);
  }

  private postToWebview(message: unknown): void {
    if (this._view) {
      void this._view.webview.postMessage(message);
    }
  }

  private pushCodeColouringToWebview(): void {
    const enabled = vscode.workspace
      .getConfiguration("huemul")
      .get<boolean>("codeColouring", true);
    this.postToWebview({
      type: "options",
      codeColouring: enabled !== false,
    });
  }

  private async pushModelsToWebview(): Promise<void> {
    const view = this._view;
    if (!view) {
      return;
    }
    const baseUrl = getOllamaBaseUrl();
    try {
      const names = await listModelNames(baseUrl);
      await view.webview.postMessage({
        type: "models",
        names,
        baseUrl,
      });
    } catch (e) {
      const msg =
        e instanceof OllamaError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      await view.webview.postMessage({
        type: "models",
        names: [],
        baseUrl,
        error: msg,
      });
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
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--fg);
      background: var(--bg);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .toolbar label { font-size: 11px; color: var(--muted); white-space: nowrap; }
    select, button {
      font: inherit;
      color: var(--fg);
      background: var(--asst-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 4px 8px;
    }
    button:hover { filter: brightness(1.08); cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .toolbar .grow { flex: 1; min-width: 4px; }
    #chat {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scroll-behavior: smooth;
    }
    .row {
      display: flex;
      width: 100%;
    }
    .row.user { justify-content: flex-end; }
    .row.assistant { justify-content: flex-start; }
    .bubble {
      max-width: 92%;
      padding: 10px 12px;
      border-radius: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble.user {
      background: var(--user-bg);
      color: var(--user-fg);
      border-bottom-right-radius: 4px;
    }
    .bubble.assistant {
      background: var(--asst-bg);
      border: 1px solid var(--border);
      border-bottom-left-radius: 4px;
    }
    .bubble.assistant-rich { white-space: normal; }
    .assistant-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .md-text {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
      color: var(--fg);
    }
    .code-block {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.12));
      overflow: hidden;
    }
    .code-block-summary {
      cursor: pointer;
      list-style: none;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      font-size: 12px;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.15));
      user-select: none;
    }
    .code-block-summary::-webkit-details-marker { display: none; }
    .code-lang {
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--user-bg);
      font-weight: 600;
      text-transform: lowercase;
    }
    .code-meta { color: var(--muted); flex: 1; }
    .code-copy {
      margin-left: auto;
      font-size: 11px;
      padding: 3px 10px;
      flex-shrink: 0;
    }
    .code-copy:hover { filter: brightness(1.1); }
    .code-block-body {
      max-height: min(55vh, 360px);
      overflow: auto;
      border-top: 1px solid var(--border);
    }
    .code-block-body pre {
      margin: 0;
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.45;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .code-block-body code { font-family: inherit; }
    .code-block-body pre code.hljs {
      color: #dcdcdc;
      background: transparent;
    }
    .bubble.error {
      background: var(--asst-bg);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #f14c4c);
      color: var(--vscode-errorForeground, #f88070);
    }
    .input-area {
      border-top: 1px solid var(--border);
      padding: 8px 10px 10px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .input-row { display: flex; gap: 8px; align-items: flex-end; }
    #input {
      flex: 1;
      resize: none;
      min-height: 72px;
      max-height: 200px;
      font: inherit;
      color: var(--fg);
      background: var(--asst-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
    }
    #input:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
    #send {
      height: 36px;
      padding: 0 14px;
      background: var(--user-bg);
      color: var(--user-fg);
      border: none;
    }
    .loading-wrap {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 0 2px;
      color: var(--muted);
      font-size: 12px;
    }
    .loading-wrap.on { display: flex; }
    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--border);
      border-top-color: var(--user-bg);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hint { font-size: 11px; color: var(--muted); padding: 0 2px; }
    label.chk { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: var(--fg); }
    input[type="checkbox"] { accent-color: var(--user-bg); }
    .toolbar--connection {
      border-bottom: 1px solid var(--border);
      background: var(--vscode-sideBarSectionHeader-background, var(--asst-bg));
    }
    .endpoint-line {
      font-size: 11px;
      color: var(--muted);
      font-family: var(--vscode-editor-font-family, monospace);
      max-width: 55%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #modelStatus {
      font-size: 11px;
      flex: 1;
      min-width: 80px;
      color: var(--muted);
    }
    #modelStatus.ok { color: var(--vscode-testing-iconPassed, #89d185); }
    #modelStatus.warn { color: var(--vscode-list-warningForeground, #cca700); }
    #modelStatus.err { color: var(--vscode-errorForeground, #f88070); }
    .btn-ghost { background: transparent; }
  </style>
</head>
<body>
  <div class="toolbar toolbar--connection">
    <span id="endpoint" class="endpoint-line" title="URL base de Ollama">…</span>
    <div class="grow"></div>
    <button type="button" id="openSettings" class="btn-ghost" title="Abrir ajustes (host y puerto)">Ajustes…</button>
    <button type="button" id="refreshModels" title="Volver a cargar modelos desde Ollama">Actualizar modelos</button>
  </div>
  <div class="toolbar">
    <label for="model">Modelo</label>
    <select id="model" title="Modelos instalados en Ollama (según API /api/tags)">
      <option value="">Cargando…</option>
    </select>
    <span id="modelStatus"></span>
    <label class="chk"><input type="checkbox" id="stream" checked /> Streaming</label>
    <div class="grow"></div>
    <button type="button" id="clear" title="Limpiar chat">Limpiar</button>
    <button type="button" id="stop" title="Detener" style="display:none">Detener</button>
  </div>
  <div id="chat" role="log" aria-live="polite"></div>
  <div class="loading-wrap" id="loading">
    <div class="spinner" aria-hidden="true"></div>
    <span>Pensando…</span>
  </div>
  <div class="input-area">
    <div class="hint">Se incluye el archivo activo como contexto (máx. ~3000 caracteres de código).</div>
    <div class="input-row">
      <textarea id="input" placeholder="Escribe tu mensaje…" rows="3"></textarea>
      <button type="button" id="send">Enviar</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const chatEl = document.getElementById('chat');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const clearBtn = document.getElementById('clear');
    const stopBtn = document.getElementById('stop');
    const loadingEl = document.getElementById('loading');
    const modelEl = document.getElementById('model');
    const streamEl = document.getElementById('stream');
    const modelStatusEl = document.getElementById('modelStatus');
    const endpointEl = document.getElementById('endpoint');

    let streamingBubble = null;
    let codeColouringEnabled = true;

    function canonicalHljsLanguage(lang) {
      const raw = String(lang || '').trim().toLowerCase();
      if (!raw || raw === 'text' || raw === 'txt') return null;
      const map = {
        py: 'python',
        python3: 'python',
        py3: 'python',
        ipython: 'python',
        js: 'javascript',
        jsx: 'javascript',
        mjs: 'javascript',
        ts: 'typescript',
        tsx: 'typescript',
        sh: 'bash',
        shell: 'bash',
        zsh: 'bash',
        console: 'bash',
        yml: 'yaml',
        rb: 'ruby',
        rs: 'rust',
        cs: 'csharp',
        cpp: 'cpp',
        'c++': 'cpp',
        cxx: 'cpp',
        go: 'go',
        kt: 'kotlin',
        swift: 'swift',
        docker: 'dockerfile',
        dockerfile: 'dockerfile',
        md: 'markdown',
      };
      return Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : raw;
    }

    function guessFenceLanguage(code) {
      const s = String(code || '');
      if (
        /\\bdef\\s+\\w+\\s*\\(/.test(s) ||
        /\\bclass\\s+\\w+\\b/.test(s) ||
        /^\\s*import\\s+\\w/m.test(s) ||
        /^\\s*from\\s+\\w+\\s+import\\b/m.test(s) ||
        /\\bprint\\(/.test(s) ||
        /\\belif\\b/.test(s) ||
        /\\bexcept\\b/.test(s) ||
        /\\bwhile\\s+[^:]+:/.test(s) ||
        /\\bint\\(input\\(/.test(s) ||
        /\\b\\w+\\s*\\+=\\s*\\d+/.test(s)
      ) {
        return 'python';
      }
      if (
        /\\bfunction\\s*\\(/.test(s) ||
        /\\bconst\\s+\\w+\\s*=/.test(s) ||
        /=>|\\bconsole\\.log\\(/.test(s)
      ) {
        return 'javascript';
      }
      if (/^\\s*#include\\s*[<"]/m.test(s)) {
        return 'cpp';
      }
      if (/^\\s*\\{\\s*[\\r\\n]+\\s*[\"'][^\"']+[\"']\\s*:/m.test(s)) {
        return 'json';
      }
      return null;
    }

    function setCodeBlockLangLabel(codeEl, langId) {
      if (!langId) {
        return;
      }
      const det = codeEl.closest('.code-block');
      const lab = det && det.querySelector('.code-lang');
      if (lab) {
        lab.textContent = String(langId).toLowerCase();
      }
    }

    function splitMarkdownFences(text) {
      const parts = [];
      const re = /\`\`\`([\\w+-]*)\\n?([\\s\\S]*?)\`\`\`/g;
      let last = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) {
          parts.push({ type: 'text', content: text.slice(last, m.index) });
        }
        parts.push({
          type: 'code',
          lang: (m[1] || '').trim() || 'text',
          content: m[2] || '',
        });
        last = re.lastIndex;
      }
      if (last < text.length) {
        parts.push({ type: 'text', content: text.slice(last) });
      }
      if (!parts.length) {
        parts.push({ type: 'text', content: text });
      }
      return parts;
    }

    function buildCodeBlock(lang, rawCode) {
      const code = String(rawCode).replace(/\\n$/, '');
      const lines = code.length ? code.split('\\n') : [];
      const lineCount = lines.length;
      const langNorm = String(lang || 'text').trim().toLowerCase() || 'text';
      const hlLang = canonicalHljsLanguage(langNorm);
      const details = document.createElement('details');
      details.className = 'code-block';
      const summary = document.createElement('summary');
      summary.className = 'code-block-summary';
      const langSpan = document.createElement('span');
      langSpan.className = 'code-lang';
      const provisional = hlLang || (langNorm !== 'text' ? langNorm : '');
      langSpan.textContent = provisional || '…';
      const meta = document.createElement('span');
      meta.className = 'code-meta';
      meta.textContent =
        lineCount === 0
          ? 'vacío'
          : lineCount === 1
            ? '1 línea'
            : lineCount + ' líneas';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'code-copy';
      copyBtn.title = 'Copiar código';
      copyBtn.textContent = 'Copiar';
      copyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const t = copyBtn.textContent;
        navigator.clipboard.writeText(code).then(
          () => {
            copyBtn.textContent = 'Copiado';
            setTimeout(() => {
              copyBtn.textContent = t;
            }, 1600);
          },
          () => {}
        );
      });
      summary.appendChild(langSpan);
      summary.appendChild(meta);
      summary.appendChild(copyBtn);
      const body = document.createElement('div');
      body.className = 'code-block-body';
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      codeEl.textContent = code;
      if (hlLang) {
        codeEl.className = 'language-' + hlLang;
      }
      pre.appendChild(codeEl);
      body.appendChild(pre);
      details.appendChild(summary);
      details.appendChild(body);
      return details;
    }

    function renderAssistantRich(bubble, rawText) {
      bubble.innerHTML = '';
      bubble.classList.add('assistant-rich');
      const body = document.createElement('div');
      body.className = 'assistant-body';
      const parts = splitMarkdownFences(rawText || '');
      for (const p of parts) {
        if (p.type === 'text') {
          if (!p.content) {
            continue;
          }
          const d = document.createElement('div');
          d.className = 'md-text';
          d.textContent = p.content;
          body.appendChild(d);
        } else {
          body.appendChild(buildCodeBlock(p.lang, p.content));
        }
      }
      bubble.appendChild(body);
      function applyCodeBlockLabelsOnly() {
        body.querySelectorAll('pre code').forEach((el) => {
          const raw = el.textContent || '';
          const guess0 = guessFenceLanguage(raw);
          if (el.className && el.className.indexOf('language-') === 0) {
            setCodeBlockLangLabel(el, el.className.replace(/^language-/, ''));
          } else if (guess0) {
            setCodeBlockLangLabel(el, guess0);
          }
        });
      }
      if (
        codeColouringEnabled &&
        typeof hljs !== 'undefined' &&
        hljs.highlight
      ) {
        const autoLangs = [
          'python', 'javascript', 'typescript', 'bash', 'json', 'yaml',
          'html', 'xml', 'css', 'markdown', 'sql', 'go', 'rust', 'java', 'cpp',
          'c', 'csharp', 'php', 'ruby', 'toml', 'dockerfile', 'ini',
        ];
        body.querySelectorAll('pre code').forEach((el) => {
          delete el.dataset.highlighted;
          const raw = el.textContent || '';
          const guess0 = guessFenceLanguage(raw);
          let usedLang = null;
          try {
            if (el.className && el.className.indexOf('language-') === 0) {
              hljs.highlightElement(el);
              usedLang = (el.result && el.result.language) || null;
            } else {
              if (guess0 && hljs.getLanguage(guess0)) {
                const r = hljs.highlight(raw, {
                  language: guess0,
                  ignoreIllegals: true,
                });
                el.innerHTML = r.value;
                el.className = 'hljs';
                el.dataset.highlighted = 'yes';
                usedLang = r.language || guess0;
              } else {
                const r = hljs.highlightAuto(raw, autoLangs);
                el.innerHTML = r.value;
                el.className = 'hljs';
                el.dataset.highlighted = 'yes';
                usedLang = r.language;
                if (
                  (usedLang === 'plaintext' || (r.relevance || 0) < 3) &&
                  guess0 &&
                  hljs.getLanguage(guess0)
                ) {
                  const r2 = hljs.highlight(raw, {
                    language: guess0,
                    ignoreIllegals: true,
                  });
                  el.innerHTML = r2.value;
                  el.className = 'hljs';
                  usedLang = r2.language || guess0;
                }
              }
            }
          } catch (err) {
            try {
              if (guess0 && hljs.getLanguage(guess0)) {
                const r = hljs.highlight(raw, {
                  language: guess0,
                  ignoreIllegals: true,
                });
                el.innerHTML = r.value;
                el.className = 'hljs';
                el.dataset.highlighted = 'yes';
                usedLang = r.language || guess0;
              } else {
                const r = hljs.highlightAuto(raw, autoLangs);
                el.innerHTML = r.value;
                el.className = 'hljs';
                el.dataset.highlighted = 'yes';
                usedLang = r.language;
              }
            } catch (e2) {
              usedLang = null;
            }
          }
          if (usedLang && usedLang !== 'plaintext') {
            setCodeBlockLangLabel(el, usedLang);
          } else if (guess0) {
            setCodeBlockLangLabel(el, guess0);
          }
        });
      } else {
        applyCodeBlockLabelsOnly();
      }
    }

    function setModelOptions(names, baseUrl, errorText) {
      endpointEl.textContent = baseUrl || '';
      modelEl.innerHTML = '';
      modelStatusEl.className = '';
      if (errorText) {
        modelStatusEl.textContent = errorText;
        modelStatusEl.className = 'err';
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '(error de conexión)';
        modelEl.appendChild(o);
        return;
      }
      if (!names || !names.length) {
        modelStatusEl.textContent = 'Ningún modelo en este servidor (usa ollama pull)';
        modelStatusEl.className = 'warn';
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '(sin modelos)';
        modelEl.appendChild(o);
        return;
      }
      modelStatusEl.textContent = names.length + ' modelo(s)';
      modelStatusEl.className = 'ok';
      for (const n of names) {
        const o = document.createElement('option');
        o.value = n;
        o.textContent = n;
        modelEl.appendChild(o);
      }
      modelEl.selectedIndex = 0;
    }

    function scrollBottom() {
      chatEl.scrollTop = chatEl.scrollHeight;
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

    function setLoading(on) {
      loadingEl.classList.toggle('on', on);
      sendBtn.disabled = on;
      stopBtn.style.display = on ? 'inline-block' : 'none';
      inputEl.disabled = on;
    }

    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      appendBubble('user', text);
      inputEl.value = '';
      vscode.postMessage({
        type: 'ask',
        text,
        model: modelEl.value,
        stream: streamEl.checked,
      });
    }

    sendBtn.addEventListener('click', send);
    clearBtn.addEventListener('click', () => {
      chatEl.innerHTML = '';
      streamingBubble = null;
    });
    stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    document.getElementById('refreshModels').addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshModels' });
    });
    document.getElementById('openSettings').addEventListener('click', () => {
      vscode.postMessage({ type: 'openSettings' });
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    window.addEventListener('message', (event) => {
      const m = event.data;
      if (!m || typeof m.type !== 'string') return;
      switch (m.type) {
        case 'options':
          codeColouringEnabled = m.codeColouring !== false;
          break;
        case 'models':
          setModelOptions(m.names || [], m.baseUrl || '', m.error || '');
          break;
        case 'loading':
          setLoading(!!m.value);
          break;
        case 'assistant':
          appendBubble('assistant', m.text || '');
          streamingBubble = null;
          break;
        case 'streamStart':
          {
            const row = document.createElement('div');
            row.className = 'row assistant';
            const bubble = document.createElement('div');
            bubble.className = 'bubble assistant';
            bubble.textContent = '';
            row.appendChild(bubble);
            chatEl.appendChild(row);
            streamingBubble = bubble;
            scrollBottom();
          }
          break;
        case 'streamToken':
          if (streamingBubble) {
            streamingBubble.textContent += m.text || '';
          }
          scrollBottom();
          break;
        case 'streamEnd':
          if (streamingBubble) {
            const full = streamingBubble.textContent;
            renderAssistantRich(streamingBubble, full);
            scrollBottom();
          }
          streamingBubble = null;
          break;
        case 'error':
          if (streamingBubble && streamingBubble.textContent === '') {
            streamingBubble.closest('.row')?.remove();
          }
          appendBubble('assistant', m.text || 'Error', 'error');
          streamingBubble = null;
          break;
        default:
          break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getActiveEditorContext(): { fileLabel: string; code: string } {
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  if (!doc) {
    return {
      fileLabel: "(sin archivo activo)",
      code: "",
    };
  }
  return {
    fileLabel: vscode.workspace.asRelativePath(doc.uri, false) || doc.fileName,
    code: doc.getText(),
  };
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
