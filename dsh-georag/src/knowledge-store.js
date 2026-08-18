import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const NODE_KINDS = new Set(['讲解点', '地点', '概念', '物种', '气象', '每日', '主线'])
const SOURCE_KINDS = new Set(['text', 'document', 'image', 'audio', 'gis'])
const MAX_SOURCE_TEXT = 2_000_000
const MAX_NODE_CONTENT = 20_000

const now = () => new Date().toISOString()
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const normalizeText = value => String(value ?? '').replace(/\r\n?/g, '\n').trim()

function safeExtension(name) {
  const ext = path.extname(String(name || '')).toLowerCase().replace(/[^.a-z0-9]/g, '')
  return ext && ext.length <= 12 ? ext : '.bin'
}

function sourceView(source) {
  if (!source) return null
  const { storedPath: _storedPath, textPath: _textPath, structuredPath: _structuredPath, ...safe } = source
  return safe
}

function validateCoordinate(value) {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length !== 2) throw new Error('coordinate 必须是 [经度, 纬度]')
  const lon = Number(value[0]), lat = Number(value[1])
  if (!Number.isFinite(lon) || lon < -180 || lon > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error('coordinate 超出合法经纬度范围')
  }
  return [lon, lat]
}

function normalizeNode(raw, sourceIds, position) {
  const title = normalizeText(raw?.title)
  const kind = normalizeText(raw?.kind)
  const content = normalizeText(raw?.content)
  if (title.length < 2 || title.length > 120) throw new Error(`第 ${position + 1} 个节点的 title 长度应为 2—120 字`)
  if (!NODE_KINDS.has(kind)) throw new Error(`第 ${position + 1} 个节点的 kind 不合法`)
  if (content.length < 20 || content.length > MAX_NODE_CONTENT) {
    throw new Error(`第 ${position + 1} 个节点的 content 长度应为 20—${MAX_NODE_CONTENT} 字`)
  }
  const relations = [...new Set((raw.relations || []).map(normalizeText).filter(Boolean))].slice(0, 80)
  const coordinate = validateCoordinate(raw.coordinate)
  const altitude = raw.altitude == null || raw.altitude === '' ? undefined : Number(raw.altitude)
  if (altitude !== undefined && !Number.isFinite(altitude)) throw new Error(`第 ${position + 1} 个节点的 altitude 必须是数字`)
  const stableKey = `${title}\n${kind}`
  const id = `learned-${sha256(stableKey).slice(0, 16)}`
  const sourceLines = sourceIds.map(sourceId => `- 来源编号：${sourceId}`).join('\n')
  const relationLines = relations.length ? `\n\n## 关联\n${relations.map(x => `[[${x}]]`).join(' · ')}` : ''
  const provenance = `\n\n## 来源\n${sourceLines}`
  return {
    id,
    k: kind,
    t: title,
    out: relations,
    content,
    relations,
    md: `# ${title}\n\n## 资料整理\n${content}${relationLines}${provenance}`,
    c: coordinate,
    date: raw.date ? normalizeText(raw.date) : undefined,
    time: raw.time ? normalizeText(raw.time) : undefined,
    alt: altitude,
    sources: sourceIds,
  }
}

/**
 * 事件日志是知识增量的唯一事实源。基础 graph_data.json 始终只读；发布动作
 * 通过重放日志得到增量节点，因此基础数据重新生成时不会覆盖人工审核成果。
 */
export class KnowledgeStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'knowledge')
    this.eventsFile = path.join(this.root, 'events.jsonl')
    this.sourcesDir = path.join(this.root, 'sources')
    this.extractedDir = path.join(this.root, 'extracted')
    this.structuredDir = path.join(this.root, 'structured')
    fs.mkdirSync(this.sourcesDir, { recursive: true })
    fs.mkdirSync(this.extractedDir, { recursive: true })
    fs.mkdirSync(this.structuredDir, { recursive: true })
    if (!fs.existsSync(this.eventsFile)) fs.writeFileSync(this.eventsFile, '', { flag: 'wx' })
    this.replay()
  }

  replay() {
    this.sources = new Map()
    this.drafts = new Map()
    this.published = new Map()
    this.publishedTitle = new Map()
    this.events = []
    const lines = fs.readFileSync(this.eventsFile, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const event = JSON.parse(line)
        this.applyEvent(event)
        this.events.push(event)
      } catch (error) {
        if (!lines.slice(i + 1).some(candidate => candidate.trim())) break
        throw new Error(`知识事件日志第 ${i + 1} 行损坏：${error.message}`)
      }
    }
  }

  append(type, payload) {
    const event = { eventId: crypto.randomUUID(), type, at: now(), ...payload }
    const line = `${JSON.stringify(event)}\n`
    const fd = fs.openSync(this.eventsFile, 'a')
    try {
      fs.writeSync(fd, line, null, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    this.applyEvent(event)
    this.events.push(event)
    return event
  }

  applyEvent(event) {
    if (event.type === 'source.imported') {
      this.sources.set(event.source.id, event.source)
      return
    }
    if (event.type === 'source.reprocessed') {
      const source = this.sources.get(event.sourceId)
      if (source) Object.assign(source, event.patch)
      return
    }
    if (event.type === 'draft.created') {
      this.drafts.set(event.draft.id, event.draft)
      return
    }
    if (event.type === 'draft.rejected') {
      const draft = this.drafts.get(event.draftId)
      if (draft) Object.assign(draft, { status: 'rejected', updatedAt: event.at, rejectionReason: event.reason })
      return
    }
    if (event.type === 'draft.published') {
      const draft = this.drafts.get(event.draftId)
      if (draft) Object.assign(draft, { status: 'published', updatedAt: event.at, publishedAt: event.at })
      for (const node of event.nodes || []) {
        const previousId = this.publishedTitle.get(node.t)
        if (previousId && previousId !== node.id) this.published.delete(previousId)
        this.published.set(node.id, node)
        this.publishedTitle.set(node.t, node.id)
      }
    }
  }

  importSource({ name, buffer, text = '', mediaType = 'application/octet-stream', kind = 'document', metadata = {}, structured }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('资料内容为空')
    if (!SOURCE_KINDS.has(kind)) throw new Error(`不支持的资料类型：${kind}`)
    const extracted = normalizeText(text)
    if (extracted.length > MAX_SOURCE_TEXT) throw new Error(`提取文本超过 ${MAX_SOURCE_TEXT} 字限制`)
    const hash = sha256(buffer)
    const id = `src-${hash.slice(0, 16)}`
    const existing = this.sources.get(id)
    if (existing) {
      if (existing.metadata?.extractionError && !metadata?.extractionError) {
        const generation = crypto.randomUUID().slice(0, 8)
        const textPath = path.join(this.extractedDir, `${hash}-${generation}.txt`)
        const structuredPath = structured == null ? undefined : path.join(this.structuredDir, `${hash}-${generation}.json`)
        fs.writeFileSync(textPath, extracted, { flag: 'wx' })
        if (structuredPath) fs.writeFileSync(structuredPath, JSON.stringify(structured, null, 2), { flag: 'wx' })
        const patch = {
          textChars: extracted.length,
          textPath: path.relative(this.root, textPath),
          structuredPath: structuredPath ? path.relative(this.root, structuredPath) : undefined,
          metadata,
          reprocessedAt: now(),
        }
        this.append('source.reprocessed', { sourceId: id, patch })
        return { source: sourceView(this.sources.get(id)), duplicate: false, reprocessed: true }
      }
      return { source: sourceView(existing), duplicate: true, reprocessed: false }
    }

    const storedPath = path.join(this.sourcesDir, `${hash}${safeExtension(name)}`)
    const textPath = path.join(this.extractedDir, `${hash}.txt`)
    const structuredPath = structured == null ? undefined : path.join(this.structuredDir, `${hash}.json`)
    if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, buffer, { flag: 'wx' })
    if (!fs.existsSync(textPath)) fs.writeFileSync(textPath, extracted, { flag: 'wx' })
    if (structuredPath && !fs.existsSync(structuredPath)) {
      fs.writeFileSync(structuredPath, JSON.stringify(structured, null, 2), { flag: 'wx' })
    }

    const source = {
      id,
      hash,
      name: normalizeText(name) || `${id}.bin`,
      mediaType: normalizeText(mediaType) || 'application/octet-stream',
      kind,
      size: buffer.length,
      textChars: extracted.length,
      storedPath: path.relative(this.root, storedPath),
      textPath: path.relative(this.root, textPath),
      structuredPath: structuredPath ? path.relative(this.root, structuredPath) : undefined,
      metadata,
      createdAt: now(),
    }
    this.append('source.imported', { source })
    return { source: sourceView(source), duplicate: false, reprocessed: false }
  }

  importText({ name = '对话资料.txt', text, metadata = {} }) {
    const normalized = normalizeText(text)
    return this.importSource({
      name,
      buffer: Buffer.from(normalized, 'utf8'),
      text: normalized,
      mediaType: 'text/plain; charset=utf-8',
      kind: 'text',
      metadata,
    })
  }

  listSources() {
    const usedBy = new Map()
    for (const draft of this.drafts.values()) {
      for (const sourceId of draft.sourceIds) {
        const row = usedBy.get(sourceId) || []
        row.push({ draftId: draft.id, status: draft.status })
        usedBy.set(sourceId, row)
      }
    }
    return [...this.sources.values()].reverse().map(source => ({
      ...sourceView(source),
      usedBy: usedBy.get(source.id) || [],
    }))
  }

  readSource(id, offset = 0, limit = 12_000) {
    const source = this.sources.get(id)
    if (!source) throw new Error(`没有编号为「${id}」的资料`)
    const full = fs.readFileSync(path.join(this.root, source.textPath), 'utf8')
    const start = Math.max(0, Math.min(Number(offset) || 0, full.length))
    const size = Math.max(200, Math.min(Number(limit) || 12_000, 30_000))
    let structuredPreview
    if (source.structuredPath) {
      const structured = JSON.parse(fs.readFileSync(path.join(this.root, source.structuredPath), 'utf8'))
      structuredPreview = JSON.stringify(structured).slice(0, 8_000)
    }
    return {
      source: sourceView(source),
      text: full.slice(start, start + size),
      offset: start,
      nextOffset: start + size < full.length ? start + size : undefined,
      totalChars: full.length,
      structuredPreview,
    }
  }

  createDraft({ title, summary = '', sourceIds, nodes }) {
    const ids = [...new Set((sourceIds || []).map(normalizeText).filter(Boolean))]
    if (!ids.length) throw new Error('草稿至少需要一个 sourceId')
    for (const id of ids) if (!this.sources.has(id)) throw new Error(`没有编号为「${id}」的资料`)
    if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 100) throw new Error('nodes 数量应为 1—100')
    const normalizedNodes = nodes.map((node, index) => normalizeNode(node, ids, index))
    const seen = new Set()
    for (const node of normalizedNodes) {
      if (seen.has(node.t)) throw new Error(`草稿内存在重复标题「${node.t}」`)
      seen.add(node.t)
    }
    const createdAt = now()
    const draft = {
      id: `draft-${crypto.randomUUID().slice(0, 8)}`,
      title: normalizeText(title) || `知识草稿 ${createdAt.slice(0, 10)}`,
      summary: normalizeText(summary),
      sourceIds: ids,
      nodes: normalizedNodes,
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
    }
    this.append('draft.created', { draft })
    return this.draftView(draft)
  }

  draftView(draft) {
    if (!draft) return null
    return {
      ...draft,
      sources: draft.sourceIds.map(id => sourceView(this.sources.get(id))).filter(Boolean),
      confirmation: draft.status === 'pending' ? `确认发布 ${draft.id}` : undefined,
    }
  }

  listDrafts(status) {
    return [...this.drafts.values()].reverse()
      .filter(draft => !status || draft.status === status)
      .map(draft => this.draftView(draft))
  }

  getDraft(id) {
    const draft = this.drafts.get(id)
    if (!draft) throw new Error(`没有编号为「${id}」的草稿`)
    return this.draftView(draft)
  }

  rejectDraft(id, reason = '') {
    const draft = this.drafts.get(id)
    if (!draft) throw new Error(`没有编号为「${id}」的草稿`)
    if (draft.status !== 'pending') throw new Error(`草稿状态为 ${draft.status}，不能驳回`)
    this.append('draft.rejected', { draftId: id, reason: normalizeText(reason) })
    return this.getDraft(id)
  }

  publishDraft(id, confirmation) {
    const draft = this.drafts.get(id)
    if (!draft) throw new Error(`没有编号为「${id}」的草稿`)
    if (draft.status !== 'pending') throw new Error(`草稿状态为 ${draft.status}，不能发布`)
    if (normalizeText(confirmation) !== `确认发布 ${id}`) throw new Error(`需要用户明确发送“确认发布 ${id}”`)
    const revision = this.events.filter(e => e.type === 'draft.published').length + 1
    const publishedAt = now()
    const nodes = draft.nodes.map(node => ({
      ...node,
      revision,
      draftId: id,
      publishedAt,
    }))
    this.append('draft.published', { draftId: id, revision, nodes })
    return { draft: this.getDraft(id), revision, nodes }
  }

  publishedNodes() {
    return [...this.published.values()]
  }

  stats() {
    const drafts = [...this.drafts.values()]
    return {
      sources: this.sources.size,
      pendingDrafts: drafts.filter(x => x.status === 'pending').length,
      publishedDrafts: drafts.filter(x => x.status === 'published').length,
      rejectedDrafts: drafts.filter(x => x.status === 'rejected').length,
      publishedNodes: this.published.size,
      events: this.events.length,
    }
  }
}
