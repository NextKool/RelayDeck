'use strict'

/**
 * Editor estructural de TOML, sin dependencias.
 *
 * POR QUE EXISTE: antes el panel hacia `append` a ciegas sobre config.toml. Si
 * ya tenias `model = "..."` escrito a mano, o un `[model_providers.x]` propio,
 * el archivo acababa con la MISMA CLAVE dos veces. En TOML eso no es "lo ultimo
 * gana": es un error de parseo, y Codex se niega a arrancar.
 *
 * Este modulo no interpreta valores: los deja tal cual estan escritos. Lo que
 * hace es entender la ESTRUCTURA del archivo — que tablas hay, que claves tiene
 * cada una y en que lineas — para poder EDITAR en su sitio:
 *
 *   - si la clave ya existe, se reemplaza esa linea
 *   - si no existe, se anade al final de su tabla
 *   - si hay tablas o claves duplicadas (de una version anterior o de un
 *     append manual), se detectan y se pueden reparar
 *
 * Se respeta todo lo demas: comentarios, orden, formato y claves ajenas.
 */

// ─────────────────────────────────────────────────────── escaneo de bajo nivel

/**
 * Recorre el texto y devuelve, por cada linea fisica, a que construccion
 * pertenece. Lo importante es no confundirse con:
 *   - comentarios (`# ...`)
 *   - cadenas normales, literales y multilinea (`"""` y `'''`)
 *   - arrays y tablas inline que ocupan varias lineas
 * Sin esto, un `#` dentro de una cadena o un `]` dentro de un comentario
 * romperian el analisis.
 */
function scanLines(text) {
	const lines = text.split(/\r?\n/)
	// Estado que sobrevive entre lineas: solo las cadenas multilinea y los
	// arrays/tablas inline abiertos.
	let openMulti = null // '"""' | "'''" | null
	let depth = 0 // corchetes/llaves abiertos
	const info = []

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const startedInside = openMulti !== null || depth > 0
		let j = 0
		let sawContent = false
		let headerName = null
		let arrayTable = false
		let keyText = null

		while (j < line.length) {
			// ── dentro de una cadena multilinea: solo buscamos su cierre
			if (openMulti) {
				const at = findMultiClose(line, openMulti, j)
				if (at === -1) {
					j = line.length
				} else {
					j = at + 3
					openMulti = null
				}
				continue
			}

			const ch = line[j]

			if (ch === ' ' || ch === '\t') {
				j++
				continue
			}

			// ── comentario: el resto de la linea no cuenta
			if (ch === '#') break

			// ── apertura de cadena multilinea
			if (line.startsWith('"""', j) || line.startsWith("'''", j)) {
				openMulti = line.slice(j, j + 3)
				j += 3
				sawContent = true
				continue
			}

			// ── cadena de una linea
			if (ch === '"' || ch === "'") {
				const quote = ch
				j++
				while (j < line.length) {
					if (quote === '"' && line[j] === '\\') {
						j += 2
						continue
					}
					if (line[j] === quote) {
						j++
						break
					}
					j++
				}
				sawContent = true
				continue
			}

			// ── cabecera de tabla, solo si es lo primero de la linea
			if (ch === '[' && !sawContent && depth === 0 && !startedInside) {
				const double = line.startsWith('[[', j)
				const close = double ? ']]' : ']'
				const at = line.indexOf(close, j + close.length)
				if (at !== -1) {
					headerName = line.slice(j + close.length, at).trim()
					arrayTable = double
					j = at + close.length
					sawContent = true
					continue
				}
			}

			if (ch === '[' || ch === '{') {
				depth++
				j++
				sawContent = true
				continue
			}
			if (ch === ']' || ch === '}') {
				depth = Math.max(0, depth - 1)
				j++
				sawContent = true
				continue
			}

			// ── una clave: lo que hay antes del primer '=' de la linea
			if (!sawContent && depth === 0 && !startedInside && keyText === null && headerName === null) {
				const eq = findEquals(line, j)
				if (eq !== -1) {
					keyText = line.slice(j, eq).trim()
					j = eq + 1
					sawContent = true
					continue
				}
			}

			sawContent = true
			j++
		}

		info.push({
			raw: line,
			// Continuacion de la construccion anterior (array o cadena abiertos).
			continuation: startedInside,
			header: headerName,
			arrayTable,
			key: keyText === null ? null : normalizeKey(keyText),
			keyRaw: keyText,
			blank: line.trim() === '',
			comment: line.trim().startsWith('#'),
		})
	}

	return info
}

function findMultiClose(line, delimiter, from) {
	let at = line.indexOf(delimiter, from)
	while (at !== -1 && delimiter === '"""') {
		let slashes = 0
		for (let i = at - 1; i >= 0 && line[i] === '\\'; i--) slashes++
		if (slashes % 2 === 0) break
		at = line.indexOf(delimiter, at + 1)
	}
	return at
}

/** Busca el '=' que separa clave de valor, respetando comillas. */
function findEquals(line, from) {
	let i = from
	while (i < line.length) {
		const ch = line[i]
		if (ch === '"' || ch === "'") {
			const quote = ch
			i++
			while (i < line.length) {
				if (quote === '"' && line[i] === '\\') {
					i += 2
					continue
				}
				if (line[i] === quote) {
					i++
					break
				}
				i++
			}
			continue
		}
		if (ch === '#') return -1
		if (ch === '=') return i
		i++
	}
	return -1
}

/** `"mi clave"` y `mi-clave` se comparan igual que en TOML. */
function normalizeKey(raw) {
	return String(raw)
		.split('.')
		.map((part) => {
			const t = part.trim()
			if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
				return t.slice(1, -1)
			}
			return t
		})
		.join('.')
}

// ─────────────────────────────────────────────────────────── documento editable

/**
 * El documento se parte en bloques: uno raiz (sin cabecera) y uno por tabla.
 * Cada bloque guarda sus lineas fisicas, asi que reconstruirlo devuelve el
 * archivo intacto salvo lo que hayamos tocado a proposito.
 */
class TomlDoc {
	constructor(text = '') {
		this.blocks = []
		const info = scanLines(text)
		let current = { header: null, headerRaw: null, arrayTable: false, arrayScope: null, lines: [] }
		let nextArrayScope = 1
		const activeArrays = new Map()
		this.blocks.push(current)

		for (const line of info) {
			if (line.header !== null && !line.continuation) {
				if (line.arrayTable) {
					// Una nueva instancia invalida el contexto de sus descendientes.
					for (const name of activeArrays.keys()) {
						if (name === line.header || name.startsWith(line.header + '.')) activeArrays.delete(name)
					}
					activeArrays.set(line.header, nextArrayScope++)
				}
				const parent = [...activeArrays]
					.filter(([name]) => line.header === name || line.header.startsWith(name + '.'))
					.sort((a, b) => b[0].length - a[0].length)[0]
				current = {
					header: line.header,
					headerRaw: line.raw,
					arrayTable: line.arrayTable,
					arrayScope: parent ? parent[1] : null,
					lines: [],
				}
				this.blocks.push(current)
				continue
			}
			current.lines.push(line)
		}
	}

	// ── lectura

	/** Todos los bloques con esa cabecera (mas de uno = duplicado). */
	blocksOf(header) {
		return this.blocks.filter((b) => b.header === header)
	}

	/** Entradas de un bloque: clave -> [{from, to}] en indices de b.lines. */
	entries(block) {
		const map = new Map()
		for (let i = 0; i < block.lines.length; i++) {
			const line = block.lines[i]
			if (line.continuation || line.key === null) continue
			// El valor puede seguir en las lineas siguientes.
			let to = i
			while (to + 1 < block.lines.length && block.lines[to + 1].continuation) to++
			if (!map.has(line.key)) map.set(line.key, [])
			map.get(line.key).push({ from: i, to })
		}
		return map
	}

	/** El valor tal cual esta escrito, o null. */
	get(header, key) {
		const block = this.blocksOf(header)[0]
		if (!block) return null
		const hit = this.entries(block).get(key)
		if (!hit) return null
		const text = block.lines
			.slice(hit[0].from, hit[0].to + 1)
			.map((l) => l.raw)
			.join('\n')
		const eq = findEquals(text.split('\n')[0], 0)
		return eq === -1 ? null : text.slice(eq + 1).trim()
	}

	/** Nombres de tabla presentes. */
	tables() {
		return this.blocks.filter((b) => b.header !== null).map((b) => b.header)
	}

	// ── escritura

	ensureTable(header) {
		const found = this.blocksOf(header).filter((b) => !b.arrayTable)
		if (found.length) return found[0]
		const block = { header, headerRaw: `[${header}]`, arrayTable: false, arrayScope: null, lines: [] }
		this.blocks.push(block)
		return block
	}

	/**
	 * Pone `key = value` en su sitio: reemplaza si ya existe (incluidas las
	 * copias duplicadas, que se eliminan), y si no, la anade al final del bloque.
	 */
	set(header, key, value, comment = null) {
		const target = header === null ? this.blocks[0] : this.ensureTable(header)
		const line = { raw: `${key} = ${value}`, continuation: false, header: null, key, keyRaw: key, blank: false, comment: false }
		const commentLine = comment
			? { raw: `# ${comment}`, continuation: false, header: null, key: null, keyRaw: null, blank: false, comment: true }
			: null

		// Puede haber copias repartidas en bloques duplicados de la misma tabla.
		let placed = false
		const candidates =
			header === null
				? [this.blocks[0]]
				: this.blocksOf(header).filter((b) => !b.arrayTable && b.arrayScope === target.arrayScope)
		for (const block of candidates) {
			const hits = this.entries(block).get(key)
			if (!hits) continue
			// De atras hacia delante, para no mover los indices.
			for (let i = hits.length - 1; i >= 0; i--) {
				const h = hits[i]
				if (!placed && block === target && i === 0) {
					const replacement = commentLine ? [commentLine, line] : [line]
					block.lines.splice(h.from, h.to - h.from + 1, ...replacement)
					placed = true
				} else {
					block.lines.splice(h.from, h.to - h.from + 1)
				}
			}
		}
		if (placed) return

		// No existia: al final del bloque, antes de las lineas en blanco finales.
		let at = target.lines.length
		while (at > 0 && target.lines[at - 1].blank) at--
		target.lines.splice(at, 0, ...(commentLine ? [commentLine, line] : [line]))
	}

	/** Quita la clave de todas las copias del bloque. */
	remove(header, key) {
		for (const block of header === null ? [this.blocks[0]] : this.blocksOf(header)) {
			const hits = this.entries(block).get(key)
			if (!hits) continue
			for (let i = hits.length - 1; i >= 0; i--) {
				block.lines.splice(hits[i].from, hits[i].to - hits[i].from + 1)
			}
		}
	}

	removeTable(header) {
		this.blocks = this.blocks.filter((b) => b.header !== header)
	}

	/** Borra lineas de comentario que cumplan el patron (marcadores viejos). */
	stripComments(pattern) {
		for (const block of this.blocks) {
			block.lines = block.lines.filter((l) => !(l.comment && pattern.test(l.raw)))
		}
	}

	// ── diagnostico

	/**
	 * Que esta mal en el archivo TAL COMO ESTA. Esto es lo que faltaba: saber
	 * como esta el config antes de tocarlo.
	 */
	problems() {
		const out = { duplicateTables: [], duplicateKeys: [] }

		const groups = new Map()
		for (const b of this.blocks) {
			if (b.header === null || b.arrayTable) continue
			const id = `${b.arrayScope === null ? 'root' : b.arrayScope}:${b.header}`
			if (!groups.has(id)) groups.set(id, [])
			groups.get(id).push(b)
		}
		for (const blocks of groups.values()) {
			if (blocks.length > 1) out.duplicateTables.push({ table: blocks[0].header, count: blocks.length })
		}

		// Cada elemento de un array de tablas tiene su propio espacio de claves.
		const keyGroups = [[this.blocks[0]]]
		for (const blocks of groups.values()) keyGroups.push(blocks)
		for (const block of this.blocks) if (block.arrayTable) keyGroups.push([block])
		for (const blocks of keyGroups) {
			const counts = new Map()
			for (const block of blocks) {
				for (const [key, hits] of this.entries(block)) {
					counts.set(key, (counts.get(key) || 0) + hits.length)
				}
			}
			for (const [key, n] of counts) {
				if (n > 1) out.duplicateKeys.push({ table: blocks[0].header, key, count: n })
			}
		}
		return out
	}

	/**
	 * Deja el archivo valido: funde tablas repetidas en la primera y deja una
	 * sola copia de cada clave (la ultima escrita, que es la mas reciente).
	 */
	repair() {
		const fixed = { tables: [], keys: [] }

		// 1. Fundir solo tablas normales del mismo contexto. Las declaraciones
		// [[...]] repetidas son elementos distintos, no tablas duplicadas.
		const byHeader = new Map()
		const kept = []
		for (const block of this.blocks) {
			if (block.header === null || block.arrayTable) {
				kept.push(block)
				continue
			}
			const id = `${block.arrayScope === null ? 'root' : block.arrayScope}:${block.header}`
			const first = byHeader.get(id)
			if (!first) {
				byHeader.set(id, block)
				kept.push(block)
				continue
			}
			// Se conserva el rango exacto para no reintroducir blancos que formen
			// parte de valores multilinea ni perder lineas repetidas.
			const body = trimLineEdges(block.lines)
			if (body.length) first.lines.push(...body)
			fixed.tables.push(block.header)
		}
		this.blocks = kept

		// 2. Una sola copia de cada clave: gana la ultima.
		for (const block of this.blocks) {
			const hitsByKey = this.entries(block)
			const drops = []
			for (const [key, hits] of hitsByKey) {
				if (hits.length < 2) continue
				fixed.keys.push({ table: block.header, key, removed: hits.length - 1 })
				for (const h of hits.slice(0, -1)) drops.push(h)
			}
			drops.sort((a, b) => b.from - a.from)
			for (const d of drops) block.lines.splice(d.from, d.to - d.from + 1)
		}
		return fixed
	}

	// ── salida

	toString() {
		const parts = []
		for (const block of this.blocks) {
			const body = block.lines.map((l) => l.raw)
			// Sin cabecera y sin contenido: nada que escribir.
			if (block.header === null) {
				if (body.some((l) => l.trim() !== '')) parts.push(trimEdges(body).join('\n'))
				continue
			}
			parts.push([block.headerRaw, ...trimEdges(body)].join('\n'))
		}
		const text = parts.filter((p) => p !== '').join('\n\n')
		return text ? text + '\n' : ''
	}
}

function trimEdges(lines) {
	let a = 0
	let b = lines.length
	while (a < b && lines[a].trim() === '') a++
	while (b > a && lines[b - 1].trim() === '') b--
	return lines.slice(a, b)
}

function trimLineEdges(lines) {
	let a = 0
	let b = lines.length
	while (a < b && lines[a].blank && !lines[a].continuation) a++
	while (b > a && lines[b - 1].blank && !lines[b - 1].continuation) b--
	return lines.slice(a, b)
}

// ───────────────────────────────────────────────────── validacion sintactica

class SyntaxErrorAt extends Error {
	constructor(message, at) {
		super(message)
		this.at = at
	}
}

/** Analizador pequeno de la gramatica necesaria para rechazar TOML roto. */
class TomlSyntax {
	constructor(text) {
		this.text = String(text)
		this.at = 0
		this.errors = []
	}

	validate() {
		if (this.text.charCodeAt(0) === 0xfeff) this.at++
		while (this.at < this.text.length) {
			this.horizontal()
			if (this.comment() || this.newline()) continue
			const start = this.at
			try {
				if (this.text[this.at] === '[') this.header()
				else this.assignment()
			} catch (error) {
				if (!(error instanceof SyntaxErrorAt)) throw error
				this.errors.push(`linea ${this.lineOf(error.at)}: ${error.message}`)
				if (this.at >= this.text.length) break
				this.at = Math.max(this.at, start)
				while (this.at < this.text.length && !this.isNewline(this.text[this.at])) this.at++
				this.newline()
			}
		}
		return this.errors
	}

	lineOf(at) {
		let line = 1
		for (let i = 0; i < at; i++) if (this.text[i] === '\n') line++
		return line
	}

	fail(message, at = this.at) {
		throw new SyntaxErrorAt(message, at)
	}

	isNewline(ch) {
		return ch === '\n' || ch === '\r'
	}

	newline() {
		if (!this.isNewline(this.text[this.at])) return false
		if (this.text[this.at] === '\r' && this.text[this.at + 1] === '\n') this.at++
		this.at++
		return true
	}

	horizontal() {
		while (this.text[this.at] === ' ' || this.text[this.at] === '\t') this.at++
	}

	comment() {
		if (this.text[this.at] !== '#') return false
		while (this.at < this.text.length && !this.isNewline(this.text[this.at])) this.at++
		this.newline()
		return true
	}

	nestedSpace() {
		let moved
		do {
			moved = false
			while (/\s/.test(this.text[this.at] || '')) {
				this.at++
				moved = true
			}
			if (this.comment()) moved = true
		} while (moved)
	}

	header() {
		const array = this.text.startsWith('[[', this.at)
		this.at += array ? 2 : 1
		this.key()
		this.horizontal()
		const close = array ? ']]' : ']'
		if (!this.text.startsWith(close, this.at)) this.fail(`cabecera sin cerrar; falta ${close}`)
		this.at += close.length
		this.endStatement('contenido inesperado tras la cabecera')
	}

	assignment() {
		this.key()
		this.horizontal()
		if (this.text[this.at] !== '=') this.fail("se esperaba '=' despues de la clave")
		this.at++
		this.horizontal()
		if (this.at >= this.text.length || this.isNewline(this.text[this.at]) || this.text[this.at] === '#') {
			this.fail('falta el valor de la clave')
		}
		this.value()
		this.endStatement('contenido inesperado despues del valor')
	}

	endStatement(message) {
		this.horizontal()
		if (this.comment() || this.at >= this.text.length || this.newline()) return
		this.fail(message)
	}

	key() {
		this.horizontal()
		let parts = 0
		while (true) {
			const ch = this.text[this.at]
			if (ch === '"' || ch === "'") {
				if (this.text.startsWith(ch.repeat(3), this.at)) this.fail('una clave no puede ser multilinea')
				this.string(ch, false)
			} else {
				const start = this.at
				while (/[A-Za-z0-9_-]/.test(this.text[this.at] || '')) this.at++
				if (this.at === start) this.fail(parts ? 'falta una parte de la clave' : 'clave invalida')
			}
			parts++
			this.horizontal()
			if (this.text[this.at] !== '.') break
			this.at++
			this.horizontal()
		}
	}

	value() {
		const ch = this.text[this.at]
		if (ch === '"' || ch === "'") {
			this.string(ch, this.text.startsWith(ch.repeat(3), this.at))
			return
		}
		if (ch === '[') {
			this.array()
			return
		}
		if (ch === '{') {
			this.inlineTable()
			return
		}
		this.bare()
	}

	string(quote, multiline) {
		const opened = this.at
		this.at += multiline ? 3 : 1
		while (this.at < this.text.length) {
			if (multiline && this.text.startsWith(quote.repeat(3), this.at)) {
				let count = 3
				while (this.text[this.at + count] === quote) count++
				this.at += Math.min(count, 5)
				return
			}
			const ch = this.text[this.at]
			if (!multiline && ch === quote) {
				this.at++
				return
			}
			if (!multiline && this.isNewline(ch)) this.fail('cadena sin cerrar', opened)
			if (ch.charCodeAt(0) < 0x20 && ch !== '\t' && !(multiline && this.isNewline(ch))) {
				this.fail('caracter de control invalido en una cadena')
			}
			if (quote === '"' && ch === '\\') {
				this.escape(multiline)
				continue
			}
			this.at++
		}
		this.fail(multiline ? 'cadena multilinea sin cerrar' : 'cadena sin cerrar', opened)
	}

	escape(multiline) {
		const slash = this.at++
		if (multiline && this.newline()) {
			while (/\s/.test(this.text[this.at] || '')) this.at++
			return
		}
		const ch = this.text[this.at]
		if ('btnfr"\\'.includes(ch)) {
			this.at++
			return
		}
		if (ch === 'u' || ch === 'U') {
			const digits = ch === 'u' ? 4 : 8
			const hex = this.text.slice(this.at + 1, this.at + 1 + digits)
			if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(hex)) this.fail('escape Unicode invalido', slash)
			this.at += digits + 1
			return
		}
		this.fail('escape invalido en una cadena', slash)
	}

	array() {
		const opened = this.at++
		this.nestedSpace()
		if (this.text[this.at] === ']') {
			this.at++
			return
		}
		while (this.at < this.text.length) {
			this.value()
			this.nestedSpace()
			if (this.text[this.at] === ']') {
				this.at++
				return
			}
			if (this.at >= this.text.length) break
			if (this.text[this.at] !== ',') this.fail("se esperaba ',' o ']' en el array")
			this.at++
			this.nestedSpace()
			if (this.text[this.at] === ']') {
				this.at++
				return
			}
		}
		this.fail('array sin cerrar', opened)
	}

	inlineTable() {
		const opened = this.at++
		this.nestedSpace()
		if (this.text[this.at] === '}') {
			this.at++
			return
		}
		while (this.at < this.text.length) {
			this.key()
			this.horizontal()
			if (this.text[this.at] !== '=') this.fail("se esperaba '=' en la tabla inline")
			this.at++
			this.horizontal()
			if (this.at >= this.text.length) break
			this.value()
			this.nestedSpace()
			if (this.text[this.at] === '}') {
				this.at++
				return
			}
			if (this.at >= this.text.length) break
			if (this.text[this.at] !== ',') this.fail("se esperaba ',' o '}' en la tabla inline")
			this.at++
			this.nestedSpace()
			if (this.text[this.at] === '}') {
				this.at++
				return
			}
		}
		this.fail('tabla inline sin cerrar', opened)
	}

	bare() {
		const start = this.at
		while (this.at < this.text.length && !',]}#\r\n'.includes(this.text[this.at])) this.at++
		const raw = this.text.slice(start, this.at).trim()
		if (!raw) this.fail('falta un valor', start)
		if (!isBareValue(raw)) this.fail(`valor bare invalido: ${raw}`, start)
	}
}

function isBareValue(raw) {
	if (raw === 'true' || raw === 'false' || /^[+-]?(inf|nan)$/.test(raw)) return true
	if (/^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/.test(raw)) return true
	if (/^0o[0-7](?:_?[0-7])*$/.test(raw)) return true
	if (/^0b[01](?:_?[01])*$/.test(raw)) return true
	const integer = '[+-]?(?:0|[1-9](?:_?[0-9])*)'
	const fraction = '\\.[0-9](?:_?[0-9])*'
	const exponent = '[eE][+-]?[0-9](?:_?[0-9])*'
	if (new RegExp(`^${integer}$`).test(raw)) return true
	if (new RegExp(`^${integer}(?:${fraction}(?:${exponent})?|${exponent})$`).test(raw)) return true
	const date = '[0-9]{4}-[0-9]{2}-[0-9]{2}'
	const time = '[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?'
	if (new RegExp(`^${date}$`).test(raw) || new RegExp(`^${time}$`).test(raw)) return true
	return new RegExp(`^${date}[Tt ]${time}(?:[Zz]|[+-][0-9]{2}:[0-9]{2})?$`).test(raw)
}

/**
 * Comprobacion final antes de escribir: si esto encuentra algo, es que
 * generamos un archivo que Codex rechazaria. Preferimos fallar aqui.
 */
function validate(text) {
	const doc = new TomlDoc(text)
	const p = doc.problems()
	const errors = new TomlSyntax(text).validate()
	for (const t of p.duplicateTables) errors.push(`la tabla [${t.table}] aparece ${t.count} veces`)
	for (const k of p.duplicateKeys) {
		errors.push(`la clave ${k.key} aparece ${k.count} veces en ${k.table ? '[' + k.table + ']' : 'la raiz'}`)
	}
	return errors
}

module.exports = { TomlDoc, validate, scanLines, normalizeKey }
