# RelayDeck v1.0

> **Consola local de mandos para probar, diagnosticar y conmutar APIs de IA en Codex CLI y Claude Code.**  
> *Desarrollado por NextKool — 2026.*

---

**RelayDeck** resuelve el problema de conectar múltiples proveedores de IA (OpenAI, Anthropic, DeepSeek, Qwen, relays y gateways) con tus terminales de desarrollo:

- **Cero dependencias externas:** Corre 100% en Node.js nativo (Node 20+).
- **Seguridad local total:** Escucha estrictamente en `127.0.0.1` con validación de cabeceras Host y CSP.
- **Traductor SSE en tiempo real:** Puente local transparente para proveedores que solo admiten Chat Completions frente a Codex CLI.
- **Edición AST-Safe:** Modifica `~/.codex/config.toml` y `~/.claude/settings.json` con respaldos automáticos sin corromper comentarios ni secciones ajenas.
- **Diagnóstico tri-protocolo:** Clasificación precisa entre `/v1/responses`, `/v1/chat/completions` y `/v1/messages`.
- **Chat de pruebas integrado:** Verificación en vivo con latencia, botón de cancelación inmediata y monitor de saturación.

## Arrancar

```bash
# Entrar a la carpeta del proyecto
cd RelayDeck
node server.js
# -> http://127.0.0.1:7788
```

Otro puerto: `RELAYDECK_PORT=9000 node server.js`

## El panel

Una sola pantalla, dos columnas. Arriba, tus APIs como pestañas: se cambia de una a otra con un
clic y siempre se ve cual esta seleccionada.

| Panel | Que hay |
|---|---|
| **Estado** | veredicto grande (FUNCIONA / SOLO CHAT / KEY INVALIDA...), modelo, saldo, y los botones Probar, Cargar modelos, Editar, Borrar |
| **Modelos de X** | buscador, filtros, y probar los modelos que **tu** elijas (uno, una seleccion, o todos) |
| **Usar en** | las instrucciones exactas, con pestañas: **Codex CLI**, **Claude Code**, **Probar a mano** |

Lo tecnico (diagnostico, TOML generado) esta plegado. Se abre solo si lo pides.

## Como se usa una API despues de probarla

### Codex CLI

El panel escribe el proveedor en `config.toml` **como activo**, asi que no hay perfiles ni
`--profile`. Dos comandos:

```bat
set CODEX_KEY=sk-tu-key-aqui
codex
```

`set` afecta solo a esa terminal y no toca nada del sistema. Cada terminal nueva necesita el `set`
otra vez. En Linux/macOS el panel muestra `export` en su lugar.

La variable se llama **siempre** `CODEX_KEY`, para cualquier proveedor: si cambias de API, el
comando es el mismo y solo cambia la key.

### Claude Code

Claude Code no lee `config.toml`. El panel da las dos formas:

- **Solo esta terminal**: `set ANTHROPIC_BASE_URL=...`, `set ANTHROPIC_AUTH_TOKEN=...`,
  `set ANTHROPIC_MODEL=...`, y despues `claude`.
- **Fijo**: el bloque `env` en `%USERPROFILE%\.claude\settings.json` (o `~/.claude/settings.json`).
  El panel te lo muestra ya relleno y, si quieres, **lo escribe por ti** con respaldo previo.

Si tu relay te dio una "api key" en vez de un "bearer token", usa `ANTHROPIC_API_KEY` en lugar de
`ANTHROPIC_AUTH_TOKEN`. Dentro de Claude Code, `/status` dice que base URL esta usando.

## Como toca tu config.toml

**Lo lee y lo edita. No hace append.** Esto fue un bug grave: al pegar bloques al final, si ya
tenias `model = "..."` escrito a mano o un `[model_providers.x]` propio, el archivo acababa con la
**misma clave dos veces**. En TOML eso no es "gana el ultimo": es un **error de parseo**, y Codex
se niega a arrancar.

Ahora `toml-edit.js` entiende la estructura del archivo — que tablas hay, que claves tiene cada
una y en que lineas — y edita en su sitio:

- si la clave ya existe, **reemplaza esa linea**;
- si no existe, la anade al final de **su** tabla;
- **respeta todo lo tuyo**: comentarios, orden, `[mcp_servers.*]`, `[profiles.*]`, otros
  proveedores y cualquier clave que el panel no gestione;
- entiende cadenas multilinea (`"""`), arrays de varias lineas y tablas inline, asi que un `#` o un
  `[` dentro de un texto no lo despistan;
- **antes de escribir valida el resultado**. Si fuese a quedar invalido, aborta y no toca el archivo.

### Tu eliges, el panel no decide

Panel **Ajustes de Codex**, por proveedor. Los valores son los de la referencia oficial de Codex:

| Ajuste | Opciones |
|---|---|
| Nivel de razonamiento (`model_reasoning_effort`) | `minimal` · `low` · `medium` · `high` · `xhigh` |
| Aprobaciones (`approval_policy`) | `untrusted` · `on-request` · `never` |
| Sandbox (`sandbox_mode`) | `read-only` · `workspace-write` · `danger-full-access` |
| Variable de la key (`env_key`) | la que quieras |

Los tres selectores tienen la opcion **— no escribir —**: con ella el panel **no toca esa clave**.
Si ya estaba en tu archivo se queda como esta; para borrarla, usa el editor.

El nivel de razonamiento sale en **— no escribir —**. Las aprobaciones y el sandbox no: un proveedor
nuevo nace con `on-request` y `workspace-write`, que son valores seguros, y esos si se escriben.
Si no quieres que el panel los toque, ponlos en **— no escribir —** y guarda.

`on-failure` no se ofrece porque Codex lo tiene deprecado.

`wire_api` no es una opcion: el panel escribe siempre `responses`, que es lo unico que Codex CLI
soporta. Si el relay solo habla Chat Completions, la solucion es el puente, no cambiar esta clave.

Los reintentos y timeouts (`request_max_retries`, `stream_max_retries`,
`stream_idle_timeout_ms`) tampoco se configuran: el panel **nunca** los escribe y los quita de
`config.toml` si los encuentra, porque los escribia una version anterior.

Con esto el panel solo escribe, como minimo, `model` y `model_provider` en la raiz y
`name` / `base_url` / `env_key` / `wire_api` en el bloque del proveedor. Nada mas si tu no lo pides.

### Editar los archivos desde el panel

Columna derecha, pestaña **Editar archivos**. Sin abrir el explorador:

- `~/.codex/config.toml`
- `~/.claude/settings.json` (el de Claude Code)
- el archivo de la key del panel (`env.cmd` en Windows, `env.sh` en el resto)

Se edita en un cuadro de texto y **se valida mientras escribes**: si el TOML tiene claves duplicadas
o el JSON esta mal, el aviso sale al instante y el boton **Guardar** queda desactivado. No se escribe
nada invalido. Al guardar se hace respaldo con fecha.

Solo esos tres archivos: no hay rutas libres.

### Valido no es lo mismo que limpio

El panel distingue dos cosas:

- **Errores** que rompen a Codex: claves o tablas duplicadas, claves de raiz atrapadas dentro de un
  `[model_providers.*]`. Se reparan con **Reparar config.toml**.
- **Avisos** de higiene: cosas validas que solo estorban. Por ejemplo dos bloques con **ids
  distintos apuntando al mismo relay** (`blueminds` y `bluesminds`: pasa al registrar la API dos
  veces con el nombre algo cambiado), bloques que el panel ya no gestiona, o reintentos que escribio
  una version anterior. Se quitan con **Limpiar**, que te dice exactamente que va a borrar y
  **nunca toca el proveedor activo** ni tus otras secciones.

### Las instrucciones salen del archivo, no de una suposicion

El comando `set ...` usa el `env_key` que hay **escrito de verdad** en tu `config.toml`. Si ahi pone
`BLUESMINDS_API_KEY` porque lo escribio una version anterior, la instruccion dice esa variable — y
te avisa de que al reinstalar pasara a llamarse `CODEX_KEY`. Antes el panel daba por hecho el
nombre y podia decirte una variable que Codex no miraba.

### El panel te ensena lo que hay

En **Tu config.toml** (columna izquierda) ves lo leido de verdad: que proveedor esta activo, con
que modelo, que proveedores ya tenias, y que otras secciones tuyas hay. Con **Ver que cambiaria al
instalar** sale el diff exacto, clave por clave, antes de escribir nada.

### Repara lo que quedo roto

Si tu `config.toml` ya esta dañado por las versiones anteriores del panel, se detecta y se avisa al
abrir. **Reparar config.toml** funde las tablas repetidas, deja una sola copia de cada clave (gana
la ultima) y rescata las claves de raiz que quedaron atrapadas dentro de un `[model_providers.*]`
—donde no son validas— devolviendolas a la raiz. Con respaldo previo y sin cambiar tu proveedor
activo.

### Un solo archivo, siempre

- **Cambiar de modelo** con el proveedor instalado: se reescribe esa clave del mismo
  `config.toml`. No aparecen archivos nuevos.
- **Cambiar de proveedor**: se reescriben las claves de la raiz. Los bloques de los otros
  proveedores se quedan, pero solo uno esta activo.
- Los respaldos `config.toml.<fecha>.bak` se limitan a los **5 ultimos**.
- Las versiones viejas dejaban un `<perfil>.config.toml` por proveedor: al instalar se limpian.

## Repetir la misma API

Si intentas agregar una API que apunta al **mismo relay** que otra que ya tienes (aunque escribas
la URL distinta: barra final, mayusculas, http/https), el panel **no la crea**. Avisa de que las
dos escribirian en `config.toml` y ofrece: abrir la que ya tienes, crear otra igual, o cancelar.

## Que hace el test

Por debajo, "Probar API" es bastante mas que un ping:

1. **Se presenta como Codex CLI.** Muchos relays filtran por huella de cliente y devuelven
   `401 unauthorized client detected` a cualquier peticion que no parezca un SDK oficial. El panel
   manda el set completo de cabeceras de Codex (`originator`, `session_id`, `x-client-request-id`,
   `x-codex-installation-id`, `prompt_cache_key`, User-Agent con la version de tu Codex) y, si le
   rechazan, reintenta como openai-node y openai-python.
2. **Prueba `/v1/responses` en streaming**, con `stream:true` y SSE, que es lo que Codex hace de
   verdad. Corta en el primer evento valido para no gastar tokens.
3. **Encuentra un modelo que sirva.** Pregunta al relay que modelos declara compatibles
   (`/api/pricing`, `/api/models` de new-api) y, si no hay metadatos, barre el catalogo. Un 404 sin
   mensaje no cierra el caso: puede ser ese modelo y no el endpoint.
4. **Distingue el tipo de fallo**: key revocada, cliente bloqueado, modelo sin canal, cuota
   agotada, modelo retirado (410), relay lento o con limite de ritmo.
5. **Lee el saldo** si el relay lo expone (endpoints legacy, `credit_grants`, o `/api/user/self`).

## Protocolos y compatibilidad

El panel diferencia tres protocolos de comunicación:

1. **Responses API (`/v1/responses`)**: Protocolo nativo requerido por Codex CLI (`codex_ready`). Soporta streaming SSE, metadatos y tool calls con el esquema de Codex.
2. **Chat Completions (`/v1/chat/completions`)**: Protocolo clásico de OpenAI. Si el relay solo soporta este endpoint (`chat_only` o `no_responses`), el panel activa automáticamente el **puente traductor** (`bridge.js`) para que Codex CLI funcione.
3. **Anthropic Messages (`/v1/messages`)**: Protocolo requerido directamente por Claude Code. Si un proveedor solo responde a este protocolo (`claude_only`), puede usarse directamente con Claude Code, pero no con Codex CLI.

## Traductor Chat → Responses (`bridge.js`)

Codex solo habla la Responses API. Si tu relay solo expone `/v1/chat/completions`, el panel levanta
un puente local: Codex le habla Responses y el puente traduce a Chat.

```bash
BRIDGE_UPSTREAM=https://relay.tld/v1 BRIDGE_API_KEY=sk-... \
  BRIDGE_MODEL=tu-modelo BRIDGE_PORT=7789 node bridge.js
```

Traduce mensajes, historial, tool calls (reensamblando los argumentos troceados) y usage, en los
dos sentidos. Las herramientas nativas que no son funciones (`web_search`) no se pueden traducir y
se descartan.

Para Claude Code directo, el relay debe implementar el protocolo Anthropic (`/v1/messages`); el puente de Chat no se usa para Claude Code.

## Seguridad y almacenamiento de claves

- Las API keys se guardan en **texto plano** en el almacenamiento local del usuario (`~/.relaydeck/providers.json` o `~/.codex-panel/providers.json` por compatibilidad, y `env.sh` / `env.cmd`). En Linux y macOS los archivos quedan con permisos `600` y el directorio con `700`. En Windows esos permisos no aplican de forma POSIX: la protección es la del perfil de usuario del sistema operativo.
- El panel se ejecuta exclusivamente en local (`127.0.0.1`), valida las cabeceras `Host` y `Origin`, y no envía credenciales a ningún servidor de telemetría o terceros.
- `GET /api/state` devuelve las keys en claro para poder rellenar el formulario, y el panel **no tiene token de sesion**: cualquier proceso que corra con tu usuario local puede leerlas. Es una consola local de desarrollo, no un servicio compartido multiusuario.
- Un proveedor nuevo se instala con `approval_policy = "on-request"` y `sandbox_mode = "workspace-write"`. Son los valores por defecto recomendados, y se pueden dejar en **— no escribir —** para que no altere tu archivo.
- Estos relays ven **todos** tus prompts: no los uses con código confidencial ni repositorios con secretos.

## Variables de entorno del panel

| Variable | Default | Descripción |
|---|---|---|
| `RELAYDECK_PORT` / `CODEX_PANEL_PORT` | `7788` | Puerto HTTP del panel en 127.0.0.1 |
| `RELAYDECK_HOME` / `CODEX_PANEL_HOME` | `~/.relaydeck` | Directorio donde se almacenan proveedores locales |
| `CODEX_HOME` | `~/.codex` | Directorio de configuración de Codex CLI |
| `RELAYDECK_TIMEOUT_MS` | `60000` | Tiempo de espera antes de marcar timeout |
| `RELAYDECK_SLOW_MS` | `12000` | Umbral para alertar de relay lento |
| `RELAYDECK_RETRIES` | `2` | Reintentos ante errores temporales o 429 |
| `RELAYDECK_MODEL_TRIES` | `4` | Candidatos a probar automáticamente |
| `RELAYDECK_SCAN_MAX` | `30` | Tope de modelos a escanear en barrido |

## Pruebas automatizadas

El proyecto cuenta con una suite completa de pruebas automatizadas sin dependencias externas:

```bash
npm test
# o directamente:
node qa/run-tests.js
```

`qa/fake-provider.js` simula un relay en varios modos:

```bash
node qa/fake-provider.js hidden      7801   # 27 modelos, solo 1 sirve (caso real)
node qa/fake-provider.js chatstream  7802   # solo Chat en SSE -> traductor
node qa/fake-provider.js clientblock 7803   # bloquea por huella de cliente
node qa/fake-provider.js slow        7804   # 429 con Retry-After
node qa/fake-provider.js eol         7805   # modelo retirado (410)
node qa/fake-provider.js metadata    7806   # expone /api/pricing: acierta a la 1
node qa/fake-provider.js unauth      7807   # key revocada
node qa/fake-provider.js claudeonly  7808   # solo Anthropic /messages
node qa/fake-provider.js full        7809   # todo OK
```

Registralo con cualquier key que empiece por `sk-`.

## Archivos

| Archivo | Que hace |
|---|---|
| `server.js` | El panel: test, descubrimiento de modelos, instalación, guías y backend |
| `bridge.js` | El traductor Chat → Responses en tiempo real (usable suelto) |
| `toml-edit.js` | Editor estructural de TOML: lee y edita en su sitio, sin duplicar tablas |
| `public/index.html` | La interfaz gráfica de usuario en tiempo real (cero dependencias) |
| `qa/fake-provider.js` | Relay falso para pruebas de integración |
| `qa/run-tests.js` | Suite completa de pruebas automatizadas (41/41 tests) |
| `LICENSE` | Licencia de código abierto MIT (NextKool 2026) |

> **Nota de seguridad sobre tus claves:** En tu carpeta local de usuario (`~/.relaydeck/`) se guardan `providers.json` y `env.cmd` con tus API keys reales para que el panel las recuerde entre sesiones. **Nunca compartas ni subas esos archivos a GitHub**, ya que contienen tus claves de pago privadas. El `.gitignore` del proyecto los protege por defecto.
