#!/usr/bin/env node
'use strict'

/**
 * Codex Panel — gestor local de providers OpenAI-compatibles para Codex CLI.
 *
 * Escucha SOLO en 127.0.0.1. Nunca expongas este puerto a la red.
 *
 *   node server.js            -> http://127.0.0.1:7788
 *   CODEX_PANEL_PORT=9000 node server.js
 *
 * Variables de entorno:
 *   CODEX_PANEL_PORT   puerto (default 7788)
 *   CODEX_PANEL_HOME   almacen del panel (default ~/.codex-panel)
 *   CODEX_HOME         home de Codex (default ~/.codex)
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFileSync, spawn } = require('child_process')
const { createBridge } = require('./bridge')
const { TomlDoc, validate } = require('./toml-edit')

const PORT = Number(process.env.RELAYDECK_PORT || process.env.CODEX_PANEL_PORT || 7788)
const HOST = '127.0.0.1'
const defaultPanelHome = fs.existsSync(path.join(os.homedir(), '.relaydeck'))
	? path.join(os.homedir(), '.relaydeck')
	: fs.existsSync(path.join(os.homedir(), '.codex-panel'))
		? path.join(os.homedir(), '.codex-panel')
		: path.join(os.homedir(), '.relaydeck')
const PANEL_HOME = process.env.RELAYDECK_HOME || process.env.CODEX_PANEL_HOME || defaultPanelHome
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const STORE = path.join(PANEL_HOME, 'providers.json')
const ENV_FILE = path.join(PANEL_HOME, 'env.sh')
const ENV_FILE_CMD = path.join(PANEL_HOME, 'env.cmd')
const IS_WIN = os.platform() === 'win32'
const PUBLIC_DIR = path.join(__dirname, 'public')
// Limite maximo de espera por sonda: 15 segundos para no colgar la UI.
const TIMEOUT_MS = Number(process.env.RELAYDECK_TIMEOUT_MS || process.env.CODEX_PANEL_TIMEOUT_MS || 15000)
// Reintentos ante 429 / 5xx, respetando Retry-After.
const MAX_RETRIES = Number(process.env.RELAYDECK_RETRIES || process.env.CODEX_PANEL_RETRIES || 2)
// A partir de aqui avisamos de que el proveedor va lento.
const SLOW_MS = Number(process.env.RELAYDECK_SLOW_MS || process.env.CODEX_PANEL_SLOW_MS || 12000)
// Cuantos modelos probar cuando el usuario no fijo uno.
const MAX_MODEL_TRIES = Number(process.env.RELAYDECK_MODEL_TRIES || process.env.CODEX_PANEL_MODEL_TRIES || 4)
// Tope de modelos a barrer cuando el test no concluye con los primeros.
const SCAN_MAX = Number(process.env.RELAYDECK_SCAN_MAX || process.env.CODEX_PANEL_SCAN_MAX || 30)
// Puerto base del traductor Chat->Responses.
const BRIDGE_BASE_PORT = Number(process.env.CODEX_PANEL_BRIDGE_PORT || 7789)

// ---------------------------------------------------------------- utilidades

function ensureHome() {
	fs.mkdirSync(PANEL_HOME, { recursive: true, mode: 0o700 })
	try {
		fs.chmodSync(PANEL_HOME, 0o700)
	} catch {}
}

function readStore() {
	try {
		const raw = fs.readFileSync(STORE, 'utf8')
		const parsed = JSON.parse(raw)
		if (!parsed || !Array.isArray(parsed.providers)) throw new Error('formato de providers.json no reconocido')
		return parsed.providers
	} catch (error) {
		if (error?.code === 'ENOENT') return []
		throw new Error(`No se pudo leer ${STORE}: ${error.message || error}`)
	}
}

function atomicWrite(file, content, mode = 0o600) {
	const dir = path.dirname(file)
	fs.mkdirSync(dir, { recursive: true })
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`)
	fs.writeFileSync(tmp, content, { mode })
	try {
		try {
			fs.renameSync(tmp, file)
		} catch (renameErr) {
			if (IS_WIN && (renameErr.code === 'EEXIST' || renameErr.code === 'EPERM' || renameErr.code === 'EBUSY')) {
				fs.copyFileSync(tmp, file)
				fs.unlinkSync(tmp)
			} else {
				throw renameErr
			}
		}
	} catch (error) {
		try {
			fs.unlinkSync(tmp)
		} catch {}
		throw error
	}
	try {
		fs.chmodSync(file, mode)
	} catch {}
}

function writeStore(providers) {
	ensureHome()
	if (fs.existsSync(STORE)) {
		try {
			fs.copyFileSync(STORE, STORE + '.bak')
		} catch (err) {
			throw new Error(`Fallo el respaldo de ${STORE}: ${err.message || err}`)
		}
	}
	atomicWrite(STORE, JSON.stringify({ version: 1, providers }, null, 2) + '\n')
}

function slug(text) {
	return String(text || '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
}

// UNA sola variable de entorno, siempre la misma, para que la instruccion
// nunca cambie: "set CODEX_KEY=..." y listo. Solo hay un provider activo.
const ENV_KEY = 'CODEX_KEY'
function envKeyFor() {
	return ENV_KEY
}

/**
 * Forma canonica de una base URL, para saber si dos providers apuntan al MISMO
 * relay aunque esten escritos distinto (barra final, mayusculas, http/https).
 */
function normalizedRelay(value) {
	try {
		const url = new URL(String(value || '').trim())
		url.hostname = url.hostname.toLowerCase()
		url.pathname = url.pathname.replace(/\/+$/, '') || '/'
		return url.toString().replace(/\/$/, '')
	} catch {
		return ''
	}
}

function sameRelay(a, b) {
	const left = normalizedRelay(a)
	const right = normalizedRelay(b)
	return left !== '' && left === right
}

/** Une la base_url con un path relativo sin duplicar barras. */
function endpoint(baseUrl, suffix) {
	return String(baseUrl || '').replace(/\/+$/, '') + suffix
}

function tomlString(value) {
	return JSON.stringify(String(value))
}

function shellQuote(value) {
	return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function assertEnvKey(value) {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value || ''))) {
		throw new Error('La variable de la key solo puede contener letras, numeros y guion bajo, y no puede empezar por numero')
	}
}

function assertSecret(value) {
	if (/[\r\n\0]/.test(String(value || ''))) throw new Error('La API key contiene caracteres de control no permitidos')
}

function cmdSet(name, value) {
	return `set "${name}=${String(value).replace(/%/g, '%%')}"`
}

function maskKey(key) {
	const k = String(key || '').trim()
	if (!k) return ''
	if (k.length <= 11) return k.slice(0, 3) + '************' + k.slice(-2)
	return k.slice(0, 7) + '************' + k.slice(-4)
}

function stamp() {
	return new Date().toISOString().replace(/[:.]/g, '-')
}

function backupFile(file, limit = 5) {
	if (!fs.existsSync(file)) return false
	const backup = `${file}.${stamp()}.bak`
	fs.copyFileSync(file, backup)
	const dir = path.dirname(file)
	const prefix = path.basename(file) + '.'
	const backups = fs
		.readdirSync(dir)
		.filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
		.sort()
	for (const old of backups.slice(0, Math.max(0, backups.length - limit))) {
		fs.unlinkSync(path.join(dir, old))
	}
	return true
}

// ------------------------------------------------------- perfiles de cliente
//
// Muchos relays (one-api / new-api y forks) filtran por huella de cliente y
// responden 401 "unauthorized client detected" a cualquier peticion que no
// parezca un SDK oficial. El fetch de Node manda solo "user-agent: node", asi
// que la misma key que funciona en Codex CLI aqui era rechazada.
//
// Solucion: probar la peticion con varias huellas de cliente reales y quedarnos
// con la primera que el relay acepte.

const OS_NAME = { darwin: 'MacOS', win32: 'Windows', linux: 'Linux' }[os.platform()] || 'Unknown'
const ARCH = { x64: 'x64', arm64: 'arm64' }[os.arch()] || os.arch()
const TERMINAL = process.env.TERM_PROGRAM || process.env.WT_SESSION ? 'WindowsTerminal' : 'unknown'

/**
 * Version del CLI para el User-Agent. Si el relay tiene lista blanca de
 * versiones, un numero inventado falla: preferimos la del Codex instalado.
 * Orden: CODEX_PANEL_CLI_VERSION -> `codex --version` -> fallback.
 */
let cliVersionCache = null
function cliVersion() {
	if (cliVersionCache) return cliVersionCache
	if (process.env.CODEX_PANEL_CLI_VERSION) {
		cliVersionCache = process.env.CODEX_PANEL_CLI_VERSION.trim()
		return cliVersionCache
	}
	try {
		const out = execFileSync('codex', ['--version'], {
			encoding: 'utf8',
			timeout: 3000,
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		const found = /(\d+\.\d+\.\d+)/.exec(out)
		if (found) return (cliVersionCache = found[1])
	} catch {}
	return (cliVersionCache = '0.45.0')
}

/**
 * installation id estable entre arranques, como el que persiste Codex.
 * Un id nuevo en cada peticion es una senal obvia de cliente sintetico.
 */
let installationIdCache = null
function installationId() {
	if (installationIdCache) return installationIdCache
	const file = path.join(PANEL_HOME, 'installation-id')
	try {
		const saved = fs.readFileSync(file, 'utf8').trim()
		if (saved) return (installationIdCache = saved)
	} catch {}
	const fresh = crypto.randomUUID()
	try {
		ensureHome()
		fs.writeFileSync(file, fresh + '\n', { mode: 0o600 })
	} catch {}
	return (installationIdCache = fresh)
}

/**
 * Codex agrupa las peticiones de una conversacion bajo un session_id y un
 * conversation_id estables. Se renuevan al empezar cada test.
 */
let SESSION = { sessionId: crypto.randomUUID(), conversationId: crypto.randomUUID() }
function newSession() {
	SESSION = { sessionId: crypto.randomUUID(), conversationId: crypto.randomUUID() }
}

const CLIENT_PROFILES = [
	{
		id: 'codex-cli',
		label: 'Codex CLI',
		headers: (ctx) => ({
			'User-Agent': `codex_cli_rs/${cliVersion()} (${OS_NAME} ${os.release()}; ${ARCH}) ${TERMINAL}`,
			originator: 'codex_cli_rs',
			Accept: ctx.accept,
			'Accept-Language': 'en-US,en;q=0.9',
			'OpenAI-Beta': 'responses=experimental',
			session_id: SESSION.sessionId,
			conversation_id: SESSION.conversationId,
			'x-client-request-id': ctx.requestId,
			'x-codex-installation-id': installationId(),
			prompt_cache_key: SESSION.sessionId,
		}),
	},
	{
		id: 'openai-node',
		label: 'SDK openai-node',
		headers: (ctx) => ({
			'User-Agent': 'OpenAI/JS 5.12.2',
			Accept: ctx.accept,
			'x-stainless-lang': 'js',
			'x-stainless-package-version': '5.12.2',
			'x-stainless-runtime': 'node',
			'x-stainless-runtime-version': process.versions.node,
			'x-stainless-os': OS_NAME,
			'x-stainless-arch': ARCH,
			'x-stainless-retry-count': '0',
			'OpenAI-Beta': 'responses=v1',
		}),
	},
	{
		id: 'openai-python',
		label: 'SDK openai-python',
		headers: (ctx) => ({
			'User-Agent': 'OpenAI/Python 1.99.1',
			Accept: ctx.accept,
			'x-stainless-lang': 'python',
			'x-stainless-package-version': '1.99.1',
			'x-stainless-runtime': 'CPython',
			'x-stainless-runtime-version': '3.12.3',
			'x-stainless-os': OS_NAME,
			'x-stainless-arch': ARCH,
			'x-stainless-async': 'false',
			'x-stainless-retry-count': '0',
			'OpenAI-Beta': 'responses=v1',
		}),
	},
	{
		// Ultimo recurso: algunos relays no leen Authorization sino cabeceras
		// propias de Azure/Anthropic. Enviarlas de mas es inofensivo.
		id: 'alt-auth',
		label: 'Cabeceras de auth alternativas',
		mirrorAuth: true,
		headers: (ctx) => ({
			'User-Agent': 'OpenAI/JS 5.12.2',
			Accept: ctx.accept,
			'x-stainless-lang': 'js',
			'OpenAI-Beta': 'responses=v1',
		}),
	},
	{
		id: 'claude-cli',
		label: 'Claude Code CLI',
		mirrorAuth: true,
		headers: (ctx) => ({
			'User-Agent': 'claude-cli/1.0.0 (Windows)',
			'anthropic-version': '2023-06-01',
			Accept: ctx.accept,
		}),
	},
]

function buildHeaders(profile, apiKey, { accept = 'application/json', extra = {} } = {}) {
	const ctx = { accept, requestId: crypto.randomUUID() }
	const headers = {
		Authorization: 'Bearer ' + apiKey,
		...profile.headers(ctx),
		...extra,
	}
	if (profile.mirrorAuth) {
		headers['api-key'] = apiKey
		headers['x-api-key'] = apiKey
	}
	return headers
}

/** El relay rechazo al cliente, no a la key. */
function isClientBlock(result) {
	const msg = String(
		result.json?.error?.message || result.json?.message || result.text || '',
	).toLowerCase()
	return /unauthorized client|client not authorized|unauthorized_client|invalid client|illegal client|abnormal client|contact support for assistance|检测到|异常客户端|非法客户端/.test(
		msg,
	)
}

function isAuthStatus(status) {
	return status === 401 || status === 403
}

/**
 * El relay conoce el modelo pero no tiene canal libre para servirlo, o el
 * modelo no existe. Es un problema DE ESE MODELO, no del proveedor ni de la
 * key: hay que probar otro modelo antes de dictar sentencia.
 * Los relays chinos (one-api / new-api / agentrouter) contestan en chino.
 */
function isModelUnavailable(result) {
	const msg = String(
		result.json?.error?.message || result.json?.message || result.text || '',
	).toLowerCase()
	// Ojo: un 404 seco en /responses suele significar que el ENDPOINT no existe
	// (proveedor solo-chat), no que falte el modelo. Cambiar de modelo no ayuda,
	// asi que solo lo contamos si el mensaje habla del modelo.
	if (/unknown request url|no such endpoint|not found: post|invalid url/.test(msg)) return false
	// 410 Gone = el modelo llego a su fin de vida. Un 503 solo cuenta si el
	// mensaje confirma un problema de enrutado; tambien puede ser una caida temporal.
	if (result.httpStatus === 410) return true
	return /no available channel|无可用渠道|渠道不可用|model_not_found|does not exist|no such model|unsupported model|model not found|无此模型|不支持的模型|当前分组|end of life|no longer available|has been retired|is deprecated|已下线|已弃用/.test(
		msg,
	)
}

/**
 * El endpoint /v1/responses no existe, y lo dice sin ambiguedad.
 * OJO: un 404 pelado NO cuenta. Los relays devuelven 404 tanto cuando el
 * endpoint no existe como cuando ese modelo concreto no lo soporta (visto:
 * `{"error":{"type":"openai_error"}}`, sin mensaje). Dar por muerto el endpoint
 * con un solo modelo probado era justo el bug: el relay si servia /responses,
 * pero con otro modelo.
 */
function isEndpointMissing(result) {
	const msg = String(
		result.json?.error?.message || result.json?.message || result.text || '',
	).toLowerCase()
	if (result.httpStatus === 501) return true
	return /unknown request url|no such endpoint|not found: post|invalid url|cannot post|endpoint not found/.test(
		msg,
	)
}

/**
 * 404 que no aclara nada: puede ser el endpoint o puede ser el modelo. Solo se
 * puede resolver probando mas modelos.
 */
function isAmbiguous(result) {
	if (result.ok) return false
	if (isEndpointMissing(result)) return false
	if (result.httpStatus === 404) return true
	// 400 hablando del modelo: tambien es cosa del modelo.
	if (result.httpStatus === 400) {
		const msg = String(result.json?.error?.message || result.text || '').toLowerCase()
		return /model/.test(msg)
	}
	return false
}

/** Cuota / presupuesto agotado. La key es valida; no hay saldo para ese pool. */
/**
 * Los relays usan numeros absurdos como centinela de "sin limite"
 * (p.ej. 100000000.00). Mostrarlos como saldo real es enganoso.
 */
const UNLIMITED_THRESHOLD = Number(process.env.CODEX_PANEL_UNLIMITED_FROM || 10000)
function looksUnlimited(value) {
	return typeof value === 'number' && value >= UNLIMITED_THRESHOLD
}

function isQuotaError(result) {
	if (result.httpStatus === 402) return true
	const msg = String(
		result.json?.error?.message || result.json?.message || result.text || '',
	).toLowerCase()
	return /quota has been exhausted|budget pool|insufficient|quota exceeded|额度|余额不足|配额/.test(msg)
}

// ------------------------------------------------- descubrimiento de modelos
//
// El estandar OpenAI para GET /v1/models devuelve SOLO identificadores:
// {id, object, created, owned_by}. No hay campo de capacidades, ni de que
// endpoints soporta cada modelo, ni de si tiene canal vivo. Con el estandar a
// secas es IMPOSIBLE saber que modelo sirve para Codex: hay que preguntarselo
// al relay por otra via, o probar.
//
// Por suerte los relays new-api / one-api (y forks como AgentRouter) exponen
// metadatos propios que si lo dicen. De ahi sacamos la respuesta, en vez de
// llevar una lista de nombres de modelo escrita a mano.

/**
 * Pregunta al relay que modelos soportan /v1/responses y cuales tienen canal.
 *
 *   GET /api/pricing  -> por modelo: enable_groups + supported_endpoint_types,
 *                        y un mapa supported_endpoint con la ruta de cada tipo.
 *   GET /api/models   -> mapa channelId -> modelos (los que tienen canal).
 *   GET /api/user/self-> el grupo del usuario, para filtrar enable_groups.
 *
 * Todo es best effort: si el relay no los expone, devolvemos lo que haya.
 */
async function discoverModelSupport(baseUrl, apiKey) {
	const origin = String(baseUrl || '')
		.replace(/\/+$/, '')
		.replace(/\/v\d+[a-z]*$/, '')
	const out = { responses: [], channelBacked: [], group: null, sources: [] }
	if (!origin) return out

	const [pricing, channels, self] = await Promise.all([
		probeSmart(origin + '/api/pricing', { apiKey }),
		probeSmart(origin + '/api/models', { apiKey }),
		probeSmart(origin + '/api/user/self', { apiKey }),
	])

	if (self.json?.data?.group) out.group = String(self.json.data.group)

	// --- que modelos declaran soportar /v1/responses
	const rows = Array.isArray(pricing.json?.data) ? pricing.json.data : []
	if (rows.length) {
		out.sources.push('/api/pricing')
		// El mapa dice que numero de tipo corresponde a /v1/responses.
		const endpointMap = pricing.json?.supported_endpoint || {}
		const responsesTypes = Object.entries(endpointMap)
			.filter(([, def]) => /\/responses\b/.test(String(def?.path || '')))
			.map(([type]) => String(type))

		for (const row of rows) {
			const name = row?.model_name
			if (!name) continue
			// Respetar el grupo del token si lo sabemos.
			const groups = row.enable_groups || row.enable_group
			if (out.group && Array.isArray(groups) && groups.length && !groups.includes(out.group)) {
				continue
			}
			const types = (row.supported_endpoint_types || []).map(String)
			// Si el relay declara tipos y sabemos cual es /responses, filtramos.
			// Si no declara nada, no lo descartamos: solo no lo priorizamos.
			if (responsesTypes.length && types.length) {
				if (types.some((t) => responsesTypes.includes(t))) out.responses.push(name)
			}
		}
	}

	// --- que modelos tienen algun canal detras
	const byChannel = channels.json?.data
	if (byChannel && typeof byChannel === 'object' && !Array.isArray(byChannel)) {
		out.sources.push('/api/models')
		const seen = new Set()
		for (const list of Object.values(byChannel)) {
			if (!Array.isArray(list)) continue
			for (const m of list) if (m && !seen.has(m)) seen.add(m)
		}
		out.channelBacked = [...seen]
	}

	return out
}

/**
 * Modelos que ya usas de verdad, leidos de tu propia configuracion: los
 * perfiles de ~/.codex/config.toml y los providers ya guardados en el panel.
 * Es la unica pista fiable cuando el relay no expone nada, y no inventa nada.
 */
function modelsFromLocalConfig() {
	const found = []
	const push = (m) => {
		const v = String(m || '').trim()
		if (v && !found.includes(v)) found.push(v)
	}
	try {
		for (const file of fs.readdirSync(CODEX_HOME)) {
			if (!file.endsWith('.toml')) continue
			const text = fs.readFileSync(path.join(CODEX_HOME, file), 'utf8')
			for (const m of text.matchAll(/^\s*model\s*=\s*"([^"]+)"/gm)) push(m[1])
		}
	} catch {}
	for (const p of readStore()) push(p.model)
	return found
}

/**
 * Ordena los candidatos con la informacion que dio el relay, no con una lista
 * de nombres escrita a mano:
 *   1. declara soportar /v1/responses Y tiene canal
 *   2. declara soportar /v1/responses
 *   3. tiene canal
 *   4. el resto, en el orden en que los listo el relay
 */
function orderCandidates(models, discovery) {
	const responses = new Set(discovery?.responses || [])
	const channels = new Set(discovery?.channelBacked || [])
	const rank = (id) => {
		const r = responses.has(id)
		const c = channels.has(id)
		if (r && c) return 0
		if (r) return 1
		if (c) return 2
		return 3
	}
	// Orden estable: si no hay metadatos, todos empatan y se respeta el original.
	return models
		.map((id, i) => ({ id, i, r: rank(id) }))
		.sort((a, b) => a.r - b.r || a.i - b.i)
		.map((x) => x.id)
}

// ------------------------------------------------------------------- testing

async function probe(url, options = {}) {
	const started = Date.now()
	try {
		const res = await fetch(url, {
			...options,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		})
		const text = await res.text()
		let json = null
		try {
			json = JSON.parse(text)
		} catch {}
		const hasError = Boolean(
			json && (json.error || json.err_code || json.code === 1113 || json.type === 'upstream_error' || json.type === 'error')
		)
		const isOk = res.ok && !hasError
		return {
			ok: isOk,
			httpStatus: isOk ? res.status : (res.status === 200 ? 400 : res.status),
			ms: Date.now() - started,
			text,
			json,
			retryAfter: res.headers.get('retry-after'),
		}
	} catch (error) {
		return {
			ok: false,
			httpStatus: 0,
			ms: Date.now() - started,
			text: '',
			json: null,
			networkError: error.name === 'TimeoutError' ? 'timeout' : error.message,
		}
	}
}

/** Merece reintento: limite de ritmo o caida temporal del relay. */
function isRetryable(result) {
	if (result.httpStatus === 429) return true
	// Si fue timeout, no reintentar: ya espero 15s y el servidor no responde.
	if (result.networkError === 'timeout') return false
	// Un 503 "no hay canal para este modelo" es una decision de enrutado, no una sobrecarga.
	if (result.httpStatus === 503 && isModelUnavailable(result)) return false
	if (result.httpStatus >= 500 && result.httpStatus !== 501) return true
	// Error de red inmediato (DNS/ECONNREFUSED): no reintentar.
	return false
}

/** Segundos que pide el servidor esperar, si los dice. */
function retryAfterMs(result) {
	const header = result.retryAfter
	if (!header) return null
	const seconds = Number(header)
	if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 2500)
	const date = Date.parse(header)
	if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 2500)
	return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reintenta ante 429 / 5xx con backoff exponencial, respetando Retry-After.
 * Codex hace lo mismo: sin esto, un relay con limite de ritmo se reportaba como
 * roto cuando en realidad solo habia que esperar.
 */
async function withRetries(run) {
	let last = null
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const result = await run()
		result.retries = attempt
		last = result
		if (!isRetryable(result) || attempt === MAX_RETRIES) return result
		const wait = retryAfterMs(result) ?? Math.min(1000 * 2 ** attempt, 8000)
		result.waited = (result.waited || 0) + wait
		await sleep(wait)
	}
	return last
}

/**
 * Igual que probe(), pero para SSE: no espera la respuesta completa. Lee hasta
 * el primer evento valido y corta la conexion, que es lo minimo para saber si
 * el proveedor strea de verdad. Asi no gastamos tokens de mas ni esperamos.
 */
async function probeSse(url, options = {}) {
	const started = Date.now()
	let res
	try {
		res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) })
	} catch (error) {
		return {
			ok: false,
			httpStatus: 0,
			ms: Date.now() - started,
			text: '',
			json: null,
			sse: false,
			networkError: error.name === 'TimeoutError' ? 'timeout' : error.message,
		}
	}

	const contentType = res.headers.get('content-type') || ''
	const retryAfter = res.headers.get('retry-after')
	let buffer = ''
	let sawEvent = false

	try {
		const reader = res.body?.getReader()
		const decoder = new TextDecoder()
		while (reader) {
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })
			// Un evento SSE completo, o suficiente error como para diagnosticar.
			if (/(^|\n)data:\s*\S/.test(buffer) || buffer.length > 16384) {
				sawEvent = /(^|\n)data:\s*\S/.test(buffer)
				break
			}
		}
		try {
			await reader?.cancel()
		} catch {}
	} catch (error) {
		if (!buffer) {
			return {
				ok: false,
				httpStatus: res.status,
				ms: Date.now() - started,
				text: '',
				json: null,
				sse: false,
				networkError: error.message,
			}
		}
	}

	let json = null
	try {
		json = JSON.parse(buffer)
	} catch {}
	// Un evento SSE con payload de error tambien hay que reportarlo.
	if (!json && sawEvent) {
		const first = /(^|\n)data:\s*(.+)/.exec(buffer)
		try {
			json = JSON.parse(first[2])
		} catch {}
	}

	const streamed = sawEvent || contentType.includes('text/event-stream')
	const payload = /(^|\n)data:\s*(.+)/.exec(buffer)?.[2]?.trim()
	const validPayload = Boolean(payload && payload !== '[DONE]' && json && typeof json === 'object')
	return {
		ok: res.ok && streamed && sawEvent && validPayload && !json?.error,
		httpStatus: res.status,
		ms: Date.now() - started,
		text: buffer,
		json,
		sse: streamed,
		retryAfter,
	}
}

/**
 * Igual que probe(), pero recorre los perfiles de cliente hasta que el relay
 * deje de contestar "cliente no autorizado". Devuelve el resultado con
 * `profile` (el que funciono) y `clientBlocked` (true si todos fueron
 * rechazados por huella).
 */
async function probeSmart(url, { apiKey, method = 'GET', json, extraHeaders, sse = false } = {}) {
	const body = json === undefined ? undefined : JSON.stringify(json)
	const contentType = body ? { 'Content-Type': 'application/json' } : {}
	const accept = sse ? 'text/event-stream' : 'application/json'
	const run = sse ? probeSse : probe
	let last = null

	for (const profile of CLIENT_PROFILES) {
		const result = await withRetries(() =>
			run(url, {
				method,
				headers: buildHeaders(profile, apiKey, {
					accept,
					extra: { ...contentType, ...extraHeaders },
				}),
				body,
			}),
		)
		result.profile = profile
		last = result

		// Red caida: cambiar cabeceras no ayuda.
		if (result.httpStatus === 0) return result
		// Un 401/403 por huella de cliente si merece reintento; el resto, no.
		if (!(isAuthStatus(result.httpStatus) && isClientBlock(result))) return result
	}

	if (last) last.clientBlocked = true
	return last
}

function responseText(json) {
	if (typeof json?.output_text === 'string') return json.output_text
	if (typeof json?.text === 'string') return json.text
	const parts = []
	for (const item of json?.output || []) {
		for (const content of item?.content || []) {
			if (typeof content?.text === 'string') parts.push(content.text)
		}
	}
	return parts.join('')
}

function apiError(result) {
	if (result.networkError === 'timeout') return 'Tiempo de espera agotado (15s): el servidor no respondió.'
	if (result.httpStatus === 0 && result.networkError) return `Error de red: ${result.networkError}`
	const err = result.json?.error
	// Algunos relays devuelven solo {error:{type:'openai_error'}} sin mensaje:
	// mejor mostrar el codigo que un texto vacio e inutil.
	const msg =
		err?.message ||
		result.json?.message ||
		err?.code ||
		err?.type ||
		result.json?.code ||
		result.text
	if (!msg) return result.networkError || `sin detalle (HTTP ${result.httpStatus})`
	const text = typeof msg === 'string' ? msg : JSON.stringify(msg)
	return text.slice(0, 240)
}

async function listModels(baseUrl, apiKey) {
	const result = await probeSmart(endpoint(baseUrl, '/models'), { apiKey })
	const data = result.json?.data
	const models = Array.isArray(data)
		? data.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean)
		: []
	return { result, models }
}

/**
 * Codex habla con /responses en streaming: stream:true + Accept text/event-stream.
 * Probamos exactamente eso primero, porque es lo que va a pasar en produccion
 * (y hay relays que solo implementan el modo streaming). Si falla por algo que
 * no sea auth, reintentamos en JSON plano para distinguir "no strea" de
 * "no sirve".
 */
async function probeAnthropic(baseUrl, apiKey, model) {
	const url = endpoint(baseUrl, '/messages')
	const extraHeaders = {
		'anthropic-version': '2023-06-01',
		'x-api-key': apiKey,
		'User-Agent': 'claude-cli/1.0.0',
	}
	const streamed = await probeSmart(url, {
		apiKey,
		method: 'POST',
		sse: true,
		extraHeaders,
		json: { model, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'ping' }] },
	})
	streamed.mode = 'stream'
	if (streamed.ok || streamed.httpStatus === 0 || isAuthStatus(streamed.httpStatus)) {
		return { best: streamed, streamed, plain: null, target: 'claude' }
	}

	const plain = await probeSmart(url, {
		apiKey,
		method: 'POST',
		extraHeaders,
		json: { model, max_tokens: 16, stream: false, messages: [{ role: 'user', content: 'ping' }] },
	})
	plain.mode = 'json'
	return { best: plain.ok ? plain : streamed, streamed, plain, target: 'claude' }
}

async function probeResponses(baseUrl, apiKey, model) {
	const url = endpoint(baseUrl, '/responses')
	const streamed = await probeSmart(url, {
		apiKey,
		method: 'POST',
		sse: true,
		json: { model, input: 'ping', max_output_tokens: 16, stream: true },
	})
	streamed.mode = 'stream'
	if (streamed.ok || streamed.httpStatus === 0 || isAuthStatus(streamed.httpStatus)) {
		return { best: streamed, streamed, plain: null, target: 'responses' }
	}

	const plain = await probeSmart(url, {
		apiKey,
		method: 'POST',
		json: { model, input: 'ping', max_output_tokens: 16, stream: false },
	})
	plain.mode = 'json'
	if (plain.ok) {
		return { best: plain, streamed, plain, target: 'responses' }
	}

	return { best: plain.ok ? plain : streamed, streamed, plain, target: 'responses' }
}

async function probeChat(baseUrl, apiKey, model) {
	const res = await probeSmart(endpoint(baseUrl, '/chat/completions'), {
		apiKey,
		method: 'POST',
		json: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false },
	})
	res.target = 'chat'
	return res
}

/**
 * Saldo restante. No existe estandar: los relays tipo one-api / new-api
 * exponen los endpoints legacy con forma OpenAI. Best effort.
 */
async function probeBilling(baseUrl, apiKey) {
	const end = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
	const start = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10)

	// --- 1. Convencion legacy OpenAI, la que replican one-api / new-api en /v1
	const [sub, usage] = await Promise.all([
		probeSmart(endpoint(baseUrl, '/dashboard/billing/subscription'), { apiKey }),
		probeSmart(endpoint(baseUrl, `/dashboard/billing/usage?start_date=${start}&end_date=${end}`), {
			apiKey,
		}),
	])

	const granted = typeof sub.json?.hard_limit_usd === 'number' ? sub.json.hard_limit_usd : null
	// total_usage viene en centavos en la convencion OpenAI/one-api
	const used = typeof usage.json?.total_usage === 'number' ? usage.json.total_usage / 100 : null

	if (granted != null || used != null) {
		if (looksUnlimited(granted) || (granted != null && looksUnlimited(granted - (used || 0)))) {
			return {
				status: 'ok',
				source: '/dashboard/billing',
				unlimited: true,
				granted: null,
				used,
				remaining: null,
				expiresAt: null,
				detail: `El relay devuelve un límite centinela (${granted}) asignado al token. El saldo real de tu wallet no se expone por API; consúltalo en su web oficial.`,
			}
		}
		return {
			status: 'ok',
			source: '/dashboard/billing',
			granted,
			used,
			remaining: granted != null && used != null ? granted - used : null,
			expiresAt: sub.json?.access_until
				? new Date(sub.json.access_until * 1000).toISOString()
				: null,
			detail: 'Cuota técnica de la key (no refleja tu wallet real). Consúltala en la web del proveedor.',
		}
	}

	// --- 2. credit_grants (relays que copian la API de creditos de OpenAI)
	const grants = await probeSmart(endpoint(baseUrl, '/dashboard/billing/credit_grants'), { apiKey })
	const g = grants.json
	if (typeof g?.total_granted === 'number' || typeof g?.total_available === 'number') {
		const avail = typeof g.total_available === 'number' ? g.total_available : null
		if (looksUnlimited(avail) || looksUnlimited(g.total_granted)) {
			return {
				status: 'ok',
				source: '/dashboard/billing/credit_grants',
				unlimited: true,
				granted: null,
				used: typeof g.total_used === 'number' ? g.total_used : null,
				remaining: null,
				expiresAt: null,
				detail: 'El relay devuelve un límite centinela. El saldo real de tu wallet no se expone por API; consúltalo en su web oficial.',
			}
		}
		return {
			status: 'ok',
			source: '/dashboard/billing/credit_grants',
			granted: typeof g.total_granted === 'number' ? g.total_granted : null,
			used: typeof g.total_used === 'number' ? g.total_used : null,
			remaining: avail,
			expiresAt: null,
			detail: 'Cuota técnica asignada a la key (no refleja tu wallet real). Consúltala en su web oficial.',
		}
	}

	// --- 3. new-api / one-api: la cuota real vive fuera de /v1, en /api/user/self.
	// La cuota se guarda en unidades internas: 500000 unidades = 1 USD.
	const origin = String(baseUrl || '').replace(/\/+$/, '').replace(/\/v\d+$/, '')
	if (origin && origin !== String(baseUrl || '').replace(/\/+$/, '')) {
		const self = await probeSmart(origin + '/api/user/self', { apiKey })
		const d = self.json?.data
		const UNIT = 500000
		if (d && (typeof d.quota === 'number' || typeof d.used_quota === 'number')) {
			const left = typeof d.quota === 'number' ? d.quota / UNIT : null
			const spent = typeof d.used_quota === 'number' ? d.used_quota / UNIT : null
			return {
				status: 'ok',
				source: '/api/user/self',
				granted: left != null && spent != null ? left + spent : null,
				used: spent,
				remaining: left,
				expiresAt: null,
				detail: 'Leido del panel del relay (new-api); 500000 unidades = 1 USD.',
			}
		}
	}

	const blocked = [sub, usage, grants].some((r) => r?.clientBlocked)
	if (blocked) {
		return {
			status: 'unsupported',
			detail: 'El relay bloqueo las consultas de saldo por huella de cliente.',
		}
	}
	return { status: 'unsupported', detail: 'El proveedor no expone endpoints de saldo reconocibles.' }
}

/**
 * Prueba una lista de modelos contra /v1/responses en paralelo y devuelve el
 * resultado de cada uno. Lo usan tanto el test (cuando el bucle rapido no
 * concluye) como el boton "Escanear modelos".
 */
/** Motivo legible de un fallo de /v1/responses. */
function classifyReason(r) {
	if (r.ok) return null
	if (isAuthStatus(r.httpStatus)) return 'auth'
	if (r.networkError === 'timeout') return 'timeout'
	if (r.httpStatus === 0) return 'sin conexion'
	if (isModelUnavailable(r)) return 'sin canal'
	if (isQuotaError(r)) return 'cuota agotada'
	if (r.httpStatus === 429) return 'limite de ritmo'
	if (isEndpointMissing(r)) return 'sin endpoint'
	if (isAmbiguous(r)) return 'rechazado (404 sin detalle)'
	return 'error'
}

async function sweepModels(
	baseUrl,
	apiKey,
	models,
	{ max = 40, concurrency = 3, stopOnFirst = false, onEach, shouldStop, checkAllProtocols = false } = {},
) {
	const safeMax = Math.min(Math.max(Number(max) || 1, 1), 200)
	const safeConcurrency = Math.min(Math.max(Number(concurrency) || 1, 1), 10)
	const queue = models.slice(0, safeMax)
	const results = []
	let found = null

	await Promise.all(
		Array.from({ length: Math.min(safeConcurrency, queue.length) }, async () => {
			for (;;) {
				if (shouldStop?.() || (stopOnFirst && found)) return
				const target = queue.shift()
				if (!target) return
				const round = await probeResponses(baseUrl, apiKey, target)
				let r = round.best
				let targetProto = 'responses'
				if (checkAllProtocols && !r.ok && !isAuthStatus(r.httpStatus) && r.httpStatus !== 0) {
					const isClaude = /claude/i.test(target)
					const [chatRes, anthRound] = await Promise.all([
						probeChat(baseUrl, apiKey, target),
						probeAnthropic(baseUrl, apiKey, target),
					])
					if (isClaude && anthRound.best.ok) {
						r = anthRound.best
						targetProto = 'claude'
					} else if (chatRes.ok) {
						r = chatRes
						targetProto = 'chat'
					} else if (anthRound.best.ok) {
						r = anthRound.best
						targetProto = 'claude'
					}
				}
				const entry = {
					model: target,
					ok: r.ok,
					httpStatus: r.httpStatus,
					target: targetProto,
					streams: targetProto === 'responses' ? Boolean(round.streamed?.ok) : false,
					detail: r.ok
						? (targetProto === 'claude'
							? 'Responde a /v1/messages (Claude Code)'
							: targetProto === 'chat'
								? 'Responde a /v1/chat/completions (Chat)'
								: 'OK (/v1/responses)')
						: apiError(r),
					reason: classifyReason(r),
					ms: r.ms,
					round,
				}
				results.push(entry)
				if (onEach) onEach(entry)
				if (r.ok && !found) found = entry
			}
		}),
	)

	return { results, found }
}

/**
 * Resume que huella de cliente acepto el relay. Se calcula sobre todas las
 * sondas: /models puede estar bloqueado aunque /responses funcione.
 */
function clientCheck(probes) {
	const accepted = probes.find((r) => r && !isAuthStatus(r.httpStatus) && r.httpStatus > 0)
	if (accepted) {
		return {
			status: 'pass',
			detail: `Aceptado como "${accepted.profile?.label || 'cliente generico'}"`,
		}
	}
	if (probes.some((r) => r?.clientBlocked)) {
		return {
			status: 'fail',
			detail: `El relay rechazo las ${CLIENT_PROFILES.length} huellas de cliente probadas.`,
		}
	}
	return { status: 'warn', detail: 'Sin confirmar.' }
}

async function runTest({ baseUrl, apiKey, model }) {
	if (!baseUrl || !apiKey) throw new Error('Faltan baseUrl o apiKey')

	// Cada test es una "conversacion" nueva a ojos del relay.
	newSession()
	const checks = {}
	let slowProvider = false

	// 1. Alcanzabilidad y catalogo de modelos
	const { result: modelsResult, models } = await listModels(baseUrl, apiKey)
	if (modelsResult.httpStatus === 0) {
		checks.reachable = { status: 'fail', detail: modelsResult.networkError, ms: modelsResult.ms }
		return { verdict: 'unreachable', checks, models: [] }
	}
	checks.reachable = {
		status: 'pass',
		detail: `HTTP ${modelsResult.httpStatus}`,
		ms: modelsResult.ms,
	}
	// Un 401 en /models NO cierra el caso: muchos relays lo bloquean y sirven
	// /responses igual. Solo anotamos y seguimos probando.
	const modelsAuthFail = isAuthStatus(modelsResult.httpStatus)
	if (modelsAuthFail) {
		checks.models = {
			status: 'warn',
			detail: `/models devolvio HTTP ${modelsResult.httpStatus}: ${apiError(modelsResult)}`,
		}
	} else {
		checks.models = modelsResult.ok
			? { status: 'pass', detail: `${models.length} modelos expuestos` }
			: { status: 'warn', detail: `/models devolvio HTTP ${modelsResult.httpStatus}` }
	}

	// 2. Codex exige la Responses API.
	// Si fijaste un modelo, se respeta y solo se prueba ese. Si no, le
	// preguntamos al relay que modelos soportan /v1/responses y cuales tienen
	// canal, y probamos esos primero. Nada se deduce del nombre del modelo.
	const discovery = model ? null : await discoverModelSupport(baseUrl, apiKey)
	let pool = models
	let guessing = false
	if (!model && !pool.length) {
		// Sin catalogo: los metadatos del relay o tu propia config de Codex.
		pool = discovery?.responses?.length
			? discovery.responses
			: discovery?.channelBacked?.length
				? discovery.channelBacked
				: modelsFromLocalConfig()
		guessing = pool.length > 0
	}
	const candidates = model ? [model] : orderCandidates(pool, discovery).slice(0, MAX_MODEL_TRIES)

	if (discovery?.sources?.length) {
		const declared = discovery.responses.length
		checks.modelSupport = {
			status: declared ? 'pass' : 'warn',
			detail: declared
				? `El relay declara ${declared} modelo(s) con soporte de /v1/responses${
						discovery.group ? ` en tu grupo "${discovery.group}"` : ''
					}. Se prueban esos primero.`
				: `El relay expone metadatos (${discovery.sources.join(', ')}) pero no declara que modelos soportan /v1/responses. Se prueba en el orden en que los lista.`,
			responses: discovery.responses,
			channelBacked: discovery.channelBacked,
			sources: discovery.sources,
		}
	} else if (!model) {
		checks.modelSupport = {
			status: 'warn',
			detail:
				'El estandar GET /v1/models solo devuelve identificadores, sin capacidades. Este relay no expone metadatos extra, asi que hay que probar. Usa "Escanear modelos" para saber cual sirve.',
		}
	}

	if (!candidates.length) {
		checks.responses = {
			status: 'warn',
			detail:
				'No hay ningun modelo que probar: el relay no listo catalogo ni metadatos. Escribi el nombre del modelo a mano.',
		}
		checks.auth = modelsAuthFail
			? { status: 'fail', detail: apiError(modelsResult) }
			: { status: 'warn', detail: 'Sin confirmar: no hubo modelo con el que probar.' }
		checks.client = clientCheck([modelsResult])
		checks.billing = await probeBilling(baseUrl, apiKey)
		return {
			verdict: modelsResult.clientBlocked ? 'client_blocked' : modelsAuthFail ? 'invalid_key' : 'unknown',
			checks,
			models,
		}
	}
	const attempts = []
	let responses = null
	let streamed = null
	let plain = null
	let target = candidates[0]

	const record = (candidate, round) => {
		const r = round.best
		const entry = {
			model: candidate,
			target: round.target || 'responses',
			ok: r.ok,
			httpStatus: r.httpStatus,
			detail: r.ok ? 'OK (/v1/responses)' : apiError(r),
			unavailable: !r.ok && isModelUnavailable(r),
			quota: !r.ok && isQuotaError(r),
			ambiguous: isAmbiguous(r),
			endpointMissing: !r.ok && isEndpointMissing(r),
		}
		attempts.push(entry)
		target = candidate
		responses = r
		streamed = round.streamed
		plain = round.plain
		return entry
	}

	for (const candidate of candidates) {
		const entry = record(candidate, await probeResponses(baseUrl, apiKey, candidate))
		if (entry.ok) break
		// Cambiar de modelo no arregla auth ni la red.
		if (isAuthStatus(entry.httpStatus) || entry.httpStatus === 0) break
		// El relay dice claramente que el endpoint no existe: otro modelo no ayuda.
		if (entry.endpointMissing) break
		// Lo demas (sin canal, cuota, o un 404 ambiguo) es cosa del modelo:
		// seguimos con el siguiente candidato.
		if (!entry.unavailable && !entry.quota && !entry.ambiguous) break
	}

	// Si el bucle corto no concluyo y quedan modelos sin probar, barremos el
	// resto aqui mismo en vez de mandarte a pulsar otro boton. El relay puede
	// tener 27 modelos y servir /responses solo en uno.
	let sweep = null
	if (!responses.ok && !model) {
		const tried = new Set(attempts.map((a) => a.model))
		const blocking = attempts[attempts.length - 1]
		const worthSweeping =
			blocking &&
			!isAuthStatus(blocking.httpStatus) &&
			blocking.httpStatus !== 0 &&
			!blocking.endpointMissing
		const remaining = orderCandidates(pool, discovery).filter((m) => !tried.has(m))

		if (worthSweeping && remaining.length) {
			sweep = await sweepModels(baseUrl, apiKey, remaining, {
				max: SCAN_MAX,
				concurrency: 3,
				stopOnFirst: true,
			})
			for (const entry of sweep.results) {
				attempts.push({
					model: entry.model,
					ok: entry.ok,
					httpStatus: entry.httpStatus,
					detail: entry.detail,
					unavailable: entry.reason === 'sin canal',
					quota: entry.reason === 'cuota agotada',
					ambiguous: entry.reason === 'rechazado (404 sin detalle)',
					endpointMissing: entry.reason === 'sin endpoint',
				})
			}
			if (sweep.found) {
				target = sweep.found.model
				responses = sweep.found.round.best
				streamed = sweep.found.round.streamed
				plain = sweep.found.round.plain
			}
			checks.modelScan = {
				status: sweep.found ? 'pass' : 'fail',
				detail: sweep.found
					? `Se barrieron ${attempts.length} modelos hasta encontrar uno que sirve: "${sweep.found.model}".`
					: `Se probaron ${attempts.length} de ${pool.length} modelos y ninguno responde a /v1/responses.`,
				models: attempts.map((a) => ({ model: a.model, httpStatus: a.httpStatus, detail: a.detail })),
			}
		}
	}

	const ambiguousNote =
		attempts.length && attempts[0].ambiguous && attempts[0].httpStatus === 404
			? ' Un 404 aqui no distingue entre "el endpoint no existe" y "ese modelo no lo soporta", por eso se prueban mas modelos.'
			: ''
	const triedNote =
		(attempts.length > 1
			? ` Probados ${attempts.length} modelos: ${attempts.map((a) => a.model).join(', ')}.`
			: '') +
		(guessing
			? ' Sin catalogo /v1/models: los candidatos salen de los metadatos del relay o de tu config de Codex.'
			: '')

	if (responses.ok) {
		checks.responses = {
			status: 'pass',
			detail:
				responses.mode === 'stream'
					? `Responses API OK con "${target}", en streaming (igual que Codex)`
					: `Responses API OK con "${target}", pero solo sin streaming`,
			ms: responses.ms,
		}
	} else {
		checks.responses = {
			status: 'fail',
			detail: `HTTP ${responses.httpStatus}: ${apiError(responses)}${triedNote}${ambiguousNote}`,
			ms: responses.ms,
		}
	}

	// Diagnostico honesto: distinguir "el proveedor no sirve" de "este modelo
	// no tiene canal" o "se agoto la cuota".
	const modelIssues = attempts.filter((a) => !a.ok && (a.unavailable || a.quota || a.ambiguous))
	const allModelIssues = attempts.length > 0 && modelIssues.length === attempts.length
	// Muchos modelos rechazados con 404 sin detalle: apunta a que el endpoint no
	// existe en este relay. Se juzga con varios modelos probados, no con uno.
	// Un modelo retirado o sin canal por medio no invalida la conclusion.
	const ambiguousCount = attempts.filter((a) => a.ambiguous || a.endpointMissing).length
	const allAmbiguous = !responses.ok && ambiguousCount >= 2
	if (!responses.ok && allModelIssues) {
		const onlyQuota = modelIssues.every((a) => a.quota && !a.unavailable && !a.ambiguous)
		checks.modelRouting = {
			status: 'fail',
			detail: allAmbiguous
				? `${ambiguousCount} de ${attempts.length} modelos devuelven 404 en /v1/responses. Con tantos rechazados, este relay no implementa la Responses API: no es cosa de un modelo. Usa el traductor.`
				: onlyQuota
					? 'La clave es válida pero la cuota de esos modelos está agotada. Solicita otro grupo de presupuesto o elige otro modelo.'
					: 'El relay no tiene canal disponible para los modelos probados. Elige manualmente uno que sí tenga canal.',
			models: attempts.map((a) => ({ model: a.model, httpStatus: a.httpStatus, detail: a.detail })),
		}
	}

	// Codex strea siempre: un proveedor que solo sirve JSON va a fallar en uso real.
	if (streamed.ok) {
		checks.streaming = { status: 'pass', detail: 'Emite SSE como espera Codex.', ms: streamed.ms }
	} else if (plain?.ok) {
		checks.streaming = {
			status: 'warn',
			detail: `Responde en JSON pero no strea (HTTP ${streamed.httpStatus} con stream:true). Codex strea siempre: esperate cortes.`,
		}
	} else if (allModelIssues) {
		// El relay corto antes de llegar al streaming: no sabemos si strea.
		checks.streaming = {
			status: 'warn',
			detail: 'Sin comprobar: el relay rechazo el modelo antes de empezar a streamear.',
		}
	} else if (!isAuthStatus(streamed.httpStatus) && streamed.httpStatus > 0 && !streamed.sse) {
		checks.streaming = { status: 'fail', detail: 'No emite text/event-stream.' }
	}

	// Aviso de lentitud: no es un fallo, pero explica los timeouts en Codex.
	const slowest = Math.max(modelsResult.ms || 0, responses.ms || 0)
	const retried = (modelsResult.retries || 0) + (responses.retries || 0)
	if (slowest >= SLOW_MS || retried > 0) {
		const parts = []
		if (slowest >= SLOW_MS) parts.push(`la peticion mas lenta tardo ${(slowest / 1000).toFixed(1)}s`)
		if (retried > 0) parts.push(`hubo ${retried} reintento(s) por limite de ritmo o error temporal`)
		checks.latency = {
			status: 'warn',
			detail: `${parts.join('; ')}. Se instalan mas reintentos y timeouts largos para compensar.`,
			ms: slowest,
		}
		// Se refleja en el TOML para que Codex no se rinda antes de tiempo.
		slowProvider = true
	}

	// 3. Protocolos alternativos. Un exito aqui NO convierte al relay en
	// compatible con Responses: Chat necesita puente y Messages solo sirve en Claude.
	let chat = null
	let anthropic = null
	let alternateModel = target
	if (!responses.ok) {
		const healthy = attempts.find((a) => !a.unavailable && !a.quota)
		alternateModel = healthy?.model || target
		const [chatResult, anthropicRound] = await Promise.all([
			probeChat(baseUrl, apiKey, alternateModel),
			probeAnthropic(baseUrl, apiKey, alternateModel),
		])
		chat = chatResult
		anthropic = anthropicRound.best
		if (chat.ok) {
			checks.chat = {
				status: 'warn',
				detail: 'Chat Completions funciona. Codex necesita el traductor local.',
				ms: chat.ms,
			}
		} else {
			const sameProblem = isModelUnavailable(chat) || isQuotaError(chat)
			checks.chat = {
				status: 'fail',
				detail:
					`HTTP ${chat.httpStatus}: ${apiError(chat)}` +
					(sameProblem ? ` (problema del modelo "${alternateModel}", no del endpoint)` : ''),
				ms: chat.ms,
			}
		}
		checks.anthropic = anthropic.ok
			? { status: 'pass', detail: 'Anthropic Messages funciona; compatible con Claude Code.', ms: anthropic.ms }
			: { status: 'fail', detail: `HTTP ${anthropic.httpStatus}: ${apiError(anthropic)}`, ms: anthropic.ms }
	}

	// 4. Veredicto de auth: solo es "key invalida" si el rechazo persiste en los
	// endpoints que de verdad importan, y no es un bloqueo por huella.
	const probes = [modelsResult, responses, chat, anthropic].filter(Boolean)
	const anyAccepted = probes.some((r) => r.ok)
	const authRejected = probes.filter((r) => isAuthStatus(r.httpStatus))
	const allBlocked = authRejected.length > 0 && authRejected.every((r) => r.clientBlocked)
	checks.client = clientCheck(probes)

	if (anyAccepted) {
		checks.auth = {
			status: modelsAuthFail ? 'warn' : 'pass',
			detail: modelsAuthFail
				? 'Key aceptada (aunque /models la rechaza: el relay lo bloquea aparte).'
				: 'Key aceptada',
		}
	} else if (allBlocked) {
		checks.auth = {
			status: 'warn',
			detail:
				'No es la key: el relay bloquea al cliente antes de validarla. Probalo desde Codex CLI.',
		}
	} else if (authRejected.length) {
		checks.auth = { status: 'fail', detail: apiError(authRejected[0]) }
	} else {
		checks.auth = { status: 'warn', detail: 'Sin confirmar.' }
	}

	// 5. Saldo (best effort)
	checks.billing = await probeBilling(baseUrl, apiKey)

	let verdict
	if (responses.ok) verdict = 'codex_ready'
	else if (!anyAccepted && allBlocked) verdict = 'client_blocked'
	else if (!anyAccepted && authRejected.length) verdict = 'invalid_key'
	else if (allModelIssues && !allAmbiguous) {
		verdict = modelIssues.every((a) => a.quota && !a.unavailable && !a.ambiguous)
			? 'quota_exhausted'
			: 'no_channel'
	}
	else if (sweep && !sweep.found && attempts.length > MAX_MODEL_TRIES && allAmbiguous) verdict = 'no_responses'
	else if (chat?.ok) verdict = 'chat_only'
	else if (anthropic?.ok) verdict = 'claude_only'
	else if (allAmbiguous || attempts.some((a) => a.endpointMissing)) verdict = 'no_responses'
	else if (allModelIssues) {
		// La key sirve y el servidor responde: el problema es de modelo o cuota.
		verdict = modelIssues.every((a) => a.quota && !a.unavailable && !a.ambiguous)
			? 'quota_exhausted'
			: 'no_channel'
	} else verdict = 'dead'

	return {
		verdict,
		checks,
		models,
		// Se adopta si funciono en algun protocolo conocido; el veredicto conserva
		// la diferencia entre Responses, Chat y Anthropic.
		testedModel: responses.ok ? target : chat?.ok || anthropic?.ok ? alternateModel : null,
		attempts,
		supports: {
			responses: Boolean(responses.ok),
			chat: Boolean(chat?.ok),
			anthropic: Boolean(anthropic?.ok),
		},
		slow: slowProvider,
	}
}

// ------------------------------------- traductor Chat -> Responses (bridge)
//
// Para providers que solo hablan Chat Completions. El panel levanta un puente
// local por provider; Codex apunta al puente y el puente al relay real.

const bridges = new Map() // providerId -> { server, port, url, signature }

function bridgeHeaders() {
	// Mismas huellas de cliente que usa el panel: el relay ve un SDK conocido.
	const profile = CLIENT_PROFILES[0]
	return (accept) => {
		const h = buildHeaders(profile, '', { accept })
		delete h.Authorization // la pone el propio bridge con la key real
		return h
	}
}

async function startBridge(provider) {
	if (!provider.apiKey) throw new Error('Falta la API key')
	if (!provider.model) throw new Error('Elige un modelo antes de iniciar el traductor')
	const signature = JSON.stringify([provider.baseUrl, provider.apiKey, provider.model])
	const existing = bridges.get(provider.id)
	if (existing?.signature === signature) return { port: existing.port, url: existing.url, reused: true }
	if (existing) {
		await new Promise((resolve) => existing.server.close(resolve))
		bridges.delete(provider.id)
	}

	// Reusar el puerto persistido si existe; si esta ocupado, buscar otro.
	let port = Number(provider.bridgePort) || BRIDGE_BASE_PORT + bridges.size
	const server = createBridge({
		upstream: provider.baseUrl,
		apiKey: provider.apiKey,
		model: provider.model,
		headers: bridgeHeaders(),
		log: (m) => console.log(`  [bridge ${provider.id}] ${m}`),
	})

	await new Promise((resolve, reject) => {
		const onError = (error) => {
			if (error.code === 'EADDRINUSE' && port < BRIDGE_BASE_PORT + 50) {
				port += 1
				return server.listen(port, '127.0.0.1')
			}
			reject(error)
		}
		server.on('error', onError)
		server.listen(port, '127.0.0.1', () => {
			server.off('error', onError)
			resolve()
		})
	})

	const url = `http://127.0.0.1:${port}/v1`
	bridges.set(provider.id, { server, port, url, signature })
	console.log(`  Traductor levantado para "${provider.id}" en ${url}`)
	return { port, url, reused: false }
}

function stopBridge(id) {
	const live = bridges.get(id)
	if (!live) return false
	live.server.close()
	bridges.delete(id)
	return true
}

/** La URL que Codex debe usar: el puente si el relay solo tiene Chat, o directo si tiene Responses. */
function effectiveBaseUrl(provider) {
	if (!provider.useBridge) return provider.baseUrl
	const live = bridges.get(provider.id)
	return live?.url || `http://127.0.0.1:${provider.bridgePort || BRIDGE_BASE_PORT}/v1`
}

// ------------------------------------------------------------ escritura TOML

// ─────────────────────────────────────── escritura de ~/.codex/config.toml
//
// Se LEE el archivo, se entiende su estructura y se editan solo las claves que
// gestiona el panel. Nunca se hace append a ciegas: si `model` ya existe, se
// reemplaza esa linea. Duplicar una clave en TOML es un error de parseo y Codex
// se niega a arrancar.

/** Claves de la raiz que gestiona el panel. */
const ROOT_KEYS = ['model', 'model_provider', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode']

/** Lo minimo que Codex necesita para hablar con el relay. Nada mas. */
const PROVIDER_KEYS = ['name', 'base_url', 'env_key', 'wire_api']

/** Claves de reintento que jamas se escriben y se limpian si existen en config.toml. */
const RETRY_KEYS = ['request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms']

function providerValues(provider) {
	return {
		name: tomlString(provider.label || provider.id),
		base_url: tomlString(effectiveBaseUrl(provider)),
		env_key: tomlString(provider.envKey),
		wire_api: tomlString('responses'),
	}
}

/**
 * Valores validos segun la referencia de Codex. El panel NO decide: ofrece
 * estas opciones y respeta la que elija el usuario. La cadena vacia significa
 * "no escribas esta clave": si ya existe en el archivo, se deja como esta.
 */
const OPTIONS = {
	model_reasoning_effort: ['', 'minimal', 'low', 'medium', 'high', 'xhigh'],
	// on-failure esta deprecado en Codex: no se ofrece.
	approval_policy: ['', 'untrusted', 'on-request', 'never'],
	sandbox_mode: ['', 'read-only', 'workspace-write', 'danger-full-access'],
}

function pick(value, key, fallback = '') {
	const list = OPTIONS[key] || []
	return list.includes(value) ? value : fallback
}

function rootValues(provider) {
	const v = { model: tomlString(provider.model), model_provider: tomlString(provider.id) }
	const effort = pick(provider.effort || 'high', 'model_reasoning_effort') || 'high'
	const approval = pick(provider.approvalPolicy || 'never', 'approval_policy') || 'never'
	const sandbox = pick(provider.sandboxMode || 'danger-full-access', 'sandbox_mode') || 'danger-full-access'
	v.model_reasoning_effort = tomlString(effort)
	v.approval_policy = tomlString(approval)
	v.sandbox_mode = tomlString(sandbox)
	return v
}

const CONFIG_PATH = () => path.join(CODEX_HOME, 'config.toml')

/**
 * Rescata claves que solo tienen sentido en la RAIZ y acabaron dentro de un
 * `[model_providers.*]`.
 *
 * Pasa por el append ciego de versiones anteriores: al pegar un bloque de raiz
 * DESPUES de una cabecera de tabla, en TOML esas claves pasan a pertenecer a la
 * tabla. Ahi `model` o `model_provider` no existen: Codex las ignora o falla, y
 * el proveedor nunca queda realmente activo.
 */
function relocateStrayRootKeys(doc) {
	const moved = []
	for (const table of [...new Set(doc.tables())]) {
		if (!table.startsWith('model_providers.')) continue
		for (const key of ROOT_KEYS) {
			const value = doc.get(table, key)
			if (value === null) continue
			doc.remove(table, key)
			// La ultima que aparezca es la mas reciente: esa gana en la raiz.
			doc.set(null, key, value)
			moved.push({ from: table, key, value })
		}
	}
	return moved
}

function readConfig() {
	try {
		return fs.readFileSync(CONFIG_PATH(), 'utf8')
	} catch {
		return ''
	}
}

/** Marcadores de comentario que dejaban las versiones anteriores del panel. */
const OLD_MARKERS = /^#\s*(>>>|<<<)\s*codex-panel:|^#\s*Proveedor activo:/

/**
 * Aplica el proveedor al config.toml existente, editando en su sitio.
 * Devuelve el texto nuevo y un informe de lo que se encontro y se cambio.
 */
function applyToConfig(currentText, provider) {
	const doc = new TomlDoc(currentText)

	// Lo que habia antes de tocar nada.
	const before = {
		problems: doc.problems(),
		activeProvider: stripQuotes(doc.get(null, 'model_provider')),
		activeModel: stripQuotes(doc.get(null, 'model')),
		tables: doc.tables(),
	}

	// Si el archivo venia roto (append ciego de versiones viejas), se arregla.
	const repaired = doc.repair()
	const relocated = relocateStrayRootKeys(doc)
	doc.stripComments(OLD_MARKERS)

	const table = `model_providers.${provider.id}`
	const pv = providerValues(provider)
	const rv = rootValues(provider)

	const changed = []
	const kept = []

	// ── bloque del proveedor: solo nuestras claves; las ajenas se respetan
	for (const key of PROVIDER_KEYS) {
		if (pv[key] === undefined) continue
		const old = doc.get(table, key)
		if (old !== pv[key]) changed.push({ table, key, from: old, to: pv[key] })
		doc.set(table, key, pv[key])
	}

	// ── reintentos: no se escriben nunca en config.toml, se limpian si existen.
	for (const key of RETRY_KEYS) {
		const old = doc.get(table, key)
		if (old !== null) {
			changed.push({ table, key, from: old, to: '(quitado)' })
			doc.remove(table, key)
		}
	}
	const tblBlock = doc.blocksOf(table)[0]
	if (tblBlock) {
		for (const [key] of doc.entries(tblBlock)) {
			if (!PROVIDER_KEYS.includes(key) && !RETRY_KEYS.includes(key)) kept.push({ table, key })
		}
	}

	// ── raiz: el proveedor activo. Las claves que el usuario dejo en "no
	// escribir" no se tocan: si ya estaban, se quedan como estan.
	for (const key of ROOT_KEYS) {
		if (rv[key] === undefined) {
			const existing = doc.get(null, key)
			if (existing !== null) kept.push({ table: null, key })
			continue
		}
		const old = doc.get(null, key)
		if (old !== rv[key]) changed.push({ table: null, key, from: old, to: rv[key] })
		doc.set(null, key, rv[key])
	}

	const text = doc.toString()
	const errors = validate(text)
	return { text, report: { before, repaired, relocated, changed, kept, errors } }
}

function registerInConfig(currentText, provider) {
	const doc = new TomlDoc(currentText)
	const before = {
		problems: doc.problems(),
		activeProvider: stripQuotes(doc.get(null, 'model_provider')),
		activeModel: stripQuotes(doc.get(null, 'model')),
		tables: doc.tables(),
	}
	const repaired = doc.repair()
	const relocated = relocateStrayRootKeys(doc)
	doc.stripComments(OLD_MARKERS)

	const table = `model_providers.${provider.id}`
	const pv = providerValues(provider)
	const changed = []
	const kept = []

	for (const key of PROVIDER_KEYS) {
		if (pv[key] === undefined) continue
		const old = doc.get(table, key)
		if (old !== pv[key]) changed.push({ table, key, from: old, to: pv[key] })
		doc.set(table, key, pv[key])
	}

	for (const key of RETRY_KEYS) {
		const old = doc.get(table, key)
		if (old !== null) {
			changed.push({ table, key, from: old, to: '(quitado)' })
			doc.remove(table, key)
		}
	}
	const tblBlock = doc.blocksOf(table)[0]
	if (tblBlock) {
		for (const [key] of doc.entries(tblBlock)) {
			if (!PROVIDER_KEYS.includes(key) && !RETRY_KEYS.includes(key)) kept.push({ table, key })
		}
	}

	const text = doc.toString()
	const errors = validate(text)
	return { text, report: { before, repaired, relocated, changed, kept, errors } }
}

function unsetActiveFromConfig(currentText) {
	const doc = new TomlDoc(currentText)
	doc.repair()
	relocateStrayRootKeys(doc)
	doc.stripComments(OLD_MARKERS)

	for (const key of ['model_provider', 'model', 'model_reasoning_effort']) {
		doc.remove(null, key)
	}

	const text = doc.toString()
	const errors = validate(text)
	return { text, errors }
}

function removeFromConfig(currentText, provider) {
	const doc = new TomlDoc(currentText)
	doc.repair()
	relocateStrayRootKeys(doc)
	doc.stripComments(OLD_MARKERS)

	const wasActive = stripQuotes(doc.get(null, 'model_provider')) === provider.id
	doc.removeTable(`model_providers.${provider.id}`)
	// Solo se quita la raiz si apuntaba a este proveedor: si no, es de otro.
	if (wasActive) for (const key of ROOT_KEYS) doc.remove(null, key)

	const text = doc.toString()
	return { text, wasActive, errors: validate(text) }
}

function stripQuotes(v) {
	if (v == null) return null
	const t = String(v).trim()
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
		return t.slice(1, -1)
	}
	return t
}

/**
 * Que hay AHORA en el config.toml del usuario. Para poder mostrarselo en vez de
 * escribir a ciegas.
 */
function inspectConfig() {
	const text = readConfig()
	const doc = new TomlDoc(text)
	const providers = doc
		.tables()
		.filter((t) => t.startsWith('model_providers.'))
		.map((t) => ({
			id: t.slice('model_providers.'.length),
			baseUrl: stripQuotes(doc.get(t, 'base_url')),
			envKey: stripQuotes(doc.get(t, 'env_key')),
		}))
	const problems = doc.problems()
	// Claves de raiz atrapadas dentro de un bloque de proveedor.
	const stray = []
	for (const t of [...new Set(doc.tables())]) {
		if (!t.startsWith('model_providers.')) continue
		for (const key of ROOT_KEYS) {
			if (doc.get(t, key) !== null) stray.push({ table: t, key })
		}
	}

	// ── higiene: cosas que no rompen el TOML pero ensucian el archivo
	const active = stripQuotes(doc.get(null, 'model_provider'))
	const known = new Set(readStore().map((p) => p.id))

	// Varios bloques apuntando al MISMO relay (tipico de registrar la API dos
	// veces con el nombre algo distinto: "blueminds" y "bluesminds").
	const byRelay = new Map()
	for (const p of providers) {
		if (!p.baseUrl) continue
		const norm = normalizedRelay(p.baseUrl)
		if (!norm) continue
		if (!byRelay.has(norm)) byRelay.set(norm, [])
		byRelay.get(norm).push(p.id)
	}
	const duplicateRelays = []
	for (const [url, ids] of byRelay) {
		if (ids.length > 1) duplicateRelays.push({ url, ids, active: ids.find((i) => i === active) || null })
	}

	// Bloques que el panel no conoce (los borraste del panel, o son de antes).
	const orphans = providers.filter((p) => !known.has(p.id) && p.id !== active).map((p) => p.id)

	// Sobras de reintentos en config.toml.
	const legacyTuning = []
	for (const p of providers) {
		const t = `model_providers.${p.id}`
		const found = RETRY_KEYS.filter((k) => doc.get(t, k) !== null)
		if (found.length) legacyTuning.push({ table: t, keys: found })
	}

	const warnings = []
	if (orphans.length) warnings.push(`${orphans.length} bloque(s) que el panel ya no gestiona: ${orphans.join(', ')}`)
	for (const l of legacyTuning) {
		warnings.push(`[${l.table}] tiene ${l.keys.join(', ')} que escribio una version anterior del panel`)
	}

	return {
		stray,
		active,
		duplicateRelays,
		orphans,
		legacyTuning,
		warnings,
		clean: warnings.length === 0,
		path: CONFIG_PATH(),
		exists: text !== '',
		bytes: Buffer.byteLength(text),
		activeProvider: stripQuotes(doc.get(null, 'model_provider')),
		activeModel: stripQuotes(doc.get(null, 'model')),
		providers,
		otherTables: doc.tables().filter((t) => !t.startsWith('model_providers.')),
		problems,
		errors: validate(text),
		healthy:
			problems.duplicateTables.length === 0 &&
			problems.duplicateKeys.length === 0 &&
			stray.length === 0,
	}
}

/**
 * Sincroniza los proveedores del almacén con los valores reales presentes en config.toml.
 * La fuente de verdad para el proveedor activo y sus tablas es config.toml.
 */
function syncWithConfig(providers) {
	const text = readConfig()
	if (!text) {
		for (const p of providers) {
			p.installed = false
			p.inConfig = false
		}
		return providers
	}
	const doc = new TomlDoc(text)
	const activeProvider = stripQuotes(doc.get(null, 'model_provider'))
	const activeModel = stripQuotes(doc.get(null, 'model'))
	const activeEffort = stripQuotes(doc.get(null, 'model_reasoning_effort'))
	const activeApproval = stripQuotes(doc.get(null, 'approval_policy'))
	const activeSandbox = stripQuotes(doc.get(null, 'sandbox_mode'))

	for (const p of providers) {
		const table = `model_providers.${p.id}`
		const hasTable = doc.tables().includes(table)
		p.inConfig = hasTable
		p.installed = Boolean(hasTable && activeProvider === p.id)
		if (hasTable) {
			const tableEnv = stripQuotes(doc.get(table, 'env_key'))
			if (tableEnv) p.envKey = tableEnv
		}
		if (p.installed) {
			if (activeModel) p.model = activeModel
			if (activeEffort !== null) p.effort = activeEffort
			if (activeApproval !== null) p.approvalPolicy = activeApproval
			if (activeSandbox !== null) p.sandboxMode = activeSandbox
		}
	}
	return providers
}

/**
 * Los unicos archivos que el panel abre para editar. Nada de rutas libres:
 * el panel escucha en local, pero no hay razon para exponer el disco.
 */
const FILES = {
	get codex() {
		return { path: CONFIG_PATH(), label: 'Codex — config.toml', kind: 'toml' }
	},
	get claude() {
		return {
			path: path.join(os.homedir(), '.claude', 'settings.json'),
			label: 'Claude Code — settings.json',
			kind: 'json',
			template: '{\n  "env": {}\n}\n',
		}
	},
	get env() {
		return {
			path: IS_WIN ? ENV_FILE_CMD : ENV_FILE,
			label: IS_WIN ? 'Panel — env.cmd' : 'Panel — env.sh',
			kind: 'text',
		}
	},
}

/** Errores que impiden guardar. Se valida antes de tocar el disco. */
function checkFile(kind, content) {
	if (kind === 'toml') return validate(content)
	if (kind === 'json') {
		if (content.trim() === '') return []
		try {
			const parsed = JSON.parse(content)
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return ['el JSON debe ser un objeto { ... }']
			}
			return []
		} catch (error) {
			return ['JSON invalido: ' + error.message]
		}
	}
	return []
}

/** Deja el config.toml valido sin cambiar de proveedor. */
function repairConfig() {
	const text = readConfig()
	if (!text) return { changed: false, repaired: { tables: [], keys: [] } }
	const doc = new TomlDoc(text)
	const fixed = doc.repair()
	fixed.relocated = relocateStrayRootKeys(doc)
	doc.stripComments(OLD_MARKERS)
	const next = doc.toString()
	const errors = validate(next)
	if (errors.length) throw new Error('No se pudo reparar: ' + errors.join('; '))
	if (next !== text) {
		backupConfig()
		atomicWrite(CONFIG_PATH(), next)
	}
	return { changed: next !== text, repaired: fixed, path: CONFIG_PATH() }
}

/** Respaldo con fecha, conservando solo los ultimos few. */
function backupConfig(limit = 5) {
	const file = CONFIG_PATH()
	if (!fs.existsSync(file)) return false
	fs.copyFileSync(file, path.join(CODEX_HOME, `config.toml.${stamp()}.bak`))
	try {
		const baks = fs
			.readdirSync(CODEX_HOME)
			.filter((f) => /^config\.toml\..*\.bak$/.test(f))
			.sort()
		for (const old of baks.slice(0, Math.max(0, baks.length - limit))) {
			fs.unlinkSync(path.join(CODEX_HOME, old))
		}
	} catch {}
	return true
}

/**
 * Escribe la key en los tres formatos, porque `source env.sh` no existe en
 * Windows y era la causa de que las instrucciones no funcionaran ahi.
 */
function writeEnvFile(providers) {
	ensureHome()
	const warn = 'Generado por Codex Panel. Contiene secretos: no lo subas a git.'
	const activeId = stripQuotes(new TomlDoc(readConfig()).get(null, 'model_provider'))
	const active = providers.find((p) => p.id === activeId)

	const sh = ['#!/bin/sh', '# ' + warn, '']
	const cmd = ['@echo off', ':: ' + warn, '']
	if (active?.apiKey && active.envKey) {
		assertEnvKey(active.envKey)
		assertSecret(active.apiKey)
		sh.push(`export ${active.envKey}=${shellQuote(active.apiKey)}`)
		cmd.push(cmdSet(active.envKey, active.apiKey))
	}

	atomicWrite(ENV_FILE, sh.join('\n') + '\n')
	atomicWrite(ENV_FILE_CMD, cmd.join('\n') + '\n')
	return IS_WIN ? ENV_FILE_CMD : ENV_FILE
}

function install(provider, providers) {
	fs.mkdirSync(CODEX_HOME, { recursive: true })
	const configPath = CONFIG_PATH()
	const current = readConfig()

	const { text, report } = applyToConfig(current, provider)
	if (report.errors.length) {
		// Antes de escribir algo que Codex rechazaria, se aborta.
		throw new Error('El config.toml resultante seria invalido: ' + report.errors.join('; '))
	}

	if (text !== current) {
		if (current) backupConfig()
		atomicWrite(configPath, text)
	}

	// Solo se limpian perfiles legacy pertenecientes a proveedores conocidos.
	const removedFiles = []
	const legacyFiles = new Set(providers.map((p) => `${p.profile || p.id}.config.toml`))
	for (const f of legacyFiles) {
		const legacyPath = path.join(CODEX_HOME, f)
		if (!fs.existsSync(legacyPath)) continue
		fs.unlinkSync(legacyPath)
		removedFiles.push(f)
	}

	const envPath = writeEnvFile(providers)
	return { configPath, envPath, report, removedFiles, unchanged: text === current }
}

function uninstall(provider) {
	const configPath = CONFIG_PATH()
	const current = readConfig()
	if (!current) return { unchanged: true }
	const { text, wasActive, errors } = removeFromConfig(current, provider)
	if (errors.length) throw new Error('El config.toml resultante seria invalido: ' + errors.join('; '))
	if (text !== current) {
		backupConfig()
		atomicWrite(configPath, text)
	}
	return { wasActive, unchanged: text === current }
}

/** El env_key que hay escrito en config.toml para ese proveedor, si lo hay. */
function configEnvKey(id) {
	try {
		const doc = new TomlDoc(readConfig())
		return stripQuotes(doc.get(`model_providers.${id}`, 'env_key'))
	} catch {
		return null
	}
}

/**
 * Como usar la API una vez probada, segun la herramienta de destino.
 *
 * En Windows se usa SOLO `set`, con ambito de esa terminal. Nada mas.
 */
function usageGuide(provider, target = 'codex') {
	const setVar = (name, value) => (IS_WIN ? cmdSet(name, value) : `export ${name}=${shellQuote(value)}`)
	const keyVal = provider.apiKey || '<TU_API_KEY>'
	const claudeBaseUrl = String(provider.baseUrl || '').replace(/\/v1\/?$/i, '')
	const claudeSettings = IS_WIN
		? '%USERPROFILE%\\.claude\\settings.json'
		: '~/.claude/settings.json'

	if (target === 'claude') {
		const claudeFile = path.join(os.homedir(), '.claude', 'settings.json')
		let currentSettings = {}
		try {
			if (fs.existsSync(claudeFile)) currentSettings = JSON.parse(fs.readFileSync(claudeFile, 'utf8'))
		} catch {}

		const mergedPreview = {
			...currentSettings,
			env: {
				...(currentSettings.env || {}),
				ANTHROPIC_BASE_URL: claudeBaseUrl,
				ANTHROPIC_AUTH_TOKEN: keyVal,
				ANTHROPIC_MODEL: provider.model || '<modelo>',
			},
			permissions: currentSettings.permissions || {
				defaultMode: 'bypassPermissions',
				allow: ['Bash'],
			},
			skipDangerousModePermissionPrompt: currentSettings.skipDangerousModePermissionPrompt ?? true,
		}
		const json = JSON.stringify(mergedPreview, null, 2)
		const effortVal = provider.effort || 'high'
		const effortFlag = effortVal ? ` --effort ${effortVal}` : ''
		return {
			target: 'claude',
			label: 'Claude Code',
			model: provider.model,
			needsInstall: false,
			supported: provider.supports?.anthropic ?? provider.lastTest?.supports?.anthropic ?? null,
			steps: [
				{
					title: 'Opcion A — Ejecutar en la terminal',
					cmds: [
						setVar('ANTHROPIC_BASE_URL', claudeBaseUrl),
						setVar('ANTHROPIC_AUTH_TOKEN', keyVal),
						setVar('ANTHROPIC_MODEL', provider.model || '<modelo>'),
						`claude --dangerously-skip-permissions${effortFlag}`,
					],
					detail: 'Dónde ejecutar: En una misma ventana de terminal.',
				},
				{
					title: 'Opcion B — Fijo, editando su settings.json',
					file: claudeSettings,
					json,
					detail: 'Claude Code lo lee siempre al arrancar. Es JSON estricto.',
				},
				{
					title: 'Resultado esperado',
					detail: 'Dentro de Claude Code escribe /status: debe mostrar la URL de tu relay y el modelo activo.',
				},
			],
			notes: [
				'Si el relay te dio una "api key" en vez de un "bearer token", usa ANTHROPIC_API_KEY en lugar de ANTHROPIC_AUTH_TOKEN.',
				'Prioridad de Claude Code: Si tu settings.json tiene variables de proveedor en "env", Claude Code siempre las prioriza y anula las de la terminal. Usa "Configurar Claude para Multiterminal" para mantener "env" limpio y el Modo YOLO activo.',
			],
		}
	}

	if (target === 'curl') {
		return {
			target: 'curl',
			label: 'Probar a mano',
			model: provider.model,
			needsInstall: false,
			steps: [
				{
					title: 'Ejecutar en la terminal',
					cmds: [
						`curl ${provider.baseUrl}/chat/completions -H "Authorization: Bearer ${keyVal}" -H "Content-Type: application/json" -d "{\"model\":\"${provider.model || '<modelo>'}\",\"messages\":[{\"role\":\"user\",\"content\":\"hola\"}]}"`,
					],
					detail: 'Dónde ejecutar: Abre tu terminal.',
				},
				{
					title: 'Resultado esperado',
					detail: 'Debes recibir un JSON con la respuesta del modelo en {"choices":[{"message":{"content":"..."}}]}. Si devuelve código 200 y texto de respuesta, la API y el modelo están funcionando.',
				},
			],
			notes: [],
		}
	}

	// ── Codex CLI (por defecto)
	//
	// La variable se lee del config.toml REAL. Si ahi pone otra cosa (por ejemplo
	// un env_key de una version anterior del panel), la instruccion tiene que
	// decir esa, o el usuario exporta una variable que Codex no mira.
	const inConfig = configEnvKey(provider.id)
	const envKey = inConfig || provider.envKey || ENV_KEY
	const modelName = provider.model || '<modelo>'
	const effortVal = provider.effort || 'high'
	const effortParam = ` -c model_reasoning_effort="${effortVal}"`
	const runCmd = `codex --dangerously-bypass-approvals-and-sandbox -c model_provider="${provider.id}" -c model="${modelName}"${effortParam}`

	const steps = [
		{
			title: 'Configura tu API Key en la terminal',
			cmds: [setVar(envKey, keyVal)],
			detail:
				inConfig && inConfig !== ENV_KEY
					? `Dónde ejecutar: En tu terminal. Tu config.toml usa "${inConfig}". Si reinstalas desde el panel pasara a llamarse ${ENV_KEY}.`
					: 'Dónde ejecutar: En tu terminal (ámbito de esta ventana).',
			needsKey: true,
		},
	]

	if (provider.useBridge) {
		steps.push({
			title: 'Mantén Node activo (Puente traductor local requerido)',
			detail: `Gorouter solo ofrece Chat Completions y Codex CLI exige Responses. El panel traduce las peticiones en segundo plano en 127.0.0.1. Debes mantener "node server.js" encendido mientras uses Codex.`,
		})
	} else {
		steps.push({
			title: 'Conexión directa a internet (No requiere Node)',
			detail: `Este proveedor soporta Responses directamente. Puedes cerrar el panel y apagar "node server.js"; Codex se conectará de forma 100% autónoma.`,
		})
	}

	steps.push({
		title: 'Arranca Codex fijando este modelo',
		cmds: [runCmd],
		detail: `Ejecuta este comando para arrancar directamente en tu terminal con "${modelName}" en Modo YOLO sin confirmaciones (razonamiento: ${effortVal}). Te permite abrir múltiples terminales con diferentes modelos o proveedores en paralelo.`,
	})
	steps.push({
		title: 'Resultado esperado',
		detail: `Codex arrancará conectado. Escribe /model dentro de Codex y responderá "${modelName}".`,
	})

	return {
		target: 'codex',
		label: 'Codex CLI',
		model: provider.model,
		needsInstall: true,
		envKey,
		steps,
		notes: [
			'Cada terminal nueva necesita el "set" otra vez.',
			'Si cambias de proveedor en el panel, el comando es el mismo: solo cambia la key.',
		],
	}
}

function launchCommand(provider) {
	const g = usageGuide(provider, 'codex')
	return g.steps
		.filter((x) => x.cmds)
		.flatMap((x) => x.cmds)
		.join('\n')
}

// ---------------------------------------------------------------- http server

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
}

function securityHeaders() {
	return {
		'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'",
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
	}
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload)
	res.writeHead(status, {
		...securityHeaders(),
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store', 
		'Content-Length': Buffer.byteLength(body),
	})
	res.end(body)
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		let settled = false
		const fail = (error) => {
			if (settled) return
			settled = true
			reject(error)
		}
		const onData = (chunk) => {
			size += chunk.length
			if (size > 1e6) {
				chunks.length = 0
				req.removeListener('data', onData)
				req.resume()
				return fail(new Error('Body demasiado grande'))
			}
			chunks.push(chunk)
		}
		req.on('data', onData)
		req.on('end', () => {
			if (settled) return
			settled = true
			try {
				const data = Buffer.concat(chunks).toString('utf8')
				resolve(data ? JSON.parse(data) : {})
			} catch {
				reject(new Error('JSON invalido'))
			}
		})
		req.on('error', fail)
	})
}

/** La interfaz local muestra la key completa por decision explicita del usuario. */
function publicView(provider) {
	return {
		...provider,
		keyMask: maskKey(provider.apiKey),
		hasKey: Boolean(provider.apiKey),
	}
}

function serveStatic(req, res) {
	const urlPath = req.url.split('?')[0]
	const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
	const full = path.resolve(PUBLIC_DIR, rel)
	const relative = path.relative(PUBLIC_DIR, full)
	if (relative.startsWith('..') || path.isAbsolute(relative)) return sendJson(res, 403, { error: 'forbidden' })
	fs.readFile(full, (err, buf) => {
		if (err) {
			res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
			return res.end('No encontrado')
		}
		res.writeHead(200, {
			...securityHeaders(),
			'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
			'Cache-Control': 'no-store',
		})
		res.end(buf)
	})
}

function readClaudeConfig() {
	try {
		const file = path.join(os.homedir(), '.claude', 'settings.json')
		if (!fs.existsSync(file)) return { exists: false, hasProviderEnv: false, isYolo: false, baseUrl: '', model: '', apiKey: '' }
		const json = JSON.parse(fs.readFileSync(file, 'utf8'))
		const env = json?.env || {}
		const baseUrl = env.ANTHROPIC_BASE_URL || ''
		const model =
			env.ANTHROPIC_MODEL ||
			env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
			env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
			env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
			''
		const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || ''
		const hasProviderEnv = Boolean(
			baseUrl ||
			apiKey ||
			env.ANTHROPIC_MODEL ||
			env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
			env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
			env.ANTHROPIC_DEFAULT_HAIKU_MODEL
		)
		const isYolo =
			json?.permissions?.defaultMode === 'bypassPermissions' &&
			json?.skipDangerousModePermissionPrompt === true
		return {
			exists: true,
			hasProviderEnv,
			isYolo,
			baseUrl,
			model,
			apiKey,
			opusModel: env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
			sonnetModel: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
			haikuModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
		}
	} catch {
		return { exists: false, hasProviderEnv: false, isYolo: false, baseUrl: '', model: '', apiKey: '' }
	}
}

function cleanClaudeConfig(provider) {
	if (!provider || !provider.baseUrl) return
	try {
		const file = path.join(os.homedir(), '.claude', 'settings.json')
		if (!fs.existsSync(file)) return
		const json = JSON.parse(fs.readFileSync(file, 'utf8'))
		const env = json?.env
		if (!env || typeof env !== 'object') return

		const curBase = String(env.ANTHROPIC_BASE_URL || '').replace(/\/v1\/?$/i, '').trim().toLowerCase()
		const provBase = String(provider.baseUrl || '').replace(/\/v1\/?$/i, '').trim().toLowerCase()
		const curHost = curBase.replace(/^https?:\/\//i, '').split('/')[0]
		const provHost = provBase.replace(/^https?:\/\//i, '').split('/')[0]

		if (curBase && (curBase === provBase || (curHost && curHost === provHost))) {
			backupFile(file)
			delete env.ANTHROPIC_BASE_URL
			delete env.ANTHROPIC_AUTH_TOKEN
			delete env.ANTHROPIC_API_KEY
			delete env.ANTHROPIC_MODEL
			delete env.ANTHROPIC_DEFAULT_OPUS_MODEL
			delete env.ANTHROPIC_DEFAULT_SONNET_MODEL
			delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL
			atomicWrite(file, JSON.stringify(json, null, 2) + '\n')
		}
	} catch {}
}

const routes = {
	'GET /api/state': async () => {
		const storedProviders = readStore()
		const installedBefore = new Map(storedProviders.map((p) => [p.id, Boolean(p.installed)]))
		const providers = syncWithConfig(storedProviders)
		let storeChanged = providers.some((p) => p.installed !== installedBefore.get(p.id))
		for (const provider of providers) {
			const needsBridge = provider.useBridge || provider.lastTest?.verdict === 'chat_only' || provider.lastTest?.verdict === 'no_responses' || (provider.model && provider.modelResults?.[provider.model] && provider.modelResults[provider.model].target !== 'responses')
			if (!provider.installed || !needsBridge || !provider.model) continue
			if (!provider.useBridge) {
				provider.useBridge = true
				storeChanged = true
			}
			const bridge = await startBridge(provider)
			if (provider.bridgePort !== bridge.port) {
				provider.bridgePort = bridge.port
				storeChanged = true
			}
			const configured = stripQuotes(
				new TomlDoc(readConfig()).get(`model_providers.${provider.id}`, 'base_url'),
			)
			if (configured !== bridge.url) install(provider, providers)
		}
		if (storeChanged) writeStore(providers)
		// Marcar los que comparten relay, para poder avisarlo en la interfaz.
		const twins = new Set()
		for (const a of providers) {
			for (const b of providers) {
				if (a.id !== b.id && sameRelay(a.baseUrl, b.baseUrl)) twins.add(a.id)
			}
		}
		return {
			providers: providers.map((p) => ({
				...publicView(p),
				sharesRelay: twins.has(p.id),
				usage: p.installed && p.model ? usageGuide(p) : null,
			})),
			claude: readClaudeConfig(),
			options: OPTIONS,
			paths: { panelHome: PANEL_HOME, codexHome: CODEX_HOME, envFile: ENV_FILE },
		}
	},

	'POST /api/models': async (body) => {
		const providers = readStore()
		const stored = providers.find((p) => p.id === body.id)
		const apiKey = body.apiKey || stored?.apiKey
		const baseUrl = body.baseUrl || stored?.baseUrl
		const { result, models } = await listModels(baseUrl, apiKey)
		let error = null
		if (!result.ok) {
			error = result.clientBlocked
				? 'El relay bloquea /models por huella de cliente. Escribi el modelo a mano y testea.'
				: apiError(result)
		}
		return { models, httpStatus: result.httpStatus, clientBlocked: Boolean(result.clientBlocked), error }
	},

	'POST /api/chat': async (body) => {
		const providers = readStore()
		const stored = providers.find((p) => p.id === body.id)
		const apiKey = body.apiKey || stored?.apiKey
		const baseUrl = body.baseUrl || stored?.baseUrl
		const model = body.model || stored?.model
		if (!baseUrl || !apiKey) throw new Error('Faltan baseUrl o apiKey')
		if (!model) throw new Error('Falta el modelo')
		const messages = Array.isArray(body.messages) && body.messages.length ? body.messages : [{ role: 'user', content: String(body.prompt || 'Hola') }]

		const started = Date.now()
		const isClaude = /claude/i.test(model)
		let anthRes = null

		// 1. Si es modelo Claude, probamos primero /v1/messages (Anthropic)
		if (isClaude) {
			anthRes = await probeSmart(endpoint(baseUrl, '/messages'), {
				apiKey,
				method: 'POST',
				extraHeaders: {
					'anthropic-version': '2023-06-01',
					'x-api-key': apiKey,
					'User-Agent': 'claude-cli/1.0.0',
				},
				json: {
					model,
					max_tokens: 1024,
					system: messages
						.filter((m) => m.role === 'system')
						.map((m) => String(m.content))
						.join('\n') || undefined,
					messages: messages
						.filter((m) => m.role !== 'system')
						.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
				},
			})
			if (anthRes.ok && !anthRes.json?.error) {
				const contentArr = anthRes.json?.content || []
				const replyText = contentArr.map((c) => (typeof c === 'string' ? c : c.text || '')).join('').trim()
				if (replyText) {
					return {
						ok: true,
						model,
						protocol: 'anthropic',
						ms: Date.now() - started,
						retries: anthRes.retries || 0,
						reply: replyText,
					}
				}
			}
		}

		const CHAT_MAX_MS = 14500
		const remaining = () => CHAT_MAX_MS - (Date.now() - started)

		const effort = body.effort || stored?.effort || 'high'

		// 2. Probar OpenAI /chat/completions
		let chatRes = null
		if (remaining() >= 2000) {
			const chatPayload = {
				model,
				messages: messages.map((m) => ({ role: m.role, content: String(m.content) })),
				max_tokens: 1024,
				stream: false,
			}
			if (effort) chatPayload.reasoning_effort = effort

			chatRes = await probeSmart(endpoint(baseUrl, '/chat/completions'), {
				apiKey,
				method: 'POST',
				json: chatPayload,
			})
			if (chatRes.ok && !chatRes.json?.error) {
				const replyText = (chatRes.json?.choices?.[0]?.message?.content || '').trim()
				if (replyText) {
					return {
						ok: true,
						model,
						protocol: 'chat',
						ms: Date.now() - started,
						retries: chatRes.retries || 0,
						reply: replyText,
						effort: effort || null,
					}
				}
			}
		}

		// 3. Probar /responses conservando el historial completo.
		let respRes = null
		if (remaining() >= 2000) {
			const respPayload = {
				model,
				input: messages.map((m) => ({
					role: ['assistant', 'system'].includes(m.role) ? m.role : 'user',
					content: String(m.content),
				})),
				max_output_tokens: 1024,
				stream: false,
			}
			if (effort) respPayload.reasoning_effort = effort

			respRes = await probeSmart(endpoint(baseUrl, '/responses'), {
				apiKey,
				method: 'POST',
				json: respPayload,
			})
			if (respRes.ok && !respRes.json?.error) {
				const replyText = (responseText(respRes.json) || '').trim()
				if (replyText) {
					return {
						ok: true,
						model,
						protocol: 'responses',
						ms: Date.now() - started,
						retries: respRes.retries || 0,
						reply: replyText,
						effort: effort || null,
					}
				}
			}
		}

		if (Date.now() - started >= 14000) {
			throw new Error('Tiempo de espera agotado (15s máx). El relay tardó demasiado en responder.')
		}

		const failed = isClaude && anthRes ? anthRes : (chatRes?.httpStatus ? chatRes : (respRes || anthRes || chatRes))
		throw new Error(apiError(failed) || `Error al consultar el modelo (HTTP ${failed?.httpStatus || 504})`)
	},

	'POST /api/test': async (body) => {
		const providers = readStore()
		const index = providers.findIndex((p) => p.id === body.id)
		const stored = index >= 0 ? providers[index] : null
		const report = await runTest({
			baseUrl: body.baseUrl || stored?.baseUrl,
			apiKey: body.apiKey || stored?.apiKey,
			model: body.model || stored?.model,
		})
		if (stored) {
			const resMap = { ...(stored.modelResults || {}) }
			for (const a of report.attempts || []) {
				resMap[a.model] = {
					model: a.model,
					ok: a.ok,
					httpStatus: a.httpStatus,
					detail: a.detail,
					reason: a.ok ? null : a.unavailable ? 'sin canal' : a.quota ? 'cuota agotada' : a.ambiguous ? 'no acepta este modelo' : 'error',
				}
			}
			const needsBridge = report.verdict === 'chat_only' || report.verdict === 'no_responses'
			const chosenModel = stored.model || report.testedModel || ''
			const updated = {
				...stored,
				model: chosenModel,
				useBridge: needsBridge ? true : stored.useBridge,
				slow: Boolean(report.slow),
				supports: report.supports,
				lastTest: {
					at: new Date().toISOString(),
					verdict: report.verdict,
					checks: report.checks,
					supports: report.supports,
				},
				modelResults: resMap,
			}
			providers[index] = updated

			const active = stripQuotes(new TomlDoc(readConfig()).get(null, 'model_provider')) === stored.id
			if (active && updated.model) {
				let bridge = null
				if (updated.useBridge) {
					try {
						bridge = await startBridge(updated)
						updated.bridgePort = bridge.port
						install(updated, providers)
					} catch (error) {
						if (bridge && !bridge.reused) stopBridge(updated.id)
						throw error
					}
				} else {
					stopBridge(updated.id)
					install(updated, providers)
				}
			}
			writeStore(providers)
		}
		return report
	},

	'POST /api/provider': async (body) => {
		if (!body.label) throw new Error('Falta el nombre')
		let parsedUrl
		try {
			parsedUrl = new URL(String(body.baseUrl || ''))
		} catch {
			throw new Error('Base URL invalida')
		}
		if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Base URL debe empezar con http(s)://')
		if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
			throw new Error('Base URL no puede incluir credenciales, query ni fragmento')
		}
		if (body.apiKey) assertSecret(body.apiKey)

		const providers = readStore()
		const targetLabel = String(body.label || '').trim()
		if (!targetLabel) throw new Error('El nombre es obligatorio')

		const isNew = !body.id
		const cleanTarget = targetLabel.toLowerCase()
		const targetSlug = slug(targetLabel)
		const id = isNew ? targetSlug : slug(body.id)
		if (!id) throw new Error('Nombre invalido')

		// No permitir nombres duplicados (case-insensitive)
		const duplicate = providers.find((p) => {
			if (!isNew && p.id === body.id) return false
			return p.label.trim().toLowerCase() === cleanTarget || slug(p.label) === targetSlug || p.id === targetSlug
		})

		if (duplicate) {
			throw new Error(`Ya existe un proveedor con el nombre "${duplicate.label}". Elige otro nombre.`)
		}

		const index = isNew ? -1 : providers.findIndex((p) => p.id === body.id)
		const previous = index >= 0 ? providers[index] : null
		const baseUrl = body.baseUrl.trim().replace(/\/+$/, '')

		// Mismo relay ya registrado con otro nombre: antes se creaba un segundo
		// provider que competia por el mismo config.toml. Ahora se avisa.
		if (!body.force && (!previous || !sameRelay(previous.baseUrl, baseUrl))) {
			const twin = providers.find((p) => p.id !== id && sameRelay(p.baseUrl, baseUrl))
			if (twin) {
				return {
					conflict: {
						kind: 'same_relay',
						id: twin.id,
						label: twin.label,
						installed: Boolean(twin.installed),
						model: twin.model || null,
						message: `Ya tienes registrado "${twin.label}" con esta misma URL. Puedes guardarla como una cuenta separada para usar en distintas terminales o editar la existente.`,
					},
				}
			}
		}

		// El perfil es el nombre del archivo .config.toml: no puede chocar.
		let profile = slug(body.profile || id)
		const taken = (name) => providers.some((p) => p.id !== id && p.profile === name)
		if (taken(profile)) {
			let n = 2
			while (taken(`${profile}-${n}`)) n++
			profile = `${profile}-${n}`
		}

		const envKey = String(body.envKey || previous?.envKey || envKeyFor(id)).trim() || ENV_KEY
		assertEnvKey(envKey)
		const connectionChanged = Boolean(
			previous && (previous.baseUrl !== baseUrl || (body.apiKey && body.apiKey.trim() !== previous.apiKey)),
		)
		const provider = {
			id,
			label: body.label.trim(),
			baseUrl,
			apiKey: body.apiKey ? body.apiKey.trim() : previous?.apiKey || '',
			model: (body.model || previous?.model || '').trim(),
			profile,
			// Editable: si tu config.toml ya usa otro nombre, puedes ponerlo aqui.
			envKey,
			// Ajustes seguros por defecto para proveedores nuevos.
			effort: body.effort ? (pick(body.effort, 'model_reasoning_effort') || 'high') : (previous?.effort || 'high'),
			approvalPolicy: body.approvalPolicy
				? pick(body.approvalPolicy, 'approval_policy')
				: (previous?.approvalPolicy || 'never'),
			sandboxMode: body.sandboxMode
				? pick(body.sandboxMode, 'sandbox_mode')
				: (previous?.sandboxMode || 'danger-full-access'),
			useBridge: body.useBridge === true || (body.useBridge === undefined && previous?.useBridge === true),
			slow: body.slow === true || (body.slow === undefined && previous?.slow === true),
			bridgePort: previous?.bridgePort || null,
			installed: previous?.installed || false,
			lastTest: connectionChanged ? null : previous?.lastTest || null,
			modelResults: connectionChanged ? {} : previous?.modelResults || {},
			supports: connectionChanged ? null : previous?.supports || null,
		}
		if (index >= 0) providers[index] = provider
		else providers.push(provider)

		const active = stripQuotes(new TomlDoc(readConfig()).get(null, 'model_provider')) === id
		if (active && provider.useBridge) {
			const bridge = await startBridge(provider)
			provider.bridgePort = bridge.port
		}
		if (active && provider.model) install(provider, providers)
		writeStore(providers)
		return { provider: publicView(provider) }
	},

	/**
	 * Prueba TODOS los modelos del catalogo contra /v1/responses y devuelve
	 * cuales sirven. Es la respuesta definitiva cuando el relay no expone
	 * metadatos: en vez de adivinar por el nombre, se mide.
	 */
	'POST /api/scan-models': async (body) => {
		const providers = readStore()
		const stored = providers.find((p) => p.id === body.id)
		const apiKey = body.apiKey || stored?.apiKey
		const baseUrl = body.baseUrl || stored?.baseUrl
		if (!baseUrl || !apiKey) throw new Error('Faltan baseUrl o apiKey')

		newSession()
		const discovery = await discoverModelSupport(baseUrl, apiKey)
		const { models } = await listModels(baseUrl, apiKey)
		let pool = models.length
			? models
			: discovery.responses.length
				? discovery.responses
				: discovery.channelBacked
		pool = orderCandidates(pool, discovery)
		if (!pool.length) throw new Error('El relay no expone catalogo ni metadatos de modelos')

		const { results: swept } = await sweepModels(baseUrl, apiKey, pool, {
			max: Number(body.limit) || SCAN_MAX,
			concurrency: 3,
			checkAllProtocols: true,
		})
		const results = swept.map(({ round, ...rest }) => ({
			...rest,
			declaresResponses: discovery.responses.includes(rest.model),
		}))
		results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.model.localeCompare(b.model))
		return {
			results,
			working: results.filter((r) => r.ok).map((r) => r.model),
			scanned: results.length,
			total: pool.length,
			discovery: { responses: discovery.responses, sources: discovery.sources, group: discovery.group },
		}
	},

	/** Prueba UN modelo concreto. Para el que el usuario elige a mano. */
	'POST /api/test-model': async (body) => {
		const providers = readStore()
		const index = providers.findIndex((p) => p.id === body.id)
		const stored = index >= 0 ? providers[index] : null
		const apiKey = body.apiKey || stored?.apiKey
		const baseUrl = body.baseUrl || stored?.baseUrl
		if (!baseUrl || !apiKey) throw new Error('Faltan baseUrl o apiKey')
		if (!body.model) throw new Error('Falta el modelo')

		newSession()
		const round = await probeResponses(baseUrl, apiKey, body.model)
		let r = round.best
		let target = 'responses'
		if (!r.ok && !isAuthStatus(r.httpStatus) && r.httpStatus !== 0) {
			const isClaude = /claude/i.test(body.model)
			const [chatRes, anthRound] = await Promise.all([
				probeChat(baseUrl, apiKey, body.model),
				probeAnthropic(baseUrl, apiKey, body.model),
			])
			if (isClaude && anthRound.best.ok) {
				r = anthRound.best
				target = 'claude'
			} else if (chatRes.ok) {
				r = chatRes
				target = 'chat'
			} else if (anthRound.best.ok) {
				r = anthRound.best
				target = 'claude'
			}
		}

		const res = {
			model: body.model,
			ok: r.ok,
			httpStatus: r.httpStatus,
			ms: r.ms,
			target,
			streams: target === 'responses' ? Boolean(round.streamed?.ok) : false,
			reason: classifyReason(r),
			detail: r.ok
				? target === 'claude'
					? 'Responde a /v1/messages (Claude Code)'
					: target === 'chat'
						? 'Responde a /v1/chat/completions (Chat)'
						: 'Responde a /v1/responses (Codex)'
				: apiError(r),
		}
		if (stored) {
			providers[index] = {
				...stored,
				modelResults: { ...(stored.modelResults || {}), [body.model]: res },
			}
			writeStore(providers)
		}
		return res
	},

	/** Fija el modelo del provider sin tocar el resto de la config. */
	/**
	 * Fija el modelo. Si el provider ya estaba instalado, se reescribe SU MISMO
	 * perfil en sitio: no se crea otro .config.toml, que era la queja.
	 */
	'POST /api/set-model': async (body) => {
		const providers = readStore()
		const index = providers.findIndex((p) => p.id === body.id)
		if (index < 0) throw new Error('Provider desconocido')

		const provider = { ...providers[index], model: String(body.model || '').trim() }
		providers[index] = provider

		const needsBridge = provider.useBridge || provider.lastTest?.verdict === 'chat_only' || provider.lastTest?.verdict === 'no_responses' || (provider.model && provider.modelResults?.[provider.model] && provider.modelResults[provider.model].target !== 'responses')
		if (needsBridge) provider.useBridge = true

		let reapplied = false
		const active = stripQuotes(new TomlDoc(readConfig()).get(null, 'model_provider')) === provider.id
		if (active && provider.model) {
			if (provider.useBridge) {
				const bridge = await startBridge(provider)
				provider.bridgePort = bridge.port
			}
			install(provider, providers)
			reapplied = true
		}
		writeStore(providers)
		return {
			provider: publicView(provider),
			reapplied,
			profilePath: reapplied ? CONFIG_PATH() : null,
			usage: active ? usageGuide(provider) : null,
		}
	},

	'POST /api/set-effort': async (body) => {
		const providers = readStore()
		const index = providers.findIndex((p) => p.id === body.id)
		if (index < 0) throw new Error('Provider desconocido')

		const effort = pick(body.effort || 'high', 'model_reasoning_effort') || 'high'
		const provider = { ...providers[index], effort }
		providers[index] = provider

		let reapplied = false
		const active = stripQuotes(new TomlDoc(readConfig()).get(null, 'model_provider')) === provider.id
		if (active && provider.model) {
			install(provider, providers)
			reapplied = true
		}
		writeStore(providers)
		return {
			provider: publicView(provider),
			reapplied,
			usage: active ? usageGuide(provider) : null,
		}
	},

	'POST /api/test-effort': async (body) => {
		const providers = readStore()
		const p = providers.find((x) => x.id === body.id)
		if (!p) throw new Error('Proveedor no encontrado')
		const model = String(body.model || p.model || '').trim()
		if (!model) throw new Error('Falta el modelo')
		const effort = String(body.effort || p.effort || 'high').trim()
		const apiKey = p.apiKey
		const baseUrl = p.baseUrl
		const started = Date.now()

		const chatPayload = {
			model,
			messages: [{ role: 'user', content: '1' }],
			max_tokens: 1,
			stream: false,
		}
		if (effort) chatPayload.reasoning_effort = effort

		const chatRes = await probeSmart(endpoint(baseUrl, '/chat/completions'), {
			apiKey,
			method: 'POST',
			json: chatPayload,
			timeoutMs: 12000,
		})

		if (chatRes.ok) {
			return { ok: true, ms: Date.now() - started, effort: effort || 'default', httpStatus: 200 }
		}

		const respPayload = {
			model,
			input: [{ role: 'user', content: '1' }],
			max_output_tokens: 1,
			stream: false,
		}
		if (effort) respPayload.reasoning_effort = effort

		const respRes = await probeSmart(endpoint(baseUrl, '/responses'), {
			apiKey,
			method: 'POST',
			json: respPayload,
			timeoutMs: 12000,
		})

		if (respRes.ok) {
			return { ok: true, ms: Date.now() - started, effort: effort || 'default', httpStatus: 200 }
		}

		const errMsg =
			(chatRes.json && chatRes.json.error && chatRes.json.error.message) ||
			(respRes.json && respRes.json.error && respRes.json.error.message) ||
			chatRes.text ||
			respRes.text ||
			`Error ${chatRes.httpStatus || respRes.httpStatus || 400}`

		return {
			ok: false,
			ms: Date.now() - started,
			effort: effort || 'default',
			error: errMsg,
			httpStatus: chatRes.httpStatus || respRes.httpStatus || 400,
		}
	},

	/** Catalogo completo, para el explorador de modelos. */
	'POST /api/catalog': async (body) => {
		const providers = readStore()
		const stored = providers.find((p) => p.id === body.id)
		const apiKey = body.apiKey || stored?.apiKey
		const baseUrl = body.baseUrl || stored?.baseUrl
		if (!baseUrl || !apiKey) throw new Error('Faltan baseUrl o apiKey')

		const [{ result, models }, discovery] = await Promise.all([
			listModels(baseUrl, apiKey),
			discoverModelSupport(baseUrl, apiKey),
		])
		// Si /models esta bloqueado, al menos lo que digan los metadatos.
		const fromMeta = [...new Set([...discovery.responses, ...discovery.channelBacked])]
		const all = models.length ? models : fromMeta
		return {
			models: all,
			declaresResponses: discovery.responses,
			channelBacked: discovery.channelBacked,
			group: discovery.group,
			sources: discovery.sources,
			httpStatus: result.httpStatus,
			blocked: Boolean(result.clientBlocked),
			error: result.ok ? null : apiError(result),
		}
	},

	/**
	 * Los comandos ya rellenos con la key de verdad, para copiar y pegar.
	 * El panel solo escucha en 127.0.0.1, asi que la key no sale de la maquina.
	 */
	'POST /api/usage': async (body) => {
		const providers = readStore()
		const provider = providers.find((p) => p.id === body.id)
		if (!provider) throw new Error('Provider desconocido')
		const target = ['codex', 'claude', 'curl'].includes(body.target) ? body.target : 'codex'
		const effProvider = {
			...provider,
			...(body.model ? { model: body.model } : {}),
			...(body.effort !== undefined ? { effort: body.effort } : {}),
		}
		return usageGuide(effProvider, target)
	},

	/** Escribe el bloque env en el settings.json de Claude Code, con respaldo. */
	'POST /api/apply-claude': async (body) => {
		const providers = readStore()
		const provider = providers.find((p) => p.id === body.id)
		if (!provider) throw new Error('Provider desconocido')
		if (!provider.model) throw new Error('Elige un modelo primero')
		if (!provider.apiKey) throw new Error('Falta la API key')

		const dir = path.join(os.homedir(), '.claude')
		const file = path.join(dir, 'settings.json')
		fs.mkdirSync(dir, { recursive: true })

		let current = {}
		const hadFile = fs.existsSync(file)
		if (hadFile) {
			try {
				current = JSON.parse(fs.readFileSync(file, 'utf8'))
			} catch {
				throw new Error('Tu settings.json de Claude Code no es JSON valido. Arreglalo o borralo antes.')
			}
			if (!current || typeof current !== 'object' || Array.isArray(current)) {
				throw new Error('Tu settings.json de Claude Code debe contener un objeto JSON')
			}
			backupFile(file)
		}

		const previousEnv = current.env && typeof current.env === 'object' && !Array.isArray(current.env) ? current.env : {}
		current.env = {
			...previousEnv,
			ANTHROPIC_BASE_URL: String(provider.baseUrl).replace(/\/v1\/?$/i, ''),
			ANTHROPIC_AUTH_TOKEN: provider.apiKey,
			ANTHROPIC_MODEL: provider.model,
		}
		if (!current.permissions) {
			current.permissions = { defaultMode: 'bypassPermissions', allow: ['Bash'] }
		}
		if (current.skipDangerousModePermissionPrompt === undefined) {
			current.skipDangerousModePermissionPrompt = true
		}
		atomicWrite(file, JSON.stringify(current, null, 2) + '\n')
		return { file, backedUp: hadFile, env: Object.keys(current.env) }
	},

	/** Prepara settings.json de Claude Code para modo multiterminal (limpia env de proveedores y fija modo YOLO). */
	'POST /api/prepare-claude-multiterminal': async () => {
		const dir = path.join(os.homedir(), '.claude')
		const file = path.join(dir, 'settings.json')
		fs.mkdirSync(dir, { recursive: true })

		let current = {}
		const hadFile = fs.existsSync(file)
		if (hadFile) {
			try {
				current = JSON.parse(fs.readFileSync(file, 'utf8'))
			} catch {
				throw new Error('Tu settings.json de Claude Code no es JSON valido. Arreglalo o borralo antes.')
			}
			if (!current || typeof current !== 'object' || Array.isArray(current)) {
				throw new Error('Tu settings.json de Claude Code debe contener un objeto JSON')
			}
			backupFile(file)
		}

		const env = current.env && typeof current.env === 'object' && !Array.isArray(current.env) ? { ...current.env } : {}
		delete env.ANTHROPIC_BASE_URL
		delete env.ANTHROPIC_AUTH_TOKEN
		delete env.ANTHROPIC_API_KEY
		delete env.ANTHROPIC_MODEL
		delete env.ANTHROPIC_DEFAULT_OPUS_MODEL
		delete env.ANTHROPIC_DEFAULT_SONNET_MODEL
		delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL

		if (env.DISABLE_TELEMETRY === undefined) env.DISABLE_TELEMETRY = '1'
		if (env.DISABLE_AUTOUPDATER === undefined) env.DISABLE_AUTOUPDATER = '1'

		current.env = env
		current.permissions = {
			defaultMode: 'bypassPermissions',
			allow: ['Bash'],
		}
		current.skipDangerousModePermissionPrompt = true

		atomicWrite(file, JSON.stringify(current, null, 2) + '\n')
		return { ok: true, file, backedUp: hadFile }
	},

	/**
	 * Leer un archivo de configuracion para editarlo en el panel, sin abrir el
	 * explorador. Lista blanca: solo estos dos, y nunca rutas arbitrarias.
	 */
	'POST /api/file-read': async (body) => {
		const target = FILES[body.which]
		if (!target) throw new Error('Archivo no permitido')
		let content = ''
		let exists = true
		try {
			content = fs.readFileSync(target.path, 'utf8')
		} catch {
			exists = false
			content = target.template || ''
		}
		return {
			which: body.which,
			path: target.path,
			label: target.label,
			kind: target.kind,
			exists,
			content,
			problems: checkFile(target.kind, content),
		}
	},

	/** Validar sin guardar, para poder avisar mientras se escribe. */
	'POST /api/file-check': async (body) => {
		const target = FILES[body.which]
		if (!target) throw new Error('Archivo no permitido')
		return { problems: checkFile(target.kind, String(body.content ?? '')) }
	},

	/** Guardar lo editado. No se escribe nada si el contenido es invalido. */
	'POST /api/file-write': async (body) => {
		const target = FILES[body.which]
		if (!target) throw new Error('Archivo no permitido')
		const content = String(body.content ?? '')
		const problems = checkFile(target.kind, content)
		if (problems.length) throw new Error('No se guardo: ' + problems.join('; '))

		fs.mkdirSync(path.dirname(target.path), { recursive: true })
		const backedUp = backupFile(target.path)
		atomicWrite(target.path, content.endsWith('\n') ? content : content + '\n')
		return { path: target.path, backedUp, bytes: Buffer.byteLength(content) }
	},

	/** Que hay AHORA en el config.toml, leido de verdad. */
	'GET /api/config': async () => inspectConfig(),

	/** Deja el config.toml valido (funde duplicados) sin cambiar nada mas. */
	'POST /api/repair-config': async () => {
		const r = repairConfig()
		return { ...r, after: inspectConfig() }
	},

	/**
	 * Limpieza de higiene, siempre con lo que el usuario elija. No se borra nada
	 * por iniciativa propia: se le dice que hay y el decide.
	 */
	'POST /api/clean-config': async (body) => {
		const text = readConfig()
		if (!text) throw new Error('No hay config.toml')
		const doc = new TomlDoc(text)
		const removedTables = []
		const removedKeys = []

		const active = stripQuotes(doc.get(null, 'model_provider'))
		for (const id of body.removeTables || []) {
			if (id === active) throw new Error(`"${id}" es el proveedor activo: no se borra`)
			if (!doc.tables().includes(`model_providers.${id}`)) continue
			doc.removeTable(`model_providers.${id}`)
			removedTables.push(id)
		}

		if (body.removeTuning) {
			for (const t of [...new Set(doc.tables())]) {
				if (!t.startsWith('model_providers.')) continue
				for (const k of RETRY_KEYS) {
					if (doc.get(t, k) !== null) {
						doc.remove(t, k)
						removedKeys.push({ table: t, key: k })
					}
				}
			}
		}

		const next = doc.toString()
		const errors = validate(next)
		if (errors.length) throw new Error('Quedaria invalido: ' + errors.join('; '))
		if (next !== text) {
			backupConfig()
			atomicWrite(CONFIG_PATH(), next)
		}
		return { removedTables, removedKeys, changed: next !== text, after: inspectConfig() }
	},

	/** Simulacion: que cambiaria al instalar, sin escribir nada. */
	'POST /api/plan-install': async (body) => {
		const providers = readStore()
		const provider = providers.find((p) => p.id === body.id)
		if (!provider) throw new Error('Provider desconocido')
		if (!provider.model) throw new Error('Elige un modelo antes')
		const { text, report } = applyToConfig(readConfig(), provider)
		return { report, preview: text, path: CONFIG_PATH() }
	},

	'POST /api/install': async (body) => {
		const providers = readStore()
		const index = providers.findIndex((p) => p.id === body.id)
		if (index < 0) throw new Error('Provider desconocido')
		const provider = providers[index]
		if (!provider.model) throw new Error('Elige un modelo antes de instalar')
		if (!provider.apiKey) throw new Error('Falta la API key')

		const needsBridge = provider.useBridge || provider.lastTest?.verdict === 'chat_only' || provider.lastTest?.verdict === 'no_responses' || (provider.model && provider.modelResults?.[provider.model] && provider.modelResults[provider.model].target !== 'responses')
		if (needsBridge) provider.useBridge = true

		// Si va por traductor, hay que levantarlo antes de escribir la config:
		// el puerto real es el que acaba en base_url.
		let bridge = null
		if (provider.useBridge) {
			bridge = await startBridge(provider)
			provider.bridgePort = bridge.port
		}

		let result
		try {
			result = install(provider, providers)
		} catch (error) {
			if (bridge && !bridge.reused) stopBridge(provider.id)
			throw error
		}
		for (let i = 0; i < providers.length; i++) {
			providers[i] = { ...providers[i], installed: i === index }
		}
		providers[index] = { ...provider, installed: true }
		writeStore(providers)
		return {
			...result,
			bridge,
			config: inspectConfig(),
			usage: usageGuide(provider),
			command: launchCommand(provider),
		}
	},

	/** Registra la tabla del proveedor en config.toml para multiterminal SIN tocar la raíz. */
	'POST /api/register-table': async (body) => {
		const providers = readStore()
		const index = providers.findIndex((p) => p.id === body.id)
		if (index < 0) throw new Error('Provider desconocido')

		const provider = { ...providers[index] }
		const configPath = CONFIG_PATH()
		const current = readConfig()

		if (provider.useBridge) {
			const bridge = await startBridge(provider)
			provider.bridgePort = bridge.port
		}

		const { text, report } = registerInConfig(current, provider)
		if (report.errors.length) {
			throw new Error('El config.toml resultante seria invalido: ' + report.errors.join('; '))
		}

		if (text !== current) {
			if (current) backupConfig()
			atomicWrite(configPath, text)
		}

		provider.inConfig = true
		providers[index] = provider
		writeStore(providers)
		return {
			configPath,
			report,
			config: inspectConfig(),
			provider: publicView(provider),
			unchanged: text === current,
		}
	},

	/** Desvincula el proveedor activo de la raíz para volver al ChatGPT oficial por defecto. */
	'POST /api/unset-active': async () => {
		const configPath = CONFIG_PATH()
		const current = readConfig()
		if (!current) return { unchanged: true }

		const { text, errors } = unsetActiveFromConfig(current)
		if (errors.length) throw new Error('El config.toml resultante seria invalido: ' + errors.join('; '))

		if (text !== current) {
			backupConfig()
			atomicWrite(configPath, text)
		}

		const providers = readStore()
		for (const p of providers) p.installed = false
		writeStore(providers)

		return { configPath, config: inspectConfig(), unchanged: text === current }
	},

	/** Levanta el traductor Chat->Responses para un provider solo-chat. */
	'POST /api/bridge': async (body) => {
		const providers = readStore()
		const index = providers.findIndex((p) => p.id === body.id)
		if (index < 0) throw new Error('Provider desconocido')

		if (body.stop === true) {
			const stopped = stopBridge(body.id)
			providers[index] = { ...providers[index], useBridge: false }
			const active = stripQuotes(new TomlDoc(readConfig()).get(null, 'model_provider')) === body.id
			if (active && providers[index].model) install(providers[index], providers)
			writeStore(providers)
			return { running: false, stopped }
		}

		const provider = { ...providers[index], useBridge: true }
		const bridge = await startBridge(provider)
		providers[index] = { ...provider, bridgePort: bridge.port }
		writeStore(providers)

		// Comprobacion real: pedirle al puente una respuesta como haria Codex.
		const check = await probeResponses(bridge.url, provider.apiKey, provider.model)
		return {
			running: true,
			...bridge,
			works: check.best.ok,
			streams: Boolean(check.streamed?.ok),
			detail: check.best.ok
				? `El traductor responde en formato Responses con "${provider.model}".`
				: `El traductor no pudo traducir: HTTP ${check.best.httpStatus} ${apiError(check.best)}`,
		}
	},

	'POST /api/uninstall': async (body) => {
		const providers = readStore()
		const index = providers.findIndex((p) => p.id === body.id)
		if (index < 0) throw new Error('Provider desconocido')
		uninstall(providers[index])
		stopBridge(body.id)
		providers[index] = { ...providers[index], installed: false }
		writeStore(providers)
		writeEnvFile(providers)
		return { ok: true }
	},

	'POST /api/delete': async (body) => {
		const providers = readStore()
		const provider = providers.find((p) => p.id === body.id)
		if (provider) {
			stopBridge(body.id)
			uninstall(provider)
			cleanClaudeConfig(provider)
			const left = providers.filter((p) => p.id !== body.id)
			writeStore(left)
			writeEnvFile(left)
		}
		return { ok: true }
	},

	'POST /api/preview': async (body) => {
		const providers = readStore()
		const provider = providers.find((p) => p.id === body.id)
		if (!provider) throw new Error('Provider desconocido')
		const { text, report } = applyToConfig(readConfig(), provider)
		return {
			preview: text,
			report,
			command: launchCommand(provider),
			usage: usageGuide(provider),
			path: CONFIG_PATH(),
		}
	},
}

/**
 * Escaneo con progreso en vivo por SSE. El navegador ve cada modelo en cuanto
 * termina, en vez de esperar a que acaben los 27.
 *
 *   GET /api/scan?id=<provider>&models=a,b,c
 *
 * Sin `models` se barre el catalogo entero.
 */
async function handleScanStream(req, res, query) {
	const providers = readStore()
	const stored = providers.find((p) => p.id === query.get('id'))
	const apiKey = stored?.apiKey
	const baseUrl = stored?.baseUrl

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	})
	const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)

	if (!baseUrl || !apiKey) {
		send('error', { message: 'Provider sin baseUrl o sin key' })
		return res.end()
	}

	let aborted = false
	req.on('close', () => {
		aborted = true
	})

	try {
		newSession()
		const picked = (query.get('models') || '')
			.split(',')
			.map((m) => m.trim())
			.filter(Boolean)

		let pool = picked
		let discovery = null
		if (!pool.length) {
			discovery = await discoverModelSupport(baseUrl, apiKey)
			const { models } = await listModels(baseUrl, apiKey)
			pool = orderCandidates(
				models.length ? models : [...new Set([...discovery.responses, ...discovery.channelBacked])],
				discovery,
			)
		}

		if (!pool.length) {
			send('error', { message: 'El relay no expone catalogo ni metadatos de modelos' })
			return res.end()
		}

		const max = Math.min(Number(query.get('max')) || Math.max(pool.length, SCAN_MAX), 200)
		send('start', { total: Math.min(pool.length, max), sources: discovery?.sources || [] })

		let done = 0
		const { results } = await sweepModels(baseUrl, apiKey, pool, {
			max,
			concurrency: Math.min(Math.max(Number(query.get('concurrency')) || 3, 1), 10),
			shouldStop: () => aborted,
			checkAllProtocols: true,
			onEach: (entry) => {
				if (aborted) return
				const { round, ...rest } = entry
				send('result', { ...rest, done: ++done })
			},
		})

		if (!aborted) {
			const currentProviders = readStore()
			const pIdx = currentProviders.findIndex((p) => p.id === query.get('id'))
			if (pIdx >= 0) {
				const existing = query.has('models') ? { ...(currentProviders[pIdx].modelResults || {}) } : {}
				for (const r of results) {
					existing[r.model] = {
						model: r.model,
						ok: r.ok,
						httpStatus: r.httpStatus,
						ms: r.ms,
						target: r.target,
						reason: r.reason,
						detail: r.detail,
					}
				}
				currentProviders[pIdx] = {
					...currentProviders[pIdx],
					modelResults: existing,
				}
				writeStore(currentProviders)
			}

			send('done', {
				scanned: results.length,
				working: results.filter((r) => r.ok).map((r) => r.model),
			})
		}
	} catch (error) {
		if (!aborted) send('error', { message: String(error.message || error) })
	}
	res.end()
}

const server = http.createServer(async (req, res) => {
	// Defensa anti-DNS-rebinding y contra peticiones iniciadas por otra web.
	const hostHeader = String(req.headers.host || '')
	const host = hostHeader.startsWith('[')
		? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
		: hostHeader.split(':')[0]
	if (host && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
		return sendJson(res, 403, { error: 'Solo se permite acceso local' })
	}
	const origin = String(req.headers.origin || '')
	if (origin) {
		let originHost = ''
		try {
			originHost = new URL(origin).hostname
		} catch {}
		if (!['127.0.0.1', 'localhost', '::1'].includes(originHost)) {
			return sendJson(res, 403, { error: 'Origen no permitido' })
		}
	}

	const [pathname, search] = req.url.split('?')

	// El escaneo es un stream, no cabe en el router de JSON.
	if (req.method === 'GET' && pathname === '/api/scan') {
		return handleScanStream(req, res, new URLSearchParams(search || ''))
	}

	const handler = routes[`${req.method} ${pathname}`]
	if (!handler) return serveStatic(req, res)

	try {
		const body = req.method === 'POST' ? await readBody(req) : {}
		sendJson(res, 200, await handler(body))
	} catch (error) {
		sendJson(res, 400, { error: error.message || String(error) })
	}
})

function openBrowser(url) {
	if (process.env.RELAYDECK_NO_OPEN || process.env.CODEX_PANEL_NO_OPEN || process.env.CI || process.env.NODE_ENV === 'test') return
	try {
		const plat = os.platform()
		if (plat === 'win32') {
			spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
		} else if (plat === 'darwin') {
			spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
		} else {
			spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
		}
	} catch {}
}

ensureHome()
server.listen(PORT, HOST, () => {
	console.log(`
  RelayDeck     http://${HOST}:${PORT}`)
	console.log(`  Almacen       ${PANEL_HOME}`)
	console.log(`  Codex home    ${CODEX_HOME}\n`)
	openBrowser(`http://${HOST}:${PORT}`)
})
