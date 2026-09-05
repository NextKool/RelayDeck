#!/usr/bin/env node
'use strict'

/**
 * Suite completa de pruebas automatizadas para Codex Panel.
 * Sin dependencias externas — solo módulos estándar de Node.js.
 */

const assert = require('assert')
const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { fork, spawn } = require('child_process')
const { createBridge, toChatRequest, buildResponse, collectChatResult } = require('../bridge')
const { TomlDoc, validate, scanLines } = require('../toml-edit')
const { createFakeProvider } = require('./fake-provider')

const ROOT_DIR = path.resolve(__dirname, '..')
let passed = 0
let failed = 0

function logPass(name) {
	passed++
	console.log(`  ✓ ${name}`)
}

function logFail(name, err) {
	failed++
	console.error(`  ✗ ${name}`)
	console.error(`    ${err.stack || err.message || err}`)
}

async function test(name, fn) {
	try {
		await fn()
		logPass(name)
	} catch (err) {
		logFail(name, err)
	}
}

// ----------------------------------------------------------- Helpers de red y procesos

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = http.createServer()
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port
			server.close(() => resolve(port))
		})
		server.on('error', reject)
	})
}

async function request(url, { method = 'GET', json, headers = {} } = {}) {
	const body = json !== undefined ? JSON.stringify(json) : undefined
	const res = await fetch(url, {
		method,
		headers: {
			...(body ? { 'Content-Type': 'application/json' } : {}),
			...headers,
		},
		body,
	})
	const text = await res.text()
	let data = null
	try {
		data = JSON.parse(text)
	} catch {}
	return { status: res.status, ok: res.ok, headers: res.headers, text, data }
}

function createTempDirs() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'))
	const panelHome = path.join(base, 'panel')
	const codexHome = path.join(base, 'codex')
	fs.mkdirSync(panelHome, { recursive: true })
	fs.mkdirSync(codexHome, { recursive: true })
	return {
		base,
		panelHome,
		codexHome,
		cleanup: () => {
			try {
				fs.rmSync(base, { recursive: true, force: true })
			} catch {}
		},
	}
}

function startPanelProcess({ panelPort, panelHome, codexHome }) {
	return new Promise((resolve, reject) => {
		const proc = fork(path.join(ROOT_DIR, 'server.js'), [], {
			env: {
				...process.env,
				CODEX_PANEL_PORT: String(panelPort),
				CODEX_PANEL_HOME: panelHome,
				CODEX_HOME: codexHome,
				CODEX_PANEL_TIMEOUT_MS: '5000',
				CODEX_PANEL_SLOW_MS: '1000',
			},
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		})

		let started = false
		const checkUrl = `http://127.0.0.1:${panelPort}/api/state`

		const interval = setInterval(async () => {
			try {
				const res = await fetch(checkUrl)
				if (res.ok) {
					clearInterval(interval)
					started = true
					resolve(proc)
				}
			} catch {}
		}, 100)

		const timeout = setTimeout(() => {
			clearInterval(interval)
			if (!started) {
				proc.kill()
				reject(new Error('Timeout al esperar arranque de Codex Panel'))
			}
		}, 6000)

		proc.on('error', (err) => {
			clearInterval(interval)
			clearTimeout(timeout)
			reject(err)
		})
	})
}

// ----------------------------------------------------------- 1. TOML Tests

async function runTomlTests() {
	console.log('\n--- 1. Pruebas de toml-edit.js ---')

	await test('Detecta cadenas normales sin cerrar', () => {
		const errs = validate('model = "gpt-5\nwire_api = "responses"')
		assert(errs.some((e) => /cadena sin cerrar/i.test(e)), 'Debe detectar cadena simple sin cerrar')
	})

	await test('Detecta cadenas multilinea sin cerrar', () => {
		const errs = validate('prompt = """esta cadena no termina\nmas texto\notro = 123')
		assert(errs.some((e) => /multilinea sin cerrar/i.test(e)), 'Debe detectar cadena multilinea sin cerrar')
	})

	await test('Detecta arrays y tablas inline sin cerrar', () => {
		const errsArr = validate('models = ["gpt-5", "claude"')
		assert(errsArr.some((e) => /array sin cerrar/i.test(e)), 'Debe detectar array sin cerrar')

		const errsTbl = validate('tbl = { key = "val"')
		assert(errsTbl.some((e) => /tabla inline sin cerrar/i.test(e)), 'Debe detectar tabla inline sin cerrar')
	})

	await test('Rechaza valores bare invalidos', () => {
		const errs = validate('foo = bar_baz\nnum = 12.34.56')
		assert(errs.length >= 1, 'Debe rechazar valores bare invalidos')
	})

	await test('Acepta [[array.of.tables]] validos sin marcarlos como error ni duplicados', () => {
		const toml = `
[[servers]]
name = "alpha"
port = 8080

[[servers]]
name = "beta"
port = 8081
`
		const errs = validate(toml)
		assert.strictEqual(errs.length, 0, 'No debe dar errores de sintaxis en array de tablas')
		const doc = new TomlDoc(toml)
		const probs = doc.problems()
		assert.strictEqual(probs.duplicateTables.length, 0, 'No debe marcar duplicadas las tablas de array')
	})

	await test('repair() no une ni destruye arrays de tablas [[...]]', () => {
		const toml = `
[[plugins]]
id = "p1"
enabled = true

[[plugins]]
id = "p2"
enabled = false
`
		const doc = new TomlDoc(toml)
		const rep = doc.repair()
		assert.strictEqual(rep.tables.length, 0, 'No debe intentar fundir tablas de array')
		const out = doc.toString()
		assert(out.includes('[[plugins]]'), 'Debe conservar [[plugins]]')
		assert(out.includes('id = "p1"'), 'Debe conservar primer elemento')
		assert(out.includes('id = "p2"'), 'Debe conservar segundo elemento')
	})

	await test('repair() no reduce saltos de linea dentro de cadenas multilinea', () => {
		const toml = `
prompt = """
linea 1

linea 2
"""
`
		const doc = new TomlDoc(toml)
		doc.repair()
		const out = doc.toString()
		assert(out.includes('linea 1\n\nlinea 2') || out.includes('linea 1\r\n\r\nlinea 2'), 'Debe conservar saltos de linea en multilinea')
	})

	await test('Detecta tablas normales y claves duplicadas', () => {
		const toml = `
model = "gpt-4"
model = "gpt-5"

[provider]
name = "a"

[provider]
name = "b"
`
		const doc = new TomlDoc(toml)
		const p = doc.problems()
		assert(p.duplicateKeys.some((k) => k.key === 'model'), 'Debe detectar clave model duplicada')
		assert(p.duplicateTables.some((t) => t.table === 'provider'), 'Debe detectar tabla provider duplicada')
	})

	await test('Preserva comentarios y secciones ajenas', () => {
		const toml = `
# Comentario importante inicial
model = "gpt-5"

[mcp_servers.my_mcp]
command = "npx"
args = ["-y", "test-mcp"]
`
		const doc = new TomlDoc(toml)
		doc.set('model_providers.custom', 'name', '"custom-provider"')
		const out = doc.toString()
		assert(out.includes('# Comentario importante inicial'), 'Debe preservar comentarios')
		assert(out.includes('[mcp_servers.my_mcp]'), 'Debe preservar secciones ajenas')
	})
}

// ----------------------------------------------------------- 2. Bridge Tests

async function runBridgeTests() {
	console.log('\n--- 2. Pruebas de bridge.js ---')

	const mockPort = await getFreePort()
	let mockHandler = (req, res) => res.end('ok')

	const mockUpstream = http.createServer((req, res) => mockHandler(req, res))
	await new Promise((resolve) => mockUpstream.listen(mockPort, '127.0.0.1', resolve))

	const bridgePort = await getFreePort()
	const bridge = createBridge({
		upstream: `http://127.0.0.1:${mockPort}/v1`,
		apiKey: 'sk-test-bridge',
		model: 'test-model',
	})
	await new Promise((resolve) => bridge.listen(bridgePort, '127.0.0.1', resolve))

	try {
		await test('SSE con \\n\\n y \\r\\n\\r\\n', async () => {
			mockHandler = (req, res) => {
				res.writeHead(200, { 'Content-Type': 'text/event-stream' })
				res.write('data: {"choices":[{"delta":{"content":"Hola"}}]}\r\n\r\n')
				res.write('data: {"choices":[{"delta":{"content":" mundo"}}]}\n\n')
				res.write('data: [DONE]\n\n')
				res.end()
			}

			const res = await request(`http://127.0.0.1:${bridgePort}/v1/responses`, {
				method: 'POST',
				headers: { Accept: 'text/event-stream' },
				json: { model: 'test-model', input: 'ping', stream: true },
			})
			assert(res.ok, 'Bridge debe responder 200 en SSE')
			assert(res.text.includes('Hola') && res.text.includes('mundo'), 'Debe procesar SSE con \\n y \\r\\n')
			assert(res.text.includes('response.completed'), 'Debe emitir response.completed')
		})

		await test('Procesamiento de ultimo evento sin linea en blanco final', async () => {
			mockHandler = (req, res) => {
				res.writeHead(200, { 'Content-Type': 'text/event-stream' })
				res.write('data: {"choices":[{"delta":{"content":"final-chunk"}}]}')
				res.end()
			}

			const res = await request(`http://127.0.0.1:${bridgePort}/v1/responses`, {
				method: 'POST',
				headers: { Accept: 'text/event-stream' },
				json: { model: 'test-model', input: 'ping', stream: true },
			})
			assert(res.text.includes('final-chunk'), 'Debe procesar el ultimo bloque sin doble salto final')
		})

		await test('Eventos data: multilinea', async () => {
			mockHandler = (req, res) => {
				res.writeHead(200, { 'Content-Type': 'text/event-stream' })
				res.write('data: {\n')
				res.write('data: "choices": [{"delta": {"content": "multi"}}]\n')
				res.write('data: }\n\n')
				res.write('data: [DONE]\n\n')
				res.end()
			}

			const res = await request(`http://127.0.0.1:${bridgePort}/v1/responses`, {
				method: 'POST',
				headers: { Accept: 'text/event-stream' },
				json: { model: 'test-model', input: 'ping', stream: true },
			})
			assert(res.text.includes('multi'), 'Debe procesar data multilinea en SSE')
		})

		await test('Tool calls emiten eventos de anadido, argumentos y finalizacion', async () => {
			mockHandler = (req, res) => {
				res.writeHead(200, { 'Content-Type': 'text/event-stream' })
				res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"calc","arguments":""}}]}}]}\n\n')
				res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}}]}\n\n')
				res.write('data: [DONE]\n\n')
				res.end()
			}

			const res = await request(`http://127.0.0.1:${bridgePort}/v1/responses`, {
				method: 'POST',
				headers: { Accept: 'text/event-stream' },
				json: { model: 'test-model', input: 'ping', stream: true },
			})
			assert(res.text.includes('response.output_item.added'), 'Debe emitir output_item.added')
			assert(res.text.includes('response.function_call_arguments.delta'), 'Debe emitir function_call_arguments.delta')
			assert(res.text.includes('response.function_call_arguments.done'), 'Debe emitir function_call_arguments.done')
			assert(res.text.includes('response.output_item.done'), 'Debe emitir output_item.done')
			assert(res.text.includes('response.completed'), 'Debe emitir response.completed')
		})

		await test('Superar limite de body devuelve 413', async () => {
			const huge = 'x'.repeat(21 * 1024 * 1024)
			const res = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ huge }),
			})
			assert.strictEqual(res.status, 413, 'Debe devolver HTTP 413 ante payload enorme')
		})

		await test('Stream invalido tras HTTP 200 termina con response.failed', async () => {
			mockHandler = (req, res) => {
				res.writeHead(200, { 'Content-Type': 'text/event-stream' })
				res.write('data: { esto no es json valido\n\n')
				res.end()
			}

			const res = await request(`http://127.0.0.1:${bridgePort}/v1/responses`, {
				method: 'POST',
				headers: { Accept: 'text/event-stream' },
				json: { model: 'test-model', input: 'ping', stream: true },
			})
			assert(res.text.includes('response.failed'), 'Debe emitir response.failed si el stream es invalido')
		})
	} finally {
		await new Promise((r) => bridge.close(r))
		await new Promise((r) => mockUpstream.close(r))
	}
}

// ----------------------------------------------------------- 3. Fake Providers Verdicts Suite

async function runFakeProviderVerdictsSuite() {
	console.log('\n--- 3. Pruebas de Veredictos con Fake Providers ---')

	const envDirs = createTempDirs()
	const panelPort = await getFreePort()
	let panelProc = null

	try {
		panelProc = await startPanelProcess({
			panelPort,
			panelHome: envDirs.panelHome,
			codexHome: envDirs.codexHome,
		})

		const modes = [
			{ mode: 'full', expected: 'codex_ready' },
			{ mode: 'chatonly', expected: 'chat_only' },
			{ mode: 'chatstream', expected: 'chat_only' },
			{ mode: 'nores', expected: 'no_responses' },
			{ mode: 'unauth', expected: 'invalid_key' },
			{ mode: 'hardblock', expected: 'client_blocked' },
			{ mode: 'strictcodex', expected: 'codex_ready' },
			{ mode: 'nostream', expected: 'codex_ready', check: (r) => r.checks.streaming?.status === 'warn' },
			{ mode: 'nochannel', expected: 'codex_ready' },
			{ mode: 'allblocked', expected: 'no_channel' },
			{ mode: 'metadata', expected: 'codex_ready' },
			{ mode: 'slow', expected: 'codex_ready', check: (r) => r.slow === true || r.checks.latency?.status === 'warn' },
			{ mode: 'eol', expected: 'codex_ready', check: (r) => r.testedModel === 'gpt-5.5-codex' },
			{ mode: 'sentinel', expected: 'codex_ready', check: (r) => r.checks.billing?.unlimited === true },
			{ mode: 'hidden', expected: 'codex_ready', check: (r) => r.testedModel === 'gpt-5.6-sol' },
			{ mode: 'clientblock', expected: 'codex_ready', model: 'gpt-5.5' },
			{ mode: 'claudeonly', expected: 'claude_only' },
		]

		for (const item of modes) {
			await test(`Veredicto modo "${item.mode}" -> "${item.expected}"`, async () => {
				const fakePort = await getFreePort()
				const fakeServer = createFakeProvider(item.mode)
				await new Promise((resolve) => fakeServer.listen(fakePort, '127.0.0.1', resolve))

				try {
					const res = await request(`http://127.0.0.1:${panelPort}/api/test`, {
						method: 'POST',
						json: {
							baseUrl: `http://127.0.0.1:${fakePort}/v1`,
							apiKey: 'sk-test-valid-key',
							model: item.model || undefined,
						},
					})
					assert(res.ok, `Llamada /api/test debe ser 200, recibio ${res.status}: ${res.text}`)
					assert.strictEqual(res.data.verdict, item.expected, `Veredicto esperado ${item.expected}, obtuvo ${res.data.verdict}`)
					if (item.check) {
						assert(item.check(res.data), `Comprobacion adicional fallo para ${item.mode}: ${JSON.stringify(res.data)}`)
					}
				} finally {
					await new Promise((r) => fakeServer.close(r))
				}
			})
		}
	} finally {
		if (panelProc) panelProc.kill()
		envDirs.cleanup()
	}
}

// ----------------------------------------------------------- 4. Active Provider, Sync & Security Suite

async function runSyncAndActiveProviderSuite() {
	console.log('\n--- 4. Pruebas de Sincronización, Seguridad y API Key Visible ---')

	const envDirs = createTempDirs()
	const panelPort = await getFreePort()
	let panelProc = null

	try {
		panelProc = await startPanelProcess({
			panelPort,
			panelHome: envDirs.panelHome,
			codexHome: envDirs.codexHome,
		})

		const fakePort = await getFreePort()
		const fakeServer = createFakeProvider('full')
		await new Promise((resolve) => fakeServer.listen(fakePort, '127.0.0.1', resolve))

		try {
			await test('Registrar proveedores y verificar API Key visible en /api/state', async () => {
				const resA = await request(`http://127.0.0.1:${panelPort}/api/provider`, {
					method: 'POST',
					json: { label: 'Provider A', baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: 'sk-key-AAA-12345' },
				})
				assert(resA.ok, 'Debe crear provider A')

				const resB = await request(`http://127.0.0.1:${panelPort}/api/provider`, {
					method: 'POST',
					json: { label: 'Provider B', baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: 'sk-key-BBB-67890', force: true },
				})
				assert(resB.ok, 'Debe crear provider B')

				const state = await request(`http://127.0.0.1:${panelPort}/api/state`)
				assert(state.ok, 'Debe obtener estado')
				const pA = state.data.providers.find((p) => p.id === 'provider-a')
				const pB = state.data.providers.find((p) => p.id === 'provider-b')
				assert.strictEqual(pA.apiKey, 'sk-key-AAA-12345', 'API key de A debe ser visible y completa')
				assert.strictEqual(pB.apiKey, 'sk-key-BBB-67890', 'API key de B debe ser visible y completa')
			})

			await test('Instalar A deja A como installed:true y B como installed:false', async () => {
				await request(`http://127.0.0.1:${panelPort}/api/set-model`, {
					method: 'POST',
					json: { id: 'provider-a', model: 'gpt-5.5' },
				})

				const instA = await request(`http://127.0.0.1:${panelPort}/api/install`, {
					method: 'POST',
					json: { id: 'provider-a' },
				})
				assert(instA.ok, 'Debe instalar A')

				const state = await request(`http://127.0.0.1:${panelPort}/api/state`)
				const pA = state.data.providers.find((p) => p.id === 'provider-a')
				const pB = state.data.providers.find((p) => p.id === 'provider-b')
				assert.strictEqual(pA.installed, true, 'A debe estar instalado')
				assert.strictEqual(pB.installed, false, 'B no debe estar instalado')

				// Verificar archivo env
				const envCmdPath = path.join(envDirs.panelHome, 'env.cmd')
				const envShPath = path.join(envDirs.panelHome, 'env.sh')
				const envContent = fs.existsSync(envCmdPath) ? fs.readFileSync(envCmdPath, 'utf8') : fs.readFileSync(envShPath, 'utf8')
				assert(envContent.includes('sk-key-AAA-12345'), 'El archivo env debe contener la key de A')
				assert(!envContent.includes('sk-key-BBB-67890'), 'El archivo env NO debe contener la key de B')
			})

			await test('Instalar B conmuta activo a B y no borra archivos *.config.toml ajenos', async () => {
				// Crear archivo ajeno
				const foreignFile = path.join(envDirs.codexHome, 'mi-propio.config.toml')
				fs.writeFileSync(foreignFile, '# Archivo de config propio ajeno\n[model_providers.alien]\n')

				await request(`http://127.0.0.1:${panelPort}/api/set-model`, {
					method: 'POST',
					json: { id: 'provider-b', model: 'gpt-5.5' },
				})

				const instB = await request(`http://127.0.0.1:${panelPort}/api/install`, {
					method: 'POST',
					json: { id: 'provider-b' },
				})
				assert(instB.ok, 'Debe instalar B')

				const state = await request(`http://127.0.0.1:${panelPort}/api/state`)
				const pA = state.data.providers.find((p) => p.id === 'provider-a')
				const pB = state.data.providers.find((p) => p.id === 'provider-b')
				assert.strictEqual(pA.installed, false, 'A ahora debe ser false')
				assert.strictEqual(pB.installed, true, 'B ahora debe ser true')

				// Verificar que archivo ajeno sigue existiendo
				assert(fs.existsSync(foreignFile), 'El archivo ajeno mi-propio.config.toml no debe ser borrado')

				// Verificar archivo env contiene solo B
				const envCmdPath = path.join(envDirs.panelHome, 'env.cmd')
				const envShPath = path.join(envDirs.panelHome, 'env.sh')
				const envContent = fs.existsSync(envCmdPath) ? fs.readFileSync(envCmdPath, 'utf8') : fs.readFileSync(envShPath, 'utf8')
				assert(envContent.includes('sk-key-BBB-67890'), 'El archivo env debe contener la key de B')
				assert(!envContent.includes('sk-key-AAA-12345'), 'El archivo env NO debe contener la key de A')
			})

			await test('Cambiar modelo de proveedor inactivo no lo activa; cambiar el activo actualiza config.toml', async () => {
				// Cambiar modelo de A (inactivo)
				await request(`http://127.0.0.1:${panelPort}/api/set-model`, {
					method: 'POST',
					json: { id: 'provider-a', model: 'modelo-inactivo' },
				})

				let state = await request(`http://127.0.0.1:${panelPort}/api/state`)
				let pA = state.data.providers.find((p) => p.id === 'provider-a')
				let pB = state.data.providers.find((p) => p.id === 'provider-b')
				assert.strictEqual(pA.installed, false, 'A debe seguir inactivo')
				assert.strictEqual(pB.installed, true, 'B debe seguir activo')

				// Cambiar modelo de B (activo)
				await request(`http://127.0.0.1:${panelPort}/api/set-model`, {
					method: 'POST',
					json: { id: 'provider-b', model: 'modelo-nuevo-b' },
				})

				const configContent = fs.readFileSync(path.join(envDirs.codexHome, 'config.toml'), 'utf8')
				assert(configContent.includes('model = "modelo-nuevo-b"'), 'config.toml debe actualizarse con el nuevo modelo de B')
				assert(configContent.includes('model_reasoning_effort = "high"'), 'config.toml debe tener reasoning effort en high')
			})

			await test('Editar URL o key invalida resultados anteriores; editar ajustes conserva modelResults', async () => {
				// Probar B para generar modelResults
				await request(`http://127.0.0.1:${panelPort}/api/test-model`, {
					method: 'POST',
					json: { id: 'provider-b', model: 'modelo-nuevo-b' },
				})

				let state = await request(`http://127.0.0.1:${panelPort}/api/state`)
				let pB = state.data.providers.find((p) => p.id === 'provider-b')
				assert(Object.keys(pB.modelResults || {}).length > 0, 'Debe tener modelResults')

				// Editar solo ajustes de B
				await request(`http://127.0.0.1:${panelPort}/api/provider`, {
					method: 'POST',
					json: { id: 'provider-b', label: 'Provider B Renamed', baseUrl: pB.baseUrl, effort: 'high' },
				})

				state = await request(`http://127.0.0.1:${panelPort}/api/state`)
				pB = state.data.providers.find((p) => p.id === 'provider-b')
				assert(Object.keys(pB.modelResults || {}).length > 0, 'Editar ajustes debe conservar modelResults')

				// Editar apiKey de B
				await request(`http://127.0.0.1:${panelPort}/api/provider`, {
					method: 'POST',
					json: { id: 'provider-b', label: pB.label, baseUrl: pB.baseUrl, apiKey: 'sk-new-key-12345' },
				})

				state = await request(`http://127.0.0.1:${panelPort}/api/state`)
				pB = state.data.providers.find((p) => p.id === 'provider-b')
				assert.strictEqual(Object.keys(pB.modelResults || {}).length, 0, 'Cambiar key debe invalidar modelResults anteriores')
			})
		} finally {
			await new Promise((r) => fakeServer.close(r))
		}
	} finally {
		if (panelProc) panelProc.kill()
		envDirs.cleanup()
	}
}

// ----------------------------------------------------------- 5. Bridge Lifecycle & Auto-activation

async function runBridgeLifecycleSuite() {
	console.log('\n--- 5. Pruebas de Ciclo de Vida del Puente y Reinicio ---')

	const envDirs = createTempDirs()
	const panelPort = await getFreePort()
	let panelProc = null

	try {
		panelProc = await startPanelProcess({
			panelPort,
			panelHome: envDirs.panelHome,
			codexHome: envDirs.codexHome,
		})

		const fakePort = await getFreePort()
		const fakeServer = createFakeProvider('chatonly')
		await new Promise((resolve) => fakeServer.listen(fakePort, '127.0.0.1', resolve))

		try {
			let savedBridgePort = null

			await test('Probar provider chatonly activa useBridge:true e instala con puerto de puente', async () => {
				const reg = await request(`http://127.0.0.1:${panelPort}/api/provider`, {
					method: 'POST',
					json: { label: 'Chat Relay', baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: 'sk-test-chat' },
				})
				assert(reg.ok, 'Debe registrar Chat Relay')

				const tst = await request(`http://127.0.0.1:${panelPort}/api/test`, {
					method: 'POST',
					json: { id: 'chat-relay' },
				})
				assert(tst.ok, 'Test debe completar')
				assert.strictEqual(tst.data.verdict, 'chat_only', 'Veredicto debe ser chat_only')

				let state = await request(`http://127.0.0.1:${panelPort}/api/state`)
				let p = state.data.providers.find((x) => x.id === 'chat-relay')
				assert.strictEqual(p.useBridge, true, 'Debe activar useBridge: true automáticamente')
				assert(p.model, 'Debe tener un modelo adoptado')

				// Instalar en Codex
				const inst = await request(`http://127.0.0.1:${panelPort}/api/install`, {
					method: 'POST',
					json: { id: 'chat-relay' },
				})
				assert(inst.ok, 'Debe instalar chat-relay')
				assert(inst.data.bridge?.port, 'Debe levantar puente con puerto')
				savedBridgePort = inst.data.bridge.port

				const config = fs.readFileSync(path.join(envDirs.codexHome, 'config.toml'), 'utf8')
				assert(config.includes(`http://127.0.0.1:${savedBridgePort}/v1`), 'config.toml debe apuntar al puerto del puente')
			})

			await test('Reinicio del panel recrea el puente para el proveedor activo y reutiliza puerto', async () => {
				// Matar proceso del panel y volverlo a arrancar con los mismos directorios
				panelProc.kill()
				await new Promise((r) => setTimeout(r, 500))

				panelProc = await startPanelProcess({
					panelPort,
					panelHome: envDirs.panelHome,
					codexHome: envDirs.codexHome,
				})

				// Llamar a /api/state para que levante el puente del proveedor activo
				const state = await request(`http://127.0.0.1:${panelPort}/api/state`)
				assert(state.ok, 'Debe consultar /api/state tras reinicio')
				const p = state.data.providers.find((x) => x.id === 'chat-relay')
				assert.strictEqual(p.installed, true, 'chat-relay debe seguir activo')
				assert.strictEqual(p.bridgePort, savedBridgePort, 'Debe reutilizar el puerto guardado')

				// Probar que el puente recreado responde
				const pingBridge = await request(`http://127.0.0.1:${savedBridgePort}/v1/models`, {
					headers: { Authorization: 'Bearer sk-test' },
				})
				assert(pingBridge.ok, 'El puente recreado debe responder en el puerto esperado')
			})

			await test('Desactivar o borrar puente actualiza config.toml y detiene servidor', async () => {
				const stopRes = await request(`http://127.0.0.1:${panelPort}/api/bridge`, {
					method: 'POST',
					json: { id: 'chat-relay', stop: true },
				})
				assert(stopRes.ok, 'Debe detener el puente')

				const config = fs.readFileSync(path.join(envDirs.codexHome, 'config.toml'), 'utf8')
				assert(!config.includes(`http://127.0.0.1:${savedBridgePort}/v1`), 'config.toml no debe apuntar a puerto muerto')
				assert(config.includes(`http://127.0.0.1:${fakePort}/v1`), 'config.toml debe apuntar a la base_url real')
			})
		} finally {
			await new Promise((r) => fakeServer.close(r))
		}
	} finally {
		if (panelProc) panelProc.kill()
		envDirs.cleanup()
	}
}

// ----------------------------------------------------------- 6. Chat API Suite

async function runChatApiSuite() {
	console.log('\n--- 6. Pruebas de /api/chat ---')

	const envDirs = createTempDirs()
	const panelPort = await getFreePort()
	let panelProc = null

	try {
		panelProc = await startPanelProcess({
			panelPort,
			panelHome: envDirs.panelHome,
			codexHome: envDirs.codexHome,
		})

		const fakePort = await getFreePort()
		const fakeServer = createFakeProvider('full')
		await new Promise((resolve) => fakeServer.listen(fakePort, '127.0.0.1', resolve))

		try {
			await request(`http://127.0.0.1:${panelPort}/api/provider`, {
				method: 'POST',
				json: { label: 'Chat Test Provider', baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: 'sk-test-chat-full', model: 'gpt-5.5' },
			})

			await test('/api/chat responde con texto extraído y conserva historial', async () => {
				const res = await request(`http://127.0.0.1:${panelPort}/api/chat`, {
					method: 'POST',
					json: {
						id: 'chat-test-provider',
						messages: [
							{ role: 'system', content: 'You are an assistant.' },
							{ role: 'user', content: 'Hola' },
						],
					},
				})
				assert(res.ok, `/api/chat debe responder 200: ${res.text}`)
				assert.strictEqual(res.data.reply, 'pong', 'Debe extraer texto "pong"')
				assert(res.data.protocol, 'Debe indicar protocolo utilizado')
			})
		} finally {
			await new Promise((r) => fakeServer.close(r))
		}
	} finally {
		if (panelProc) panelProc.kill()
		envDirs.cleanup()
	}
}

// ----------------------------------------------------------- 7. Multiterminal y Modo YOLO

async function runMultiterminalAndYoloSuite() {
	console.log('\n--- 7. Pruebas de Multiterminal y Modo YOLO ---')
	const envDirs = createTempDirs()
	const panelPort = await getFreePort()
	let panelProc = null

	try {
		panelProc = await startPanelProcess({
			panelPort,
			panelHome: envDirs.panelHome,
			codexHome: envDirs.codexHome,
		})

		await test('Nuevo proveedor default a approvalPolicy: never y sandboxMode: danger-full-access', async () => {
			const reg = await request(`http://127.0.0.1:${panelPort}/api/provider`, {
				method: 'POST',
				json: { label: 'Yolo Provider', baseUrl: 'https://api.yolo.test/v1', apiKey: 'sk-yolo-key', model: 'gpt-5' },
			})
			assert(reg.ok, 'Debe registrar proveedor')
			assert.strictEqual(reg.data.provider.approvalPolicy, 'never')
			assert.strictEqual(reg.data.provider.sandboxMode, 'danger-full-access')

			const inst = await request(`http://127.0.0.1:${panelPort}/api/install`, {
				method: 'POST',
				json: { id: 'yolo-provider' },
			})
			assert(inst.ok, 'Debe instalar proveedor')
			const configContent = fs.readFileSync(path.join(envDirs.codexHome, 'config.toml'), 'utf8')
			assert(configContent.includes('approval_policy = "never"'), 'config.toml debe tener approval_policy = never')
			assert(configContent.includes('sandbox_mode = "danger-full-access"'), 'config.toml debe tener sandbox_mode = danger-full-access')
		})

		await test('Guías de uso generan comandos YOLO para Codex y Claude', async () => {
			const codexGuide = await request(`http://127.0.0.1:${panelPort}/api/usage`, {
				method: 'POST',
				json: { id: 'yolo-provider', target: 'codex' },
			})
			assert(codexGuide.ok, 'Debe obtener guía Codex')
			const codexCmds = codexGuide.data.steps.flatMap((s) => s.cmds || []).join(' ')
			assert(codexCmds.includes('--dangerously-bypass-approvals-and-sandbox'), 'Codex debe incluir flag de bypass')

			const claudeGuide = await request(`http://127.0.0.1:${panelPort}/api/usage`, {
				method: 'POST',
				json: { id: 'yolo-provider', target: 'claude' },
			})
			assert(claudeGuide.ok, 'Debe obtener guía Claude')
			const claudeCmds = claudeGuide.data.steps.flatMap((s) => s.cmds || []).join(' ')
			assert(claudeCmds.includes('--dangerously-skip-permissions'), 'Claude debe incluir flag de bypass')
		})

		await test('/api/prepare-claude-multiterminal limpia env y fija permisos YOLO', async () => {
			const prep = await request(`http://127.0.0.1:${panelPort}/api/prepare-claude-multiterminal`, {
				method: 'POST',
			})
			assert(prep.ok, 'Debe preparar claude multiterminal')
			const state = await request(`http://127.0.0.1:${panelPort}/api/state`)
			assert(state.data.claude, 'Debe devolver estado de claude')
			assert.strictEqual(state.data.claude.isYolo, true, 'isYolo debe ser true')
			assert.strictEqual(state.data.claude.hasProviderEnv, false, 'hasProviderEnv debe ser false tras limpieza')
		})
	} finally {
		if (panelProc) panelProc.kill()
		envDirs.cleanup()
	}
}

// ----------------------------------------------------------- Ejecutor Principal

async function main() {
	console.log('====================================================')
	console.log('       EJECUTANDO PRUEBAS DE CODEX PANEL            ')
	console.log('====================================================')

	const started = Date.now()

	await runTomlTests()
	await runBridgeTests()
	await runFakeProviderVerdictsSuite()
	await runSyncAndActiveProviderSuite()
	await runBridgeLifecycleSuite()
	await runChatApiSuite()
	await runMultiterminalAndYoloSuite()

	const elapsed = ((Date.now() - started) / 1000).toFixed(2)
	console.log('\n====================================================')
	console.log(`RESULTADO: ${passed} pasadas, ${failed} fallidas (${elapsed}s)`)
	console.log('====================================================\n')

	if (failed > 0) {
		process.exit(1)
	}
}

main().catch((err) => {
	console.error('Error fatal en suite de pruebas:', err)
	process.exit(1)
})
