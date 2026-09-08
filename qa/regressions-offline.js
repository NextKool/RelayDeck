'use strict'

// Regresiones sobre las funciones reales, con HTTP, almacenamiento y puentes
// sustituidos en memoria. No abre puertos ni utiliza credenciales o proveedores.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { test } = require('node:test')

const root = path.resolve(__dirname, '..')
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
const localRequire = createRequire(path.join(root, 'server.js'))
const failSideEffect = () => { throw new Error('Efecto externo prohibido en prueba offline') }

function backend(providers = []) {
	const effects = { providers, starts: [], stops: [], installs: [] }
	const context = vm.createContext({
		console, URL, URLSearchParams, Buffer, TextDecoder, AbortSignal,
		process: { env: {}, platform: process.platform, pid: process.pid, versions: process.versions },
		__dirname: root,
		require: (name) => {
			if (name === 'http') return { createServer: () => ({ listen: failSideEffect }) }
			if (name === 'child_process') return { spawn: failSideEffect, execFileSync: failSideEffect }
			if (name === './bridge') return { createBridge: failSideEffect }
			if (name === 'fs') return new Proxy(fs, { get(target, key) {
				return /^(write|append|mkdir|chmod|rename|copy|unlink|rm)/.test(String(key)) ? failSideEffect : target[key]
			} })
			return localRequire(name)
		},
		fetch: failSideEffect,
		setTimeout, clearTimeout, effects,
	})
	const end = serverSource.lastIndexOf('\nensureHome()')
	assert(end > 0, 'Debe aislar el bootstrap que abre el servidor')
	vm.runInContext(serverSource.slice(0, end), context, { filename: 'server.js' })
	vm.runInContext(`
		readStore = () => effects.providers;
		writeStore = (providers) => { effects.providers = providers; };
		syncWithConfig = (providers) => providers;
		readConfig = () => '';
		readClaudeConfig = () => ({});
		startBridge = async (provider) => {
			if (!providerNeedsBridge(provider)) throw new Error('Puente incompatible');
			effects.starts.push(provider);
			return {url:'http://127.0.0.1:9999/v1', port:9999};
		};
		stopBridge = (id) => { effects.stops.push(id); };
		install = (provider) => { effects.installs.push(provider); return {}; };
		inspectConfig = () => ({});
		usageGuide = () => ({});
		launchCommand = () => '';
		globalThis.api = {routes, runRelayDiagnostics, providerNeedsBridge, rejectedUnknownModel};
	`, context)
	return { context, api: context.api, effects }
}

function provider(target = 'responses', extra = {}) {
	return { id: 'test', label: 'Test', baseUrl: 'https://relay.invalid/v1', apiKey: 'dummy',
		model: 'gpt-test', useBridge: false, modelResults: { 'gpt-test': { ok: true, target } }, ...extra }
}

function diagnosticBackend(options = {}) {
	const p = provider(options.target || 'responses', options.provider)
	const env = backend([p])
	let calls = 0
	env.context.probeSmart = async (url, request) => {
		calls++
		const base = { ok: true, httpStatus: 200, ms: 1, finalUrl: url, headers: { 'x-request-id': 'req-' + calls, 'request-id': 'req-' + calls } }
		const error = (status, message) => ({ ...base, ok: false, httpStatus: status, json: { error: { message } } })
		if (url.includes('/models/')) return { ...base, json: { id: 'gpt-test' } }
		const bridge = url.startsWith('http://127.0.0.1:9999')
		if (options.bridgeFail && bridge) return error(403, 'Access denied')
		if (options.workingProtocol && !bridge) {
			const suffix = { responses: '/responses', chat: '/chat/completions', anthropic: '/messages' }[options.workingProtocol]
			if (!url.endsWith(suffix)) return error(404, 'Unknown request URL')
		}
		if (request.json.model !== 'gpt-test') {
			if (options.negativeHtml) return { ...base, ok: false, httpStatus: 403, text: '<html>WAF denied</html>', json: null }
			if (options.negativeEmpty) return { ...base, json: {} }
			if (!options.negativeAccepted) return error(404, 'model not found')
		}
		const prompt = request.json.input || request.json.messages?.[0]?.content || ''
		const nonce = /RD-([a-f0-9]{24})/.exec(prompt)?.[0] || 'OK'
		const tokens = options.sameUsage ? 10 : Math.ceil(prompt.length / 4)
		return { ...base, json: { id: 'res-' + calls, model: 'gpt-test', output_text: nonce,
			content: [{ type: 'text', text: nonce }], choices: [{ message: { content: nonce } }],
			usage: { input_tokens: tokens, output_tokens: 8 } } }
	}
	return env
}

async function runDiagnostic(options) {
	const env = diagnosticBackend(options)
	const events = []
	const report = await env.api.runRelayDiagnostics(env.effects.providers[0], 'gpt-test', event => events.push(event))
	return { ...env, report, events }
}

test('el protocolo confirmado prevalece sobre useBridge y los resultados globales', () => {
	const { api } = backend()
	for (const target of ['responses', 'claude', 'anthropic']) {
		assert.equal(api.providerNeedsBridge(provider(target, { useBridge: true, lastTest: { verdict: 'chat_only' } })), false)
	}
	assert.equal(api.providerNeedsBridge(provider('chat')), true)
	assert.equal(api.providerNeedsBridge(provider('responses'), 'gpt-test', 'chat'), true)
})

test('seleccionar Anthropic limpia el flag antiguo y no inicia puente', async () => {
	const env = backend([provider('claude', { useBridge: true })])
	const res = await env.api.routes['POST /api/set-model']({ id: 'test', model: 'gpt-test' })
	assert.equal(res.provider.useBridge, false)
	assert.equal(env.effects.starts.length, 0)
})

test('instalar Anthropic en perfil Codex se rechaza antes de iniciar puente o escribir', async () => {
	const env = backend([provider('claude', { useBridge: true })])
	await assert.rejects(env.api.routes['POST /api/install']({ id: 'test' }), /Anthropic/)
	assert.equal(env.effects.starts.length, 0)
	assert.equal(env.effects.installs.length, 0)
})

test('GET state no reactiva el puente para un modelo Anthropic instalado', async () => {
	const env = backend([provider('claude', { useBridge: true, installed: true })])
	const state = await env.api.routes['GET /api/state']()
	assert.equal(state.providers[0].useBridge, false)
	assert.equal(env.effects.starts.length, 0)
})

test('Chat todavía instala con puente, Responses instala directo', async () => {
	for (const target of ['chat', 'responses']) {
		const env = backend([provider(target, { useBridge: true })])
		await env.api.routes['POST /api/install']({ id: 'test' })
		assert.equal(env.effects.starts.length, target === 'chat' ? 1 : 0)
		assert.equal(env.effects.installs[0].useBridge, target === 'chat')
	}
})

test('al migrar de puente a Responses, state actualiza la URL del perfil activo', async () => {
	const env = backend([provider('responses', { useBridge: true, installed: true })])
	env.context.readConfig = () => 'model_provider = "test"\n[model_providers.test]\nbase_url = "http://127.0.0.1:9999/v1"\n'
	await env.api.routes['GET /api/state']()
	assert.equal(env.effects.starts.length, 0)
	assert.equal(env.effects.installs.length, 1)
	assert.equal(env.effects.installs[0].useBridge, false)
})

test('un HTTP genérico o un bloqueo HTML no demuestra rechazo del modelo', () => {
	const { api } = backend()
	for (const httpStatus of [400, 403, 404, 410, 422, 503]) {
		assert.equal(api.rejectedUnknownModel({ httpStatus, json: { error: { message: 'Access denied' } } }), false)
	}
	assert.equal(api.rejectedUnknownModel({ httpStatus: 503, json: { error: { message: 'No available channel for model random under group default' } } }), true)
	assert.equal(api.rejectedUnknownModel({ httpStatus: 404, json: { error: { code: 'model_not_found' } } }), true)
})

test('WAF 403 produce control inconcluso y resumen parcial', async () => {
	const { report } = await runDiagnostic({ negativeHtml: true })
	assert.equal(report.probes.find(p => p.id === 'routing').status, 'warn')
	assert.equal(report.verdict, 'relay_partial')
})

test('respuesta vacía 200 no prueba aceptación de modelo inexistente', async () => {
	const { report } = await runDiagnostic({ negativeEmpty: true })
	assert.equal(report.probes.find(p => p.id === 'routing').status, 'warn')
})

test('modelo inexistente con respuesta utilizable sigue siendo anomalía', async () => {
	const { report } = await runDiagnostic({ negativeAccepted: true })
	assert.equal(report.probes.find(p => p.id === 'routing').status, 'bad')
	assert.equal(report.verdict, 'routing_anomaly')
})

test('anomalía de tokens aparece también en el resumen', async () => {
	const { report } = await runDiagnostic({ sameUsage: true })
	assert.equal(report.probes.find(p => p.id === 'usage').status, 'bad')
	assert.equal(report.verdict, 'routing_anomaly')
})

test('puente fallido no permite declarar diagnóstico completo', async () => {
	const { report, events } = await runDiagnostic({ target: 'chat', bridgeFail: true })
	assert.equal(report.verdict, 'relay_partial')
	assert.match(report.verdictDesc, /puente/)
	assert.equal(events.find(e => e.stage === 'bridge_second' && e.state === 'failed').state, 'failed')
})

test('fallback real a Chat agrega el puente y comunica el cambio de etapas', async () => {
	const { report, events, effects } = await runDiagnostic({ workingProtocol: 'chat' })
	assert.equal(report.paths.direct.protocol, 'chat')
	assert.equal(report.paths.bridge.available, true)
	assert.equal(effects.starts.length, 1)
	assert.equal(effects.stops.length, 1)
	assert(events.some(e => e.useBridge === true))
})

test('fallback real a Anthropic elimina puente y describe la ruta real', async () => {
	const { report, events, effects } = await runDiagnostic({ target: 'chat', workingProtocol: 'anthropic' })
	assert.equal(report.paths.direct.protocol, 'anthropic')
	assert.equal(report.paths.bridge, null)
	assert.equal(effects.starts.length, 0)
	assert(events.some(e => e.useBridge === false))
	assert.match(report.diagnosticSummary.routeComparison, /Anthropic/)
})

test('controles completos conservan resultado consistente', async () => {
	const { report } = await runDiagnostic({})
	assert.equal(report.verdict, 'relay_consistent')
})

test('Probar nivel usa el protocolo confirmado, su campo correcto y timeout', async () => {
	for (const target of ['claude', 'responses', 'chat']) {
		const env = backend([provider(target)])
		const calls = []
		env.context.probeSmart = async (url, options) => {
			calls.push({ url, options })
			return { ok: true, httpStatus: 200, json: { content: [], output: [], choices: [{}] } }
		}
		const result = await env.api.routes['POST /api/test-effort']({ id: 'test', model: 'gpt-test', effort: 'high' })
		assert.equal(result.ok, true)
		assert.equal(calls.length, 1)
		const { url, options } = calls[0]
		assert.equal(options.timeout, 12000)
		if (target === 'claude') {
			assert(url.endsWith('/messages'))
			assert.equal(options.json.output_config.effort, 'high')
			assert.equal(options.extraHeaders['x-api-key'], 'dummy')
		} else if (target === 'responses') {
			assert(url.endsWith('/responses'))
			assert.equal(options.json.reasoning.effort, 'high')
			assert.equal(options.json.reasoning_effort, undefined)
		} else {
			assert(url.endsWith('/chat/completions'))
			assert.equal(options.json.reasoning_effort, 'high')
		}
	}
})

test('un rechazo de effort no se oculta cambiando de protocolo', async () => {
	const env = backend([provider('claude')])
	let calls = 0
	env.context.probeSmart = async () => {
		calls++
		return { ok: false, httpStatus: 400, json: { error: { message: 'Unsupported effort minimal' } } }
	}
	const res = await env.api.routes['POST /api/test-effort']({ id: 'test', model: 'gpt-test', effort: 'minimal' })
	assert.equal(res.ok, false)
	assert.equal(calls, 1)
	assert.match(res.error, /Unsupported effort/)
})

test('HTML con HTTP 200 no aprueba Probar nivel', async () => {
	const env = backend([provider()])
	env.context.probeSmart = async () => ({ ok: true, httpStatus: 200, text: '<html>blocked</html>', json: null })
	const res = await env.api.routes['POST /api/test-effort']({ id: 'test', model: 'gpt-test', effort: 'high' })
	assert.equal(res.ok, false)
})

async function frontendRun({ drawingError = false, requestError = false } = {}) {
	const start = html.indexOf("if (a === 'run-relay-diagnostics')")
	const end = html.indexOf("if (a === 'showallstatus')", start)
	assert(start > 0 && end > start)
	const events = [
		{ seq: 1, stage: 'preparing', state: 'done', updatedAt: 1 },
		{ seq: 2, stage: 'direct_second', state: 'done', updatedAt: 2, useBridge: true },
		{ seq: 3, stage: 'bridge_first', state: 'running', updatedAt: 3 },
		{ seq: 4, stage: 'bridge_first', state: 'done', updatedAt: 4 },
	]
	const notices = [], drawn = []
	const context = vm.createContext({
		a: 'run-relay-diagnostics', m: 'gpt-test', S: {},
		cur: () => provider(), curModel: () => 'gpt-test', relayDiagnosticUsesBridge: () => false,
		render: () => {}, toast: (...args) => notices.push(args),
		setInterval: () => 1, clearInterval: () => {},
		setTimeout: (fn, ms) => ms === 0 ? 0 : setImmediate(fn),
		updateRelayProgressDisplay: () => {
			if (drawingError) throw new Error('simulated drawing failure')
			drawn.push(context.S.relayDiagnosticsProgress['test:gpt-test'].useBridge)
		},
		api: async (url) => {
			if (url.includes('-progress')) return { startedAt: 1, events }
			if (requestError) throw new Error('simulated request failure')
			return { ok: true, execution: { startedAt: 1, events } }
		},
	})
	await vm.runInContext('(async () => {' + html.slice(start, end) + '})()', context)
	return { context, notices, drawn }
}

test('UI recorre eventos reales y guarda el resultado sin ReferenceError', async () => {
	const { context, drawn } = await frontendRun()
	assert.equal(context.S.relayDiagnostics['test:gpt-test'].ok, true)
	assert.equal(context.S.relayDiagnosticsRunning['test:gpt-test'], false)
	assert.deepEqual(drawn, [false, true, true, true])
})

test('fallo de dibujo no pierde resultado ni deja promesas rechazadas', async () => {
	const { context, notices } = await frontendRun({ drawingError: true })
	assert.equal(context.S.relayDiagnostics['test:gpt-test'].ok, true)
	assert(notices.some(n => /transiciones/.test(n[0])))
})

test('fallo del request y del dibujo se informa y libera la interfaz', async () => {
	const { context, notices } = await frontendRun({ drawingError: true, requestError: true })
	assert.equal(context.S.relayDiagnosticsRunning['test:gpt-test'], false)
	assert(notices.some(n => /simulated request failure/.test(n[0])))
})

test('el DOM de etapas incorpora o retira el puente al cambiar la ruta observada', () => {
	const start = html.indexOf('function relayProgressStages(')
	const end = html.indexOf('function paneRelayDiagnostics(', start)
	const list = { innerHTML: '' }
	const card = { dataset: { relayProgress: 'test', useBridge: 'false' } }
	const context = vm.createContext({
		S: { relayDiagnosticsProgress: { test: { useBridge: true, stages: {} } } },
		esc: value => String(value),
		$: selector => selector === '.relay-progress' ? card : selector === '.fp-steps' ? list : null,
	})
	vm.runInContext(html.slice(start, end), context)
	context.updateRelayProgressDisplay('test', false)
	assert.match(list.innerHTML, /data-fp-stage="bridge_first"/)
	context.S.relayDiagnosticsProgress.test.useBridge = false
	context.updateRelayProgressDisplay('test', true)
	assert.doesNotMatch(list.innerHTML, /data-fp-stage="bridge_first"/)
})
