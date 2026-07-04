# 🦚 Huemul — VS Code Extension

> Asistente de IA integrado en Visual Studio Code para la Universidad Andrés Bello.

[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)
[![UNAB](https://img.shields.io/badge/Universidad-Andrés%20Bello-004A97)](https://www.unab.cl/)

---

## 📋 Descripción

Huemul es una extensión de VS Code que integra modelos de lenguaje directamente en el editor, permitiendo a estudiantes y docentes de UNAB analizar, sugerir mejoras y editar código con IA sin salir del entorno de desarrollo.

### Características principales

- 💬 **Chat contextual** — Conversa con el modelo sobre el archivo activo
- 🔍 **Modo Sugerir** — Genera un diff unificado con cambios propuestos
- ✏️ **Edición directa** — Edita el archivo activo en tiempo real
- 📁 **Contexto de proyecto** — Carga automática de archivos del workspace
- 🗂️ **Sesiones persistentes** — Historial guardado en el servidor
- 🔐 **Autenticación institucional** — Sistema de cuentas gestionado por admin

---

## 🏗️ Arquitectura

```
┌─────────────────────────────────────────┐
│           VS Code Extension             │
│                                         │
│  ┌─────────────┐    ┌────────────────┐  │
│  │ Extension   │    │    Webview     │  │
│  │   Host      │◄──►│  (HTML/JS/CSS) │  │
│  │ (TypeScript)│    │                │  │
│  └──────┬──────┘    └────────────────┘  │
└─────────┼───────────────────────────────┘
          │ HTTP / SSE
          ▼
┌─────────────────────┐
│   Huemul Backend    │
│   (FastAPI + AWS)   │
└─────────────────────┘
```

### Archivos principales

```
src/
├── extension.ts          # Punto de entrada, registro de comandos
├── chatProvider.ts       # WebviewViewProvider principal
├── huemulClient.ts       # Cliente HTTP para el backend
└── ollamaClient.ts       # Cliente Ollama (legacy)
```

---

## 🚀 Instalación y desarrollo local

### Requisitos previos

- [Node.js](https://nodejs.org/) 18+
- [VS Code](https://code.visualstudio.com/) 1.80+
- [Git](https://git-scm.com/)
- Backend de Huemul corriendo (ver [huemul-backend](https://github.com/ChiruCadiz/huemul-backend))

### Clonar el repositorio

```bash
git clone https://github.com/ChiruCadiz/HUEMUL.git
cd HUEMUL
```

### Instalar dependencias

```bash
npm install
```

### Configurar el backend

En `src/chatProvider.ts`, verifica que `BACKEND_URL` apunte a tu instancia del backend:

```typescript
// Para desarrollo local:
const BACKEND_URL = "http://localhost:8000";

// Para producción:
const BACKEND_URL = "http://tu-servidor-aws";
```

### Compilar

```bash
# Compilar una vez
npx tsc

# Compilar en modo watch (recompila automáticamente)
npx tsc --watch
```

### Ejecutar en modo desarrollo

1. Abre el proyecto en VS Code
2. Presiona **F5** para abrir una ventana de extensión de prueba
3. En la nueva ventana, busca el panel **"HUEMUL: CHAT"** en la barra lateral

---

## 🛠️ Uso

### Primer login

1. Al abrir el panel de Huemul, verás el formulario de login
2. Ingresa tus credenciales institucionales (creadas por el administrador)
3. Si es tu primer acceso, deberás cambiar la contraseña temporal

### Modos de envío

| Modo | Descripción |
|------|-------------|
| 💬 **Chat** | Conversación libre sobre el código activo |
| 🔍 **Sugerir** | Genera un diff con mejoras propuestas |
| ✏️ **Editar** | Edita el archivo directamente con IA |

### Gestión de sesiones

- Crea sesiones con el botón **＋** para organizar conversaciones por proyecto
- El historial se carga automáticamente al cambiar de sesión
- Activa **Auto** para cargar el contexto del proyecto al crear una sesión

### Panel de administración

Los usuarios con rol `admin` tienen acceso al panel **⚙ Admin** donde pueden:
- Crear nuevas cuentas de usuario
- Cambiar roles (usuario/admin)
- Configurar el system prompt institucional

---

## 📦 Estructura del proyecto

```
HUEMUL/
├── src/
│   ├── extension.ts          # Activación y comandos
│   ├── chatProvider.ts       # UI principal (Webview)
│   ├── huemulClient.ts       # API client
│   └── ollamaClient.ts       # Cliente Ollama
├── media/
│   ├── highlight.min.js      # Syntax highlighting
│   └── hl-theme.css          # Tema para código
├── out/                      # Compilado TypeScript (generado)
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🔧 Configuración avanzada

### tsconfig.json

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "outDir": "out",
    "rootDir": "src",
    "strict": true
  }
}
```

### Notas importantes para desarrollo

> ⚠️ **Template literals en Webview**: Todo JS dentro del template literal de `_getHtmlForWebview` requiere:
> - `\\n` en lugar de `\n` para saltos de línea en strings
> - `\u0060` en lugar de backticks en expresiones regulares
> - `\\uXXXX` para caracteres especiales como ñ, á, é

---

## 🤝 Contribución

1. Haz fork del repositorio
2. Crea una rama para tu feature:
   ```bash
   git checkout -b feature/nueva-funcionalidad
   ```
3. Realiza tus cambios y compila:
   ```bash
   npx tsc --noEmit  # Verificar sin compilar
   npx tsc           # Compilar
   ```
4. Haz commit con un mensaje descriptivo:
   ```bash
   git commit -m "feat: agregar modo de edición por bloques"
   ```
5. Abre un Pull Request hacia la rama `develop`

---

## 📄 Licencia

MIT © 2026 Chiru Sage Vega Cádiz — Universidad Andrés Bello

---

## 👥 Equipo

| Nombre | Rol |
|--------|-----|
| Chiru Sage Vega Cádiz | Desarrollador Full-Stack |
| Matías Vargas Marín | Profesor Guía |

---

<p align="center">
  Desarrollado con ❤️ en la Universidad Andrés Bello · Santiago, Chile
</p>
