
# WA Scheduler Pro

WA Scheduler Pro es una herramienta local para agendar envíos por WhatsApp Web, mantener una sesión de navegador persistente, cerrar el navegador cuando está inactivo y configurar autorespuestas automáticas.

# Dedicatoria
Este software es un regalo de cumpleaños para un amigo. ¡Feliz cumpleaños MC!

## Características principales

- Agendado de mensajes a contactos o grupos (texto y multimedia).
- Autorespuestas por palabra clave.
- Autorespuesta global (responde a cualquier mensaje si no hay coincidencia específica).
- Sesión de navegador persistente con perfil local.
- Cierre automático del navegador cuando no hay envíos próximos.

## Requisitos

- Node.js 16+ (o la versión usada por el proyecto)
- Navegador/Playwright (se usa Chromium via Playwright)

## Instalación

1. Clona el repositorio y entra al directorio:

```bash
git clone <repo>
cd wa-scheduler-pro
```

2. Instala dependencias:

```bash
npm install
```

3. Inicia la aplicación:

```bash
npm start
```

4. Opcional:
```bash
npm run start:bg
```

Luego abre la interfaz en tu navegador: http://localhost:3030

## Uso rápido (UI)

- Nuevo envío: completá destinatarios (uno por línea o separados por coma/punto y coma), programá fecha/hora, opcionalmente adjuntá multimedia, y guardá.
- Autorespuestas: en la sección "Autorespuestas por palabra clave" podés:
  - Crear reglas por palabra clave (match `contains`, `word`, `exact`).
  - Crear una regla global marcando "Responder a CUALQUIER mensaje (regla global)"; en este caso no hace falta ingresar palabras clave.
  - Las reglas específicas (con palabras clave) tienen prioridad sobre la regla global.

## API (endpoints relevantes)

- GET `/api/status` — estado de la app y del auto-responder.
- GET `/api/autoreplies` — listar reglas de autorespuesta.
- POST `/api/autoreplies` — crear regla. Campos aceptados (form-data):
  - `isGlobal` (checkbox): si está presente, la regla será global.
  - `keywords`: lista de palabras/claves (si no es global).
  - `matchMode`: `contains` | `word` | `exact`.
  - `responseText`: texto de respuesta.
  - `media`: archivo adjunto (opcional).

Ejemplo curl para crear regla global:

```bash
curl -X POST http://localhost:3030/api/autoreplies \
  -F "isGlobal=on" \
  -F "responseText=Hola! Gracias por tu mensaje; te contestaré pronto."
```

## Comportamiento del auto-responder

- El servicio monitorea el panel lateral de WhatsApp Web para mensajes no leídos.
- Si un mensaje nuevo coincide con alguna regla específica, envía la respuesta de esa regla.
- Si no hay coincidencia específica y existe una regla global activa, se envía la respuesta global.
- Para evitar duplicados, el sistema marca cuándo ya envió una autorespuesta a una combinación (`chat|rule|preview`).

## Configuración

Los ajustes se guardan en `data/settings.json`. Opciones importantes:

- `autoResponderEnabled`: activa/desactiva autorespuestas.
- `autoResponderPollSeconds`: intervalo de escaneo.
- `closeBrowserWhenIdle`: si `true`, cierra el navegador cuando no hay envíos próximos.

## Archivos relevantes

- `src/whatsapp.js` — controlador principal de WhatsApp y lógica de autorespuesta.
- `src/storage.js` — persistencia de jobs, reglas y eventos (archivos JSON en `data/`).
- `src/index.js` — API HTTP y arranque del scheduler.
- `public/` — UI estática (formulario y paneles).

## Resolución de problemas

- Si la app no inicia, verificá que el puerto `3030` no esté en uso.
- Si el auto-responder no detecta mensajes, asegurate de que WhatsApp Web esté abierto y con sesión iniciada en el perfil del navegador (la app puede abrir Chromium automáticamente si hay envíos próximos).

## Contribuciones

Pull requests y issues son bienvenidos. Mantener consistencia con el estilo existente y probar cambios en entorno local.

## Persistencia

No borrar estas carpetas/archivos si querés conservar el sistema:

```text
data/browser-profile/       sesión de WhatsApp Web
data/jobs.json              agenda de envíos
data/events.json            registro técnico
data/autoreplies.json       reglas de autorespuesta
data/autoreply-sent.json    control para no responder dos veces lo mismo
data/media/                 multimedia y adjuntos
```

## Comportamiento del navegador

- Para envíos agendados, se abre automáticamente 1 minuto antes.
- Al terminar, se cierra si no hay otro envío dentro del próximo minuto.
- Si activás autorespuestas, el navegador debe quedar abierto para detectar mensajes entrantes. Esto puede marcar chats como leídos, porque WhatsApp Web necesita abrir la conversación para leer el último mensaje.

## Autorespuestas

Podés crear reglas con varias palabras clave. Modos:

- `contains`: el mensaje contiene la palabra o frase.
- `word`: coincide como palabra completa.
- `exact`: el mensaje completo debe ser exactamente igual.

La respuesta puede tener:

- solo texto;
- solo archivo/foto/video;
- archivo/foto/video + texto enviado después.

## Limitación real

Esto automatiza WhatsApp Web. No es WhatsApp Business API ni una integración oficial de Meta. WhatsApp puede cambiar la interfaz y romper selectores. Los logs en `data/events.json` ayudan a corregir rápido.
