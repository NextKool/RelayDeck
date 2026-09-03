// Proveedor OpenAI-compatible falso para probar el panel sin salir a internet.
//
//   node qa/fake-provider.js <modo> <puerto>
//
// Modo full        : Responses API + saldo legacy        -> codex_ready
// Modo chatonly    : solo Chat Completions, sin saldo    -> chat_only
// Modo unauth      : siempre 401 de key revocada         -> invalid_key
// Modo clientblock : 401 "unauthorized client detected" salvo con huella de SDK
//                    real; el saldo vive en /api/user/self como new-api.
//                    Reproduce el bug reportado          -> codex_ready
// Modo hardblock   : 401 "unauthorized client detected" a todo el mundo
//                                                        -> client_blocked
// Modo strictcodex : exige el set COMPLETO de cabeceras de Codex (originator,
//                    session_id, x-client-request-id...) y solo responde a
//                    /v1/responses en streaming SSE          -> codex_ready
// Modo nostream    : acepta /v1/responses solo sin streaming -> codex_ready
//                    con aviso de que no strea
// Modo nochannel   : key valida, 5 modelos listados, pero solo gpt-5-codex
//                    tiene canal; los demas dan 503 "no hay canal" y 402
//                    "budget pool exhausted". Reproduce el caso AgentRouter.
//                    El panel debe encontrar el modelo bueno -> codex_ready
// Modo allblocked  : como nochannel pero NINGUN modelo tiene canal
//                                                        -> no_channel
// Modo metadata    : como nochannel, pero ADEMAS expone los metadatos de
//                    new-api (/api/pricing con supported_endpoint_types y
//                    /api/models con los canales). El panel debe deducir cual
//                    sirve SIN probar los que no                -> codex_ready
// Modo slow        : primera peticion 429 con Retry-After, luego responde
//                    despacio. Verifica reintentos y aviso de lentitud.
// Modo eol         : el modelo listado esta retirado (410 end of life) y
//                    /chat da 410; el panel debe pasar al siguiente modelo.
// Modo sentinel    : saldo centinela 99999999.77 de 100000000 -> "sin limite"
// Modo chatstream  : solo Chat Completions, pero en streaming SSE. Es el caso
//                    que el traductor tiene que convertir a Responses.
// Modo hidden      : EL CASO REAL REPORTADO. 27 modelos, /v1/responses
//                    devuelve 404 {"error":{"type":"openai_error"}} sin mensaje
//                    para todos MENOS gpt-5.6-sol. El primero de la lista esta
//                    retirado (410). El panel debe barrer y encontrarlo.
// Modo nores       : 27 modelos y NINGUNO sirve /v1/responses (404 pelado),
//                    pero Chat si funciona            -> no_responses + traductor
const http = require('http')

const MANY_MODELS = [
	'meta/llama-3.1-8b-instruct',
	'gpt-5.6-sol',
	...Array.from({ length: 25 }, (_, i) => `modelo-relleno-${String(i + 1).padStart(2, '0')}`),
]

const json = (res, status, payload) => {
	const body = JSON.stringify(payload)
	res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
	res.end(body)
}

const CLIENT_BLOCK = {
	error: {
		message: 'unauthorized client detected, contact support for assistance at https://discord.gg/aYq5B4RW3',
	},
}

const sse = (res, events) => {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
	})
	for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
	res.write('data: [DONE]\n\n')
	res.end()
}

// Cabeceras que manda Codex CLI de verdad. En modo strictcodex faltando una
// sola, se rechaza: sirve para verificar que el panel las envia todas.
const CODEX_REQUIRED = [
	'originator',
	'session_id',
	'conversation_id',
	'x-client-request-id',
	'x-codex-installation-id',
	'prompt_cache_key',
]

const missingCodexHeaders = (req) => {
	const missing = CODEX_REQUIRED.filter((h) => !req.headers[h])
	if (req.headers.originator && req.headers.originator !== 'codex_cli_rs') missing.push('originator=codex_cli_rs')
	if (!/^codex_cli_rs\/\d+\.\d+\.\d+ /.test(req.headers['user-agent'] || '')) missing.push('user-agent')
	return missing
}

function createFakeProvider(mode = 'full') {
	let slowHits = 0
	const MODE = mode

	return http.createServer((req, res) => {
		const url = req.url.split('?')[0]
		const auth = req.headers.authorization || ''
		const ua = req.headers['user-agent'] || ''
		const accept = req.headers.accept || ''
		let body = ''
		req.on('data', (c) => (body += c))

		if (MODE === 'hardblock') return json(res, 401, CLIENT_BLOCK)

		// Limite de ritmo la primera vez, como los relays saturados.
		if (MODE === 'slow' && url.startsWith('/v1/') && ++slowHits === 1) {
			res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' })
			return res.end(JSON.stringify({ error: { message: 'Too Many Requests' } }))
		}

		if (MODE === 'strictcodex') {
			const missing = missingCodexHeaders(req)
			if (missing.length) {
				console.log('  rechazado, faltan cabeceras:', missing.join(', '))
				return json(res, 401, CLIENT_BLOCK)
			}
		}

		// Filtro de huella: solo acepta un SDK conocido, como los relays reales.
		if (MODE === 'clientblock' && !/OpenAI\/JS/.test(ua)) {
			return json(res, 401, CLIENT_BLOCK)
		}

		if (MODE === 'unauth' || !auth.startsWith('Bearer sk-')) {
			return json(res, 401, { error: { message: 'Incorrect API key provided.' } })
		}

		// new-api: la cuota se consulta fuera de /v1 y en unidades internas.
		if (url === '/api/user/self') {
			if (MODE === 'metadata') {
				return json(res, 200, {
					success: true,
					data: { username: 'github_296148', group: 'default', quota: 26985000, used_quota: 335515000 },
				})
			}
			if (MODE !== 'clientblock' && MODE !== 'strictcodex') return json(res, 404, { error: { message: 'not found' } })
			// 53.97 USD restantes, 671.03 USD consumidos (500000 unidades = 1 USD)
			return json(res, 200, {
				success: true,
				data: { username: 'github_296148', quota: 26985000, used_quota: 335515000 },
			})
		}

		// Metadatos de new-api: aqui si se declara que soporta cada modelo.
		if (url === '/api/pricing' && MODE === 'metadata') {
			return json(res, 200, {
				success: true,
				// tipo 1 = chat/completions, 3 = responses
				supported_endpoint: {
					1: { method: 'POST', path: '/v1/chat/completions' },
					2: { method: 'POST', path: '/v1/embeddings' },
					3: { method: 'POST', path: '/v1/responses' },
				},
				group_ratio: { default: 1.0 },
				data: [
					{ model_name: 'claude-opus-4-8', enable_groups: ['default'], supported_endpoint_types: [1] },
					{ model_name: 'claude-sonnet-4.5', enable_groups: ['default'], supported_endpoint_types: [1] },
					{ model_name: 'gemini-3-pro', enable_groups: ['default'], supported_endpoint_types: [1] },
					{ model_name: 'deepseek-v3', enable_groups: ['default'], supported_endpoint_types: [1] },
					{ model_name: 'gpt-5-codex', enable_groups: ['default'], supported_endpoint_types: [1, 3] },
					// Soporta responses pero es de otro grupo: hay que descartarlo.
					{ model_name: 'gpt-5-vip', enable_groups: ['vip'], supported_endpoint_types: [1, 3] },
				],
			})
		}

		if (url === '/api/models' && MODE === 'metadata') {
			return json(res, 200, {
				success: true,
				data: { 1: ['claude-opus-4-8', 'claude-sonnet-4.5'], 2: ['gpt-5-codex', 'deepseek-v3'] },
			})
		}

		if (url === '/v1/models') {
			// Muchos relays bloquean el catalogo aunque la key sirva.
			if (MODE === 'clientblock') return json(res, 401, CLIENT_BLOCK)
			// Como AgentRouter: lista modelos Claude primero, y el util al final.
			if (MODE === 'nochannel' || MODE === 'allblocked' || MODE === 'metadata') {
				return json(res, 200, {
					object: 'list',
					data: [
						{ id: 'claude-opus-4-8' },
						{ id: 'claude-sonnet-4.5' },
						{ id: 'gemini-3-pro' },
						{ id: 'deepseek-v3' },
						{ id: 'gpt-5-codex' },
					],
				})
			}
			if (MODE === 'hidden' || MODE === 'nores') {
				return json(res, 200, { object: 'list', data: MANY_MODELS.map((id) => ({ id })) })
			}
			if (MODE === 'eol') {
				return json(res, 200, {
					object: 'list',
					data: [{ id: 'meta/llama-3.1-8b-instruct' }, { id: 'gpt-5.5-codex' }],
				})
			}
			return json(res, 200, {
				object: 'list',
				data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-codex' }, { id: 'claude-sonnet-4.5' }],
			})
		}

		if (url === '/v1/responses') {
			if (MODE === 'claudeonly') {
				return json(res, 404, { error: { message: 'Unknown request URL: /v1/responses' } })
			}
			// El caso real: 404 sin mensaje para casi todo.
			if (MODE === 'hidden' || MODE === 'nores') {
				return req.on('end', () => {
					let asked = ''
					let wantsStream = false
					try {
						const parsed = JSON.parse(body || '{}')
						asked = parsed.model || ''
						wantsStream = parsed.stream === true
					} catch {}
					if (asked.includes('llama')) {
						return json(res, 410, {
							error: {
								message: `The model '${asked}' has reached its end of life on 2026-08-26T09:00:00Z and is no longer available.`,
							},
						})
					}
					if (MODE === 'nores' || asked !== 'gpt-5.6-sol') {
						// Exactamente lo que devuelve el relay: 404 y nada mas.
						return json(res, 404, { error: { type: 'openai_error' } })
					}
					if (!wantsStream) return json(res, 400, { error: { message: 'stream required' } })
					return sse(res, [
						{ type: 'response.created', response: { id: 'r', status: 'in_progress' } },
						{ type: 'response.output_text.delta', delta: 'pong' },
						{ type: 'response.completed', response: { id: 'r', status: 'completed' } },
					])
				})
			}
			if (MODE === 'chatstream') {
				return json(res, 404, { error: { type: 'openai_error' } }) // sin message, a proposito
			}
			if (MODE === 'hidden' || MODE === 'nores') {
				return json(res, 200, { object: 'list', data: MANY_MODELS.map((id) => ({ id })) })
			}
			if (MODE === 'eol') {
				return req.on('end', () => {
					let asked = ''
					try {
						asked = JSON.parse(body || '{}').model || ''
					} catch {}
					if (asked.includes('llama')) {
						return json(res, 410, {
							error: {
								message: `The model '${asked}' has reached its end of life on 2026-08-26T09:00:00Z and is no longer available.`,
							},
						})
					}
					return sse(res, [
						{ type: 'response.created', response: { id: 'r', status: 'in_progress' } },
						{ type: 'response.completed', response: { id: 'r', status: 'completed' } },
					])
				})
			}
			if (MODE === 'slow') {
				// Tarda de verdad, pero responde.
				return setTimeout(
					() =>
						sse(res, [
							{ type: 'response.created', response: { id: 'r', status: 'in_progress' } },
							{ type: 'response.completed', response: { id: 'r', status: 'completed' } },
						]),
					1500,
				)
			}
			if (MODE === 'chatonly') {
				return json(res, 404, { error: { message: 'Unknown request URL: POST /v1/responses' } })
			}
			// Solo un modelo tiene canal asignado, como en el relay real.
			if (MODE === 'nochannel' || MODE === 'allblocked' || MODE === 'metadata') {
				return req.on('end', () => {
					let asked = ''
					let wantsStream = false
					try {
						const parsed = JSON.parse(body || '{}')
						asked = parsed.model || ''
						wantsStream = parsed.stream === true
					} catch {}
					const hasChannel = MODE !== 'allblocked' && asked === 'gpt-5-codex'
					if (!hasChannel) {
						return json(res, 503, {
							error: {
								message: `当前分组 default 下对于模型 ${asked} 无可用渠道 (request id: 2026${Date.now()})`,
							},
						})
					}
					if (!wantsStream) return json(res, 400, { error: { message: 'stream required' } })
					return sse(res, [
						{ type: 'response.created', response: { id: 'resp_fake', status: 'in_progress' } },
						{ type: 'response.completed', response: { id: 'resp_fake', status: 'completed' } },
					])
				})
			}

			// Estos dos modos se deciden con el cuerpo, asi que hay que esperarlo.
			if (MODE === 'strictcodex' || MODE === 'nostream') {
				return req.on('end', () => {
					let wantsStream = false
					try {
						wantsStream = JSON.parse(body || '{}').stream === true
					} catch {}
					if (MODE === 'nostream') {
						if (wantsStream) {
							return json(res, 400, { error: { message: 'streaming is not supported' } })
						}
						return json(res, 200, { id: 'resp_fake', object: 'response', status: 'completed' })
					}
					// strictcodex: solo streaming, como el Codex real
					if (!wantsStream || !accept.includes('text/event-stream')) {
						return json(res, 400, { error: { message: 'this endpoint requires stream:true' } })
					}
					sse(res, [
						{ type: 'response.created', response: { id: 'resp_fake', status: 'in_progress' } },
						{ type: 'response.output_text.delta', delta: 'pong' },
						{ type: 'response.completed', response: { id: 'resp_fake', status: 'completed' } },
					])
				})
			}
			return json(res, 200, {
				id: 'resp_fake',
				object: 'response',
				status: 'completed',
				output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }],
			})
		}

		// Chat en streaming: lo que el traductor tiene que convertir.
		if (url === '/v1/chat/completions' && MODE === 'chatstream') {
			return req.on('end', () => {
				let asked = ''
				let tools = null
				try {
					const parsed = JSON.parse(body || '{}')
					asked = parsed.model || ''
					tools = parsed.tools || null
				} catch {}
				res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
				const chunk = (delta, finish) =>
					res.write(
						`data: ${JSON.stringify({
							id: 'chatcmpl-fake',
							object: 'chat.completion.chunk',
							model: asked,
							choices: [{ index: 0, delta, finish_reason: finish || null }],
						})}\n\n`,
					)
				chunk({ role: 'assistant', content: '' })
				if (tools) {
					// Tambien probamos la traduccion de tool calls.
					chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '' } }] })
					chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] })
					chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] })
					chunk({}, 'tool_calls')
				} else {
					for (const piece of ['pong', ' desde', ' Chat']) chunk({ content: piece })
					chunk({}, 'stop')
				}
				res.write(
					`data: ${JSON.stringify({
						id: 'chatcmpl-fake',
						object: 'chat.completion.chunk',
						choices: [],
						usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
					})}\n\n`,
				)
				res.write('data: [DONE]\n\n')
				res.end()
			})
		}

		// Chat funciona salvo con el modelo retirado.
		if (url === '/v1/chat/completions' && (MODE === 'hidden' || MODE === 'nores')) {
			return req.on('end', () => {
				let asked = ''
				try {
					asked = JSON.parse(body || '{}').model || ''
				} catch {}
				if (asked.includes('llama')) {
					return json(res, 410, { error: { message: 'end of life' } })
				}
				return json(res, 200, { choices: [{ message: { role: 'assistant', content: 'pong' } }] })
			})
		}

		if (url === '/v1/chat/completions' && MODE === 'eol') {
			return json(res, 410, {
				error: { message: "The model has reached its end of life and is no longer available." },
			})
		}

		if (url === '/v1/messages') {
			if (MODE === 'claudeonly') {
				return req.on('end', () => {
					let wantsStream = false
					try {
						wantsStream = JSON.parse(body || '{}').stream === true
					} catch {}
					if (wantsStream) {
						return sse(res, [
							{ type: 'message_start', message: { id: 'msg_fake', role: 'assistant' } },
							{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'pong' } },
							{ type: 'message_stop' },
						])
					}
					return json(res, 200, {
						id: 'msg_fake',
						type: 'message',
						role: 'assistant',
						content: [{ type: 'text', text: 'pong' }],
					})
				})
			}
			return json(res, 404, { error: { message: 'Unknown request URL: ' + url } })
		}

		if (url === '/v1/chat/completions') {
			if (MODE === 'claudeonly') {
				return json(res, 404, { error: { message: 'Unknown request URL: ' + url } })
			}
			if (MODE === 'nochannel' || MODE === 'allblocked' || MODE === 'metadata') {
				return json(res, 402, {
					error: {
						message:
							'Budget pool quota has been exhausted. Please ask an administrator to increase the limit or select another budget pool.',
					},
				})
			}
			return json(res, 200, { choices: [{ message: { role: 'assistant', content: 'pong' } }] })
		}

		if (url === '/v1/dashboard/billing/subscription' && MODE === 'sentinel') {
			return json(res, 200, { hard_limit_usd: 100000000.0 })
		}
		if (url === '/v1/dashboard/billing/usage' && MODE === 'sentinel') {
			return json(res, 200, { total_usage: 23.0 }) // centavos -> $0.23
		}

		if (url === '/v1/dashboard/billing/subscription') {
			if (MODE === 'chatonly' || MODE === 'clientblock' || MODE === 'strictcodex' || MODE === 'claudeonly') {
				return json(res, 404, { error: { message: 'not found' } })
			}
			return json(res, 200, { hard_limit_usd: 153.0, access_until: 1798761600 })
		}

		if (url === '/v1/dashboard/billing/usage') {
			if (MODE === 'chatonly' || MODE === 'clientblock' || MODE === 'strictcodex' || MODE === 'claudeonly') {
				return json(res, 404, { error: { message: 'not found' } })
			}
			return json(res, 200, { total_usage: 2143.75 }) // centavos -> $21.44
		}

		return json(res, 404, { error: { message: 'Unknown request URL: ' + url } })
	})
}

if (require.main === module) {
	const mode = process.argv[2] || 'full'
	const port = Number(process.argv[3] || 7799)
	createFakeProvider(mode).listen(port, '127.0.0.1', () => console.log(`fake provider [${mode}] on ${port}`))
}

module.exports = { createFakeProvider, MANY_MODELS }
