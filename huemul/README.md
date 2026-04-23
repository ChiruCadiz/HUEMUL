# Huemul

Asistente de código con IA local en VS Code: conversa con un modelo vía [Ollama](https://ollama.com) sin backend propio.

## Conexión y modelos

En **Ajustes** de VS Code / Cursor busca **Huemul** (o ejecuta el comando **Huemul: Ajustes de conexión Ollama**):

- **Huemul: Host de Ollama** — dirección sin `http://` ni puerto (por defecto `127.0.0.1`; en Docker a veces `host.docker.internal`).
- **Huemul: Puerto de Ollama** — por defecto `11434`.
- **Huemul: Code colouring** — activa o desactiva el resaltado de sintaxis (Highlight.js) en los bloques de código del chat.

La URL resultante es `http://<host>:<puerto>`. El panel del chat llama a `GET /api/tags` para rellenar el desplegable con los modelos **que ya tengas** en ese servidor (`ollama list`). Tras cambiar host o puerto, el panel vuelve a cargar la lista; también puedes usar **Actualizar modelos**.

## Requisitos

- VS Code 1.85 o superior (o Cursor compatible con extensiones VS Code)
- [Ollama](https://ollama.com) instalado y en ejecución
- Al menos un modelo descargado (`ollama pull <nombre>`); el selector solo muestra lo instalado en tu instancia

## Desarrollo: ejecutar con F5

1. Abre esta carpeta en VS Code.
2. Ejecuta `npm install` (una vez).
3. Menú **Run → Start Debugging** o tecla **F5**.
4. Se abre una ventana “Extension Development Host”.
5. En esa ventana:
   - **Command Palette** (`Cmd+Shift+P` / `Ctrl+Shift+P`) → **Huemul: Open Chat**, o
   - Icono **Huemul** en la barra de actividad → panel **Chat**.

La tarea por defecto usa `npm run watch` para recompilar al guardar.

## Instalar Ollama

- **macOS / Linux / Windows:** instrucciones oficiales en [https://ollama.com/download](https://ollama.com/download).
- Tras instalar, comprueba que responde:

```bash
ollama serve
# En otra terminal:
ollama pull codellama
ollama run codellama "hola"
```

## Probar la extensión

1. Arranca Ollama y descarga al menos un modelo (`ollama pull ...`); confirma con `ollama list`.
2. Abre un archivo de código en el editor (el contenido se envía como contexto, recortado a ~3000 caracteres).
3. Abre el chat de Huemul y envía un mensaje.
4. Activa o desactiva **Streaming** según prefieras token a token o respuesta completa.
5. Usa **Limpiar** para vaciar el historial visual.

Si Ollama no está en marcha, verás un mensaje de error amigable en el panel.

## Empaquetar `.vsix` (opcional)

```bash
npm install -g @vscode/vsce
npm run compile
vsce package
```

Instala el `.vsix` con **Extensions → … → Install from VSIX…**.

## Estructura

- `src/extension.ts` — activación y comandos
- `src/chatProvider.ts` — webview del chat (HTML/CSS/JS)
- `src/ollamaClient.ts` — `POST /api/generate` (texto y streaming)
- `src/promptBuilder.ts` — prompt con archivo + mensaje
