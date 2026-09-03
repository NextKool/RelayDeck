'use strict'

/**
 * Traductor local Responses API -> Chat Completions.
 *
 * Codex solo habla la Responses API (`wire_api = "responses"`). Muchos relays
 * baratos solo exponen `/v1/chat/completions`. Este puente se pone en medio:
 * Codex le habla Responses, y el puente traduce a Chat contra el proveedor real.
 *
 *   Codex  --/v1/responses (SSE)-->  bridge  --/v1/chat/completions-->  relay
 *
 * Uso directo:
 *   BRIDGE_UPSTREAM=https://relay.tld/v1 BRIDGE_API_KEY=sk-... node bridge.js
 *   # -> http://127.0.0.1:7789/v1
 *
 * El panel lo arranca solo cuando un provider da veredicto "solo chat".
 */

const http = require('http')
const crypto = require('crypto')

const DEFAULT_TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 300000)

// ------------------------------------------------------- Responses -> Chat

/** Aplana el `content` de un item de Responses a texto plano. */
function flattenContent(content) {
	if (content == null) return null
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return null
	const parts = []
	for (const part of content) {
		if (typeof part === 'string') parts.push(part)
		else if (part && typeof part.text === 'string') parts.push(part.text)
	}
	return parts.join('')
}

/**
 * Convierte el `input` de Responses en `messages` de Chat. Codex manda un array
 * de items: mensajes, llamadas a herramienta y sus resultados.
 */
function toChatMessages(body) {
	const messages = []
	if (body.instructions) messages.push({ role: 'system', content: String(body.instructions) })

	const input = body.input
	if (typeof input === 'string') {
		messages.push({ role: 'user', content: input })
		return messages
	}
	if (!Array.isArray(input)) return messages

	for (const item of input) {
		if (typeof item === 'string') {
			messages.push({ role: 'user', content: item })
			continue
		}
		if (!item || typeof item !== 'object') continue

		// La IA pidio ejecutar una herramienta. Responses representa cada
		// llamada como un item; Chat agrupa las llamadas de un mismo turno.
		if (item.type === 'function_call') {
			const toolCall = {
				id: item.call_id || item.id || 'call_' + crypto.randomUUID().slice(0, 8),
				type: 'function',
				function: {
					name: item.name,
					arguments:
						typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
				},
			}
			const previous = messages[messages.length - 1]
			if (previous?.role === 'assistant') {
				if (!Array.isArray(previous.tool_calls)) previous.tool_calls = []
				previous.tool_calls.push(toolCall)
			} else {
				messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] })
			}
			continue
		}

		// El resultado de esa herramienta.
		if (item.type === 'function_call_output') {
			messages.push({
				role: 'tool',
				tool_call_id: item.call_id || item.id,
				content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
			})
			continue
		}

		// Codex reinyecta su propio razonamiento; Chat no lo entiende.
		if (item.type === 'reasoning') continue

		const text = flattenContent(item.content)
		if (text === null) continue
		const role = item.role === 'assistant' || item.role === 'system' ? item.role : 'user'
		messages.push({ role, content: text })
	}
	return messages
}

/** Herramientas: Responses las lleva planas, Chat las anida bajo `function`. */
function toChatTools(tools) {
	if (!Array.isArray(tools) || !tools.length) return undefined
	const out = []
	for (const tool of tools) {
		if (!tool || tool.type !== 'function') continue // web_search y demas no se pueden traducir
		const fn = tool.function || tool
		if (!fn.name) continue
		out.push({
			type: 'function',
			function: {
				name: fn.name,
				description: fn.description || '',
				parameters: fn.parameters || { type: 'object', properties: {} },
			},
		})
	}
	return out.length ? out : undefined
}

function toChatRequest(body, forcedModel) {
	const request = {
		model: forcedModel || body.model,
		messages: toChatMessages(body),
		stream: body.stream !== false,
	}
	if (typeof body.max_output_tokens === 'number') request.max_tokens = body.max_output_tokens
	if (typeof body.temperature === 'number') request.temperature = body.temperature
	if (typeof body.top_p === 'number') request.top_p = body.top_p

	const tools = toChatTools(body.tools)
	if (tools) {
		request.tools = tools
		if (body.tool_choice) request.tool_choice = body.tool_choice
		if (typeof body.parallel_tool_calls === 'boolean') {
			request.parallel_tool_calls = body.parallel_tool_calls
		}
	}
	// Lo demas (reasoning, store, include, truncation...) no existe en Chat.
	return request
}

// ------------------------------------------------------- Chat -> Responses

/** Construye el objeto `response` final en forma de Responses API. */
function buildResponse({ id, model, text, toolCalls, usage, status = 'completed', messageOutputIndex }) {
	const indexedOutput = []
	let nextDefaultIndex = 0
	if (text) {
		indexedOutput.push({
			index: messageOutputIndex ?? nextDefaultIndex++,
			item: {
				type: 'message',
				id: 'msg_' + id,
				status: 'completed',
				role: 'assistant',
				content: [{ type: 'output_text', text, annotations: [] }],
			},
		})
	}
	for (const [index, call] of toolCalls.entries()) {
		indexedOutput.push({
			index: call.outputIndex ?? nextDefaultIndex++,
			item: {
				type: 'function_call',
				id: call.itemId || `fc_${id}_${index}`,
				call_id: call.id || `call_${id}_${index}`,
				name: call.name,
				arguments: call.arguments || '{}',
				status: 'completed',
			},
		})
	}
	indexedOutput.sort((a, b) => a.index - b.index)
	const output = indexedOutput.map(({ item }) => item)
	return {
		id: 'resp_' + id,
		object: 'response',
		created_at: Math.floor(Date.now() / 1000),
		status,
		model,
		output,
		usage: {
			input_tokens: usage?.prompt_tokens ?? 0,
			output_tokens: usage?.completion_tokens ?? 0,
			total_tokens: usage?.total_tokens ?? 0,
		},
	}
}

/** Parser SSE incremental. Admite separadores LF y CRLF y conserva eventos
 * incompletos hasta recibir el siguiente bloque o el final del stream. */
class SseParser {
	constructor() {
		this.buffer = ''
	}

	push(text, final = false) {
		this.buffer += text
		const events = []
		let separator
		while ((separator = /\r?\n\r?\n/.exec(this.buffer))) {
			events.push(this.buffer.slice(0, separator.index))
			this.buffer = this.buffer.slice(separator.index + separator[0].length)
		}
		if (final && this.buffer) {
			events.push(this.buffer)
			this.buffer = ''
		}
		return events
	}
}

/** Extrae el campo data de un evento SSE, incluyendo data multilínea. */
function sseData(rawEvent) {
	const data = []
	for (const line of rawEvent.split(/\r?\n/)) {
		if (line === 'data') {
			data.push('')
		} else if (line.startsWith('data:')) {
			const value = line.slice(5)
			data.push(value.startsWith(' ') ? value.slice(1) : value)
		}
	}
	return data.length ? data.join('\n') : null
}

function parseJsonObject(text, label) {
	let parsed
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		throw new Error(`${label}: ${error.message}`)
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`${label}: se esperaba un objeto JSON`)
	}
	if (parsed.error) {
		const error = new Error(parsed.error.message || `${label}: error del proveedor`)
		error.upstreamError = parsed.error
		throw error
	}
	return parsed
}

function firstChatChoice(chunk, label) {
	if (!Array.isArray(chunk.choices)) throw new Error(`${label}: falta choices`)
	if (!chunk.choices.length) return null // Los chunks finales de usage pueden venir vacios.
	const choice = chunk.choices[0]
	if (!choice || typeof choice !== 'object') throw new Error(`${label}: choice invalido`)
	return choice
}

/**
 * Extrae texto, tool calls y usage de una respuesta de Chat Completions, sea
 * JSON de una pieza o un stream SSE. Algunos proveedores ignoran stream:false y
 * contestan SSE igual, y al reves: hay que aguantar las dos formas.
 */
function collectChatResult(text, isSse) {
	const calls = new Map()
	let content = ''
	let usage = null
	let sawChoice = false

	const absorb = (choice) => {
		if (!choice) return
		sawChoice = true
		const delta = choice.delta || choice.message || {}
		const piece = typeof delta.content === 'string' ? delta.content : flattenContent(delta.content)
		if (piece) content += piece
		for (const call of delta.tool_calls || []) {
			const index = call.index ?? calls.size
			const current = calls.get(index) || { id: null, name: '', arguments: '' }
			if (call.id) current.id = call.id
			if (call.function?.name) current.name = call.function.name
			if (call.function?.arguments) current.arguments += call.function.arguments
			calls.set(index, current)
		}
	}

	if (isSse) {
		const parser = new SseParser()
		let sawData = false
		for (const event of parser.push(text, true)) {
			const data = sseData(event)
			if (data === null || !data.trim()) continue
			sawData = true
			if (data.trim() === '[DONE]') continue
			const chunk = parseJsonObject(data, 'SSE invalido')
			absorb(firstChatChoice(chunk, 'SSE invalido'))
			if (chunk.usage) usage = chunk.usage
		}
		if (!sawData) throw new Error('SSE invalido: no contiene eventos data')
	} else {
		const parsed = parseJsonObject(text, 'JSON invalido')
		const choice = firstChatChoice(parsed, 'JSON invalido')
		if (!choice) throw new Error('JSON invalido: choices esta vacio')
		absorb(choice)
		usage = parsed.usage || null
	}

	if (!sawChoice) throw new Error(`${isSse ? 'SSE' : 'JSON'} invalido: no contiene choices`)
	return {
		text: content,
		toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c),
		usage,
	}
}

/** Emisor de SSE con numeracion de secuencia, como hace la API real. */
function sseWriter(res) {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	})
	let seq = 0
	return {
		send(event) {
			const payload = { ...event, sequence_number: seq++ }
			res.write(`event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`)
		},
		end() {
			res.end()
		},
	}
}

/**
 * Acumula los deltas de Chat y va emitiendo los eventos de Responses.
 * Devuelve el texto y las tool calls completas.
 */
class StreamAssembler {
	constructor(sse, { id, model }) {
		this.sse = sse
		this.id = id
		this.model = model
		this.text = ''
		this.calls = new Map() // index -> {id, name, arguments}
		this.usage = null
		this.messageOpen = false
		this.messageOutputIndex = null
		this.nextOutputIndex = 0
	}

	openMessage() {
		if (this.messageOpen) return
		this.messageOpen = true
		this.messageOutputIndex = this.nextOutputIndex++
		this.sse.send({
			type: 'response.output_item.added',
			output_index: this.messageOutputIndex,
			item: { type: 'message', id: 'msg_' + this.id, status: 'in_progress', role: 'assistant', content: [] },
		})
		this.sse.send({
			type: 'response.content_part.added',
			item_id: 'msg_' + this.id,
			output_index: this.messageOutputIndex,
			content_index: 0,
			part: { type: 'output_text', text: '', annotations: [] },
		})
	}

	/** Procesa un chunk de Chat Completions (streaming o completo). */
	consumeChoice(choice) {
		if (!choice) return
		const delta = choice.delta || choice.message || {}

		const content = typeof delta.content === 'string' ? delta.content : flattenContent(delta.content)
		if (content) {
			this.openMessage()
			this.text += content
			this.sse.send({
				type: 'response.output_text.delta',
				item_id: 'msg_' + this.id,
				output_index: this.messageOutputIndex,
				content_index: 0,
				delta: content,
			})
		}

		for (const call of delta.tool_calls || []) {
			const index = call.index ?? this.calls.size
			let current = this.calls.get(index)
			if (!current) {
				const ordinal = this.calls.size
				current = {
					id: null,
					itemId: `fc_${this.id}_${ordinal}`,
					name: '',
					arguments: '',
					outputIndex: this.nextOutputIndex++,
					started: false,
				}
				this.calls.set(index, current)
			}
			if (call.id && !current.started) current.id = call.id
			if (call.function?.name) current.name = call.function.name
			const argumentsDelta = call.function?.arguments || ''
			if (!current.started) {
				current.id ||= `call_${this.id}_${this.calls.size - 1}`
				current.started = true
				this.sse.send({
					type: 'response.output_item.added',
					output_index: current.outputIndex,
					item: {
						type: 'function_call',
						id: current.itemId,
						call_id: current.id,
						name: current.name,
						arguments: '',
						status: 'in_progress',
					},
				})
			}
			// En streaming los argumentos llegan troceados.
			if (argumentsDelta) {
				current.arguments += argumentsDelta
				this.sse.send({
					type: 'response.function_call_arguments.delta',
					item_id: current.itemId,
					output_index: current.outputIndex,
					delta: argumentsDelta,
				})
			}
		}
	}

	closeMessage() {
		if (!this.messageOpen) return
		this.sse.send({
			type: 'response.output_text.done',
			item_id: 'msg_' + this.id,
			output_index: this.messageOutputIndex,
			content_index: 0,
			text: this.text,
		})
		this.sse.send({
			type: 'response.content_part.done',
			item_id: 'msg_' + this.id,
			output_index: this.messageOutputIndex,
			content_index: 0,
			part: { type: 'output_text', text: this.text, annotations: [] },
		})
		this.sse.send({
			type: 'response.output_item.done',
			output_index: this.messageOutputIndex,
			item: {
				type: 'message',
				id: 'msg_' + this.id,
				status: 'completed',
				role: 'assistant',
				content: [{ type: 'output_text', text: this.text, annotations: [] }],
			},
		})
	}

	toolCalls() {
		return [...this.calls.values()].sort((a, b) => a.outputIndex - b.outputIndex)
	}

	finish() {
		this.closeMessage()
		const calls = this.toolCalls()
		for (const call of calls) {
			const argumentsText = call.arguments || '{}'
			this.sse.send({
				type: 'response.function_call_arguments.done',
				item_id: call.itemId,
				output_index: call.outputIndex,
				arguments: argumentsText,
			})
			this.sse.send({
				type: 'response.output_item.done',
				output_index: call.outputIndex,
				item: {
					type: 'function_call',
					id: call.itemId,
					call_id: call.id,
					name: call.name,
					arguments: argumentsText,
					status: 'completed',
				},
			})
		}
		const response = buildResponse({
			id: this.id,
			model: this.model,
			text: this.text,
			toolCalls: calls,
			usage: this.usage,
			messageOutputIndex: this.messageOutputIndex,
		})
		this.sse.send({ type: 'response.completed', response })
		this.sse.end()
		return response
	}
}

// ------------------------------------------------------------------ servidor

function readBody(req, limit = 20e6) {
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
			if (settled) return
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			size += buffer.length
			if (size > limit) {
				chunks.length = 0
				req.removeListener('data', onData)
				req.resume()
				const error = new Error('Body demasiado grande')
				error.code = 'BODY_TOO_LARGE'
				return fail(error)
			}
			chunks.push(buffer)
		}

		req.on('data', onData)
		req.on('end', () => {
			if (settled) return
			settled = true
			resolve(Buffer.concat(chunks, size).toString('utf8'))
		})
		req.on('error', fail)
	})
}

function joinUrl(base, suffix) {
	return String(base || '').replace(/\/+$/, '') + suffix
}

/**
 * Crea el puente. `headers()` permite reutilizar las mismas cabeceras de
 * cliente que usa el panel, para relays que filtran por huella.
 */
function createBridge({ upstream, apiKey, model, headers, timeoutMs = DEFAULT_TIMEOUT_MS, log } = {}) {
	if (!upstream) throw new Error('Falta upstream')
	const say = log || (() => {})

	const upstreamHeaders = (accept) => ({
		Authorization: 'Bearer ' + apiKey,
		'Content-Type': 'application/json',
		Accept: accept,
		...(typeof headers === 'function' ? headers(accept) : headers || {}),
	})

	const server = http.createServer(async (req, res) => {
		const host = (req.headers.host || '').split(':')[0]
		if (host && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
			res.writeHead(403, { 'Content-Type': 'application/json' })
			return res.end(JSON.stringify({ error: { message: 'Solo acceso local' } }))
		}

		const url = req.url.split('?')[0]

		// Catalogo: se pasa tal cual al proveedor real.
		if (req.method === 'GET' && /\/models$/.test(url)) {
			try {
				const upstreamRes = await fetch(joinUrl(upstream, '/models'), {
					headers: upstreamHeaders('application/json'),
					signal: AbortSignal.timeout(30000),
				})
				const text = await upstreamRes.text()
				res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json; charset=utf-8' })
				return res.end(text)
			} catch (error) {
				res.writeHead(502, { 'Content-Type': 'application/json' })
				return res.end(JSON.stringify({ error: { message: String(error.message || error) } }))
			}
		}

		if (req.method !== 'POST' || !/\/responses$/.test(url)) {
			res.writeHead(404, { 'Content-Type': 'application/json' })
			return res.end(JSON.stringify({ error: { message: 'Solo POST /v1/responses y GET /v1/models' } }))
		}

		let body
		try {
			body = JSON.parse((await readBody(req)) || '{}')
		} catch (error) {
			const tooLarge = error?.code === 'BODY_TOO_LARGE'
			res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' })
			return res.end(JSON.stringify({ error: { message: tooLarge ? error.message : 'JSON invalido' } }))
		}

		const wantsStream = body.stream !== false
		const chatRequest = toChatRequest(body, model)
		const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24)
		say(`responses -> chat  model=${chatRequest.model}  msgs=${chatRequest.messages.length}`)

		let upstreamRes
		try {
			upstreamRes = await fetch(joinUrl(upstream, '/chat/completions'), {
				method: 'POST',
				headers: upstreamHeaders(chatRequest.stream ? 'text/event-stream' : 'application/json'),
				body: JSON.stringify(chatRequest),
				signal: AbortSignal.timeout(timeoutMs),
			})
		} catch (error) {
			const message = error.name === 'TimeoutError' ? 'timeout con el proveedor' : String(error.message || error)
			res.writeHead(504, { 'Content-Type': 'application/json' })
			return res.end(JSON.stringify({ error: { message, type: 'bridge_upstream_error' } }))
		}

		// Error del proveedor: se reenvia tal cual para no ocultar el motivo.
		if (!upstreamRes.ok) {
			const text = await upstreamRes.text()
			say(`upstream HTTP ${upstreamRes.status}`)
			res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json; charset=utf-8' })
			return res.end(text || JSON.stringify({ error: { message: `HTTP ${upstreamRes.status}` } }))
		}

		const contentType = upstreamRes.headers.get('content-type') || ''
		const upstreamStreams = contentType.includes('text/event-stream')

		// ---- Camino sin streaming: una sola respuesta JSON
		if (!wantsStream) {
			try {
				const raw = await upstreamRes.text()
				const collected = collectChatResult(raw, upstreamStreams)
				const response = buildResponse({
					id,
					model: chatRequest.model,
					text: collected.text,
					toolCalls: collected.toolCalls,
					usage: collected.usage,
				})
				res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
				return res.end(JSON.stringify(response))
			} catch (error) {
				say(`respuesta upstream invalida: ${error.message || error}`)
				res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
				return res.end(
					JSON.stringify({
						error: { message: String(error.message || error), type: 'bridge_upstream_error' },
					}),
				)
			}
		}

		// ---- Camino streaming: traducir evento a evento
		const sse = sseWriter(res)
		const assembler = new StreamAssembler(sse, { id, model: chatRequest.model })
		sse.send({
			type: 'response.created',
			response: {
				id: 'resp_' + id,
				object: 'response',
				created_at: Math.floor(Date.now() / 1000),
				status: 'in_progress',
				model: chatRequest.model,
				output: [],
			},
		})
		sse.send({
			type: 'response.in_progress',
			response: { id: 'resp_' + id, object: 'response', status: 'in_progress', model: chatRequest.model },
		})

		const failStream = (error) => {
			const upstreamError = error?.upstreamError
			const detail =
				upstreamError && typeof upstreamError === 'object'
					? upstreamError
					: { message: String(error?.message || error), type: 'bridge_upstream_error' }
			sse.send({
				type: 'response.failed',
				response: { id: 'resp_' + id, object: 'response', status: 'failed', error: detail },
			})
			sse.end()
		}

		// El proveedor puede ignorar stream:true y contestar JSON de golpe:
		// tambien lo traducimos, no es un error.
		if (!upstreamStreams) {
			try {
				const collected = collectChatResult(await upstreamRes.text(), false)
				if (collected.text) assembler.consumeChoice({ delta: { content: collected.text } })
				for (const [index, call] of collected.toolCalls.entries()) {
					assembler.consumeChoice({
						delta: {
							tool_calls: [
								{ index, id: call.id, function: { name: call.name, arguments: call.arguments } },
							],
						},
					})
				}
				assembler.usage = collected.usage
				assembler.finish()
			} catch (error) {
				failStream(error)
			}
			return
		}

		const reader = upstreamRes.body.getReader()
		const decoder = new TextDecoder()
		const parser = new SseParser()
		let closed = false
		let sawData = false
		let sawChoice = false
		req.on('close', () => {
			closed = true
			reader.cancel().catch(() => {})
		})

		function consumeEvent(rawEvent) {
			const data = sseData(rawEvent)
			if (data === null || !data.trim()) return
			sawData = true
			if (data.trim() === '[DONE]') return
			const chunk = parseJsonObject(data, 'SSE invalido')
			const choice = firstChatChoice(chunk, 'SSE invalido')
			if (choice) {
				sawChoice = true
				assembler.consumeChoice(choice)
			}
			if (chunk.usage) assembler.usage = chunk.usage
		}

		try {
			while (!closed) {
				const { done, value } = await reader.read()
				if (done) break
				for (const event of parser.push(decoder.decode(value, { stream: true }))) {
					consumeEvent(event)
				}
			}
			if (!closed) {
				for (const event of parser.push(decoder.decode(), true)) {
					consumeEvent(event)
				}
				if (!sawData) throw new Error('SSE invalido: no contiene eventos data')
				if (!sawChoice) throw new Error('SSE invalido: no contiene choices')
			}
		} catch (error) {
			if (!closed) failStream(error)
			return
		}

		if (!closed) assembler.finish()
	})

	return server
}

module.exports = {
	createBridge,
	toChatRequest,
	toChatMessages,
	toChatTools,
	buildResponse,
	collectChatResult,
}

// ------------------------------------------------------------------- CLI

if (require.main === module) {
	const upstream = process.env.BRIDGE_UPSTREAM
	const apiKey = process.env.BRIDGE_API_KEY
	const model = process.env.BRIDGE_MODEL || null
	const port = Number(process.env.BRIDGE_PORT || 7789)
	if (!upstream || !apiKey) {
		console.error('Faltan BRIDGE_UPSTREAM y/o BRIDGE_API_KEY')
		console.error('Ej: BRIDGE_UPSTREAM=https://relay.tld/v1 BRIDGE_API_KEY=sk-... node bridge.js')
		process.exit(1)
	}
	createBridge({ upstream, apiKey, model, log: (m) => console.log('  ' + m) }).listen(
		port,
		'127.0.0.1',
		() => {
			console.log(`\n  Traductor Chat->Responses  http://127.0.0.1:${port}/v1`)
			console.log(`  Proveedor real             ${upstream}`)
			console.log(`  Modelo forzado             ${model || '(el que pida Codex)'}\n`)
		},
	)
}
