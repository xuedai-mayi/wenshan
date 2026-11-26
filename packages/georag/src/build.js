// 问山 · 上传即构建：资料 → 待审核草稿
//
// 设计要点：
// 1. **用用户自己配的模型**。抽取走宿主已经挂好的模型调用服务（ctx.llm），
//    凭据由宿主适配器解析（API Key 或账号令牌），插件不碰任何密钥，也不读
//    .env / settings.yaml。provider/model 取自 ctx.agentDefaultModel 的当前选择，
//    也就是「设置 > 模型」里那一路；宿主没挂这个服务时退回调用方显式传入的 target。
// 2. **一份资料一份草稿**。草稿的 sourceIds 就只有这份资料，引用永远可追溯；
//    跨资料的实体合并靠 knowledge-store 的 learned-<sha256(title+kind)> 确定性 id。
// 3. **对账先行**。基础图谱里已有同名同类节点时不新建（engine 的 titleToId 首见优先，
//    重名会让《标题》引用说不清），统一归到 supplement，交人工决定。
// 4. **失败不炸上传**。构建是后台任务：任何一步失败只记进 status()，上传接口照常返回。
import fs from 'node:fs'
import path from 'node:path'
// 用运行时自己的消息构造器：它补齐 id 并把 source 冻结成合法形状。
// 手搓 {role:'assistant'} 会缺 source，运行时读 source.kind 时直接 TypeError——
// 这个坑在真机上踩过一次，别改回去。
import { createUserMessage } from '../../../runtime/packages/llm/llm/lib/index.js'

// —— 与 packages/georag/src/knowledge-store.js 的 normalizeNode 保持一致 ——
const NODE_KINDS = new Set(['讲解点', '地点', '概念', '物种', '气象', '每日', '主线'])
const MIN_TITLE = 2
const MAX_TITLE = 120
const MIN_CONTENT = 20
const MAX_CONTENT = 20_000
const MAX_RELATIONS = 80
const MAX_NODES_PER_DRAFT = 100

const normalizeText = value => String(value ?? '').replace(/\r\n?/g, '\n').trim()

/** 日期与时间去掉内部空白：'7 月 11 日' → '7月11日'。格式不统一会让同一天变成两个节点。 */
const normalizeStamp = value => normalizeText(value).replace(/\s+/g, '')

/** 标题去重键：抹平全半角、空白与标点，避免「芦林湖」和「芦林湖 。」被当成两个节点。 */
export function titleKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s。．.？?！!，,、；;：:…~～"'“”‘’()（）[\]【】《》]+/g, '')
    .toLowerCase()
}

// ---------------- 分块 ----------------

/**
 * 按标题层级与空行切块，再打包到 maxChars 以内。保留原顺序，块与块不重叠——
 * 重叠分会重复计费，而跨块的实体合并本来就由 title 身份键兜住。
 * @param {string} text 资料正文
 * @param {{ maxChars?: number }} [options]
 * @returns {string[]}
 */
export function splitSource(text, options = {}) {
  const maxChars = Math.max(400, options.maxChars || 2_500)
  const body = normalizeText(text)
  if (!body) return []
  const pieces = body
    .split(/\n(?=#{1,4} )|\n{2,}/)
    .map(piece => piece.trim())
    .filter(Boolean)

  const chunks = []
  let buffer = ''
  const flush = () => {
    if (buffer.trim()) chunks.push(buffer.trim())
    buffer = ''
  }
  for (const piece of pieces) {
    if (piece.length > maxChars) {
      flush()
      // 超长段落硬切，尽量落在句号处
      let rest = piece
      while (rest.length > maxChars) {
        const window = rest.slice(0, maxChars)
        const cut = Math.max(window.lastIndexOf('。'), window.lastIndexOf('\n'), window.lastIndexOf('；'))
        const end = cut > maxChars * 0.5 ? cut + 1 : maxChars
        chunks.push(rest.slice(0, end).trim())
        rest = rest.slice(end)
      }
      if (rest.trim()) buffer = rest.trim()
      continue
    }
    if (buffer.length + piece.length + 2 > maxChars) flush()
    buffer = buffer ? `${buffer}\n\n${piece}` : piece
  }
  flush()
  return chunks
}

/**
 * 块太多时等距抽样，避免一份 200 万字的资料把抽取调用打到 800 次。
 * @param {string[]} chunks
 * @param {number} maxChunks
 * @returns {{ chunks: string[], dropped: number }}
 */
export function capChunks(chunks, maxChunks = 60) {
  if (chunks.length <= maxChunks) return { chunks, dropped: 0 }
  const step = chunks.length / maxChunks
  const picked = []
  for (let i = 0; i < maxChunks; i++) picked.push(chunks[Math.floor(i * step)])
  return { chunks: picked, dropped: chunks.length - maxChunks }
}

// ---------------- 抽取提示词 ----------------

export const EXTRACT_SYSTEM = `你是地理野外实习知识图谱的抽取器。输入是一段实习资料原文，你的唯一任务是从中抽取知识节点与关系。

只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码围栏。格式：
{"items":[{"kind":"讲解点|地点|概念|物种|气象|每日|主线","title":"...","content":"...","relations":["..."],"coordinate":[经度,纬度],"altitude":数字,"date":"...","time":"..."}],"edges":[{"from":"标题","to":"标题","type":"关系词"}]}

硬性规则：
1. 只抽取原文明确支持的内容。不得补充常识、不得推测、不得把"应该""可能"写成事实。
2. content 是有信息密度的事实正文，20—800 字，保留原文的数字、地名、坐标、海拔、时间。
3. title 用原文里的名词，2—120 字；同一实体只出现一次，不要造同义标题。气象节点的标题写成「日期+天气」（如"7月11日天气"），不要用"多云""晴"本身当标题。
4. kind 只能取七类之一：讲解点（现场被讲解的一处）、地点（山湖峰寺村等地理实体）、概念（定义/成因/机制/原理）、物种（动植物）、气象（实测气温气压湿度风）、每日（一天的行程观察总记）、主线（贯穿多日或全区的大主题）。
5. relations 与 edges 只引用这段原文里出现过的标题，或用原文里明确写出的名称；没有就留空数组。
6. 坐标必须是原文给出的经纬度，写成 [经度, 纬度]；原文没给就省略该字段，不要估算。
7. 一个名词如果只能给出一句定义、正文凑不够 30 字，就不要单独建节点，把它写进相关节点的 content 里（比如"剖面出露泥砾，含漂砾"）。
8. 只抽取地理实体、地理现象、地理过程与地理概念。不要把"记录方法、拍照存档、点位编号、粒度分析、采样方法"这类工作流程或分析手段建成概念节点；行程安排归入"每日"，不要另立节点。
9. 同一事物只用一个标题，不要因为原文换了说法就建第二个节点（例如"泥砾"与"冰碛物"选原文更常用的那个）。
10. 这段原文如果没有可抽取的知识点，输出 {"items":[],"edges":[]}。`

/** @param {string} chunk @param {string} sourceName */
export function buildExtractMessages(chunk, sourceName) {
  return [createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: `资料名称：${sourceName}\n\n原文片段：\n${chunk}` }],
  })]
}

// ---------------- 解析 ----------------

/** 从模型输出里挖出第一个完整的 JSON 对象（容忍围栏、前后废话、尾随逗号）。 */
export function parseExtraction(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  const start = text.indexOf('{')
  if (start < 0) return { items: [], edges: [], error: '输出里没有 JSON 对象' }
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const slice = text.slice(start, i + 1)
        for (const attempt of [slice, slice.replace(/,\s*([}\]])/g, '$1')]) {
          try {
            const parsed = JSON.parse(attempt)
            if (Array.isArray(parsed)) return { items: parsed, edges: [] }
            return { items: Array.isArray(parsed.items) ? parsed.items : [], edges: Array.isArray(parsed.edges) ? parsed.edges : [] }
          } catch { /* 换下一种修补 */ }
        }
        return { items: [], edges: [], error: 'JSON 解析失败' }
      }
    }
  }
  return { items: [], edges: [], error: 'JSON 不完整（可能被截断）' }
}

/**
 * 被 maxTokens 截断时的抢救：从后往前找 items 里最后一个完整对象，补上收尾括号再解析。
 * 抽到 7 条、第 8 条被截断时，前 7 条不该跟着丢掉。
 * @param {string} raw
 * @returns {{ items: object[], edges: object[] }|undefined}
 */
export function salvageTruncated(raw) {
  const text = String(raw ?? '')
  const start = text.indexOf('"items"')
  if (start < 0) return undefined
  let cut = text.lastIndexOf('},')
  while (cut > start) {
    const candidate = `${text.slice(0, cut + 1)}]}`
    try {
      const parsed = JSON.parse(candidate)
      if (Array.isArray(parsed.items) && parsed.items.length) return { items: parsed.items, edges: [] }
    } catch { /* 继续往前退 */ }
    cut = text.lastIndexOf('},', cut - 1)
  }
  return undefined
}

// ---------------- 校验与合并 ----------------

const number = (value) => {
  if (value == null || value === '') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const cleaned = String(value).replace(/[^\d.\-+eE]/g, '')
  if (!cleaned) return undefined
  const parsed = Number.parseFloat(cleaned)
  return Number.isFinite(parsed) ? parsed : undefined
}

const coordinate = (value) => {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const lon = Number(value[0])
  const lat = Number(value[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return undefined
  return [lon, lat]
}

/**
 * 单条候选 → 合法节点；不合法的直接丢掉并记原因（自动抽取不能因为一条脏数据炸掉整份草稿）。
 * @returns {{ node?: object, dropped?: string }}
 */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return { dropped: '不是对象' }
  const title = normalizeText(raw.title)
  const kind = normalizeText(raw.kind)
  const content = normalizeText(raw.content)
  if (title.length < MIN_TITLE || title.length > MAX_TITLE) return { dropped: `标题长度不合规：${title || '(空)'}` }
  if (!NODE_KINDS.has(kind)) return { dropped: `kind 不合规：${kind || '(空)'}（${title}）` }
  if (content.length < MIN_CONTENT || content.length > MAX_CONTENT) return { dropped: `正文长度不合规：${title}` }

  const relations = []
  const seen = new Set([titleKey(title)])
  for (const item of Array.isArray(raw.relations) ? raw.relations : []) {
    const relation = normalizeText(item)
    const key = titleKey(relation)
    if (!relation || seen.has(key)) continue
    seen.add(key)
    relations.push(relation)
  }

  const node = { title, kind, content, relations: relations.slice(0, MAX_RELATIONS) }
  const coord = coordinate(raw.coordinate)
  if (coord) node.coordinate = coord
  const altitude = number(raw.altitude)
  if (altitude !== undefined) node.altitude = altitude
  for (const field of ['date', 'time']) {
    const value = normalizeStamp(raw[field])
    if (value) node[field] = value
  }
  return { node }
}

const mergeNode = (a, b) => {
  const out = { ...a }
  if (b.content.length > a.content.length) out.content = b.content
  const seen = new Set(a.relations.map(titleKey))
  const relations = [...a.relations]
  for (const relation of b.relations) {
    const key = titleKey(relation)
    if (seen.has(key)) continue
    seen.add(key)
    relations.push(relation)
  }
  out.relations = relations.slice(0, MAX_RELATIONS)
  for (const field of ['coordinate', 'altitude', 'date', 'time']) {
    if (out[field] === undefined && b[field] !== undefined) out[field] = b[field]
  }
  return out
}

/**
 * 多块结果合并：同一 (title, kind) 只留一个节点，正文取长的、关系取并集、坐标取先有的。
 * @param {object[]} items 原始候选
 * @returns {{ nodes: object[], dropped: string[] }}
 */
export function normalizeItems(items) {
  const byKey = new Map()
  const order = []
  const dropped = []
  for (const raw of items || []) {
    const result = normalizeItem(raw)
    if (result.dropped) { dropped.push(result.dropped); continue }
    const node = result.node
    const key = `${titleKey(node.title)}\u0000${node.kind}`
    if (byKey.has(key)) byKey.set(key, mergeNode(byKey.get(key), node))
    else { byKey.set(key, node); order.push(key) }
  }
  return { nodes: order.map(key => byKey.get(key)), dropped }
}

/** 边 → 双向 relations（与 engine.js 的双链邻接一致）。 */
export function mergeEdges(nodes, edges) {
  const byTitle = new Map()
  for (const node of nodes) {
    const key = titleKey(node.title)
    if (!byTitle.has(key)) byTitle.set(key, [])
    byTitle.get(key).push(node)
  }
  for (const edge of edges || []) {
    const head = titleKey(edge?.from)
    const tail = titleKey(edge?.to)
    if (!head || !tail || head === tail) continue
    for (const node of byTitle.get(head) || []) {
      if (!node.relations.some(x => titleKey(x) === tail)) node.relations.push(normalizeText(edge.to))
    }
    for (const node of byTitle.get(tail) || []) {
      if (!node.relations.some(x => titleKey(x) === head)) node.relations.push(normalizeText(edge.from))
    }
  }
  for (const node of nodes) node.relations = node.relations.slice(0, MAX_RELATIONS)
  return nodes
}

/**
 * 与基础图谱 / 已发布节点对账。
 *
 * 三条规则，都来自真机踩坑：
 * - 同名同类 → supplement：这是对已有实体的补充描述，不新建。
 * - 同名不同类 → **冲突，也不新建**：`engine.js` 的 `titleToId` 按标题首见优先建索引，
 *   「芦林湖（地点）」和「芦林湖（讲解点）」并存时，《芦林湖》引用的到底是哪一个说不清。
 *   实测就撞到过：模型把已有的地点《芦林湖》又抽成了讲解点。
 * - 其余 → fresh，正常新建。
 * @param {object[]} nodes
 * @param {string[]} existingTitles 已知标题
 * @param {Map<string,string>|object} [kindByTitle] 已知 titleKey → kind
 */
export function reconcile(nodes, existingTitles = [], kindByTitle = new Map()) {
  const kinds = kindByTitle instanceof Map ? kindByTitle : new Map(Object.entries(kindByTitle))
  const known = new Set(existingTitles.map(titleKey))
  const fresh = []
  const supplement = []
  const conflicts = []
  for (const node of nodes) {
    const key = titleKey(node.title)
    if (!known.has(key)) { fresh.push(node); continue }
    const existingKind = kinds.get(key)
    if (existingKind === node.kind || existingKind === undefined) supplement.push(node)
    else conflicts.push({ title: node.title, existingKind, candidateKind: node.kind })
  }
  return { fresh, supplement, conflicts }
}

/**
 * 节点 → 草稿载荷（≤100 节点/份，批内标题唯一）。
 * @returns {object[]}
 */
export function draftPayloads(nodes, { sourceIds, label, existingTitles = [], kindByTitle = new Map(), stats = {} }) {
  const { fresh, supplement, conflicts } = reconcile(nodes, existingTitles, kindByTitle)

  // 只保留能解析到的关系：本批节点 ∪ 已有图谱 ∪ 归入 supplement 的节点。
  // 否则草稿里会留下指向不存在标题的悬空链接（实测《7月12日行程》指向了没建出来的《7月12日天气》）。
  const resolvable = new Set([...existingTitles, ...fresh.map(node => node.title), ...supplement.map(node => node.title)].map(titleKey))
  let pruned = 0
  for (const node of fresh) {
    const kept = node.relations.filter(relation => resolvable.has(titleKey(relation)))
    pruned += node.relations.length - kept.length
    node.relations = kept
  }
  const drafts = []
  let current = []
  const titles = new Set()
  const flush = () => {
    if (!current.length) return
    const suffix = drafts.length ? `（第 ${drafts.length + 1} 份）` : ''
    drafts.push({
      title: `${label}${suffix}`,
      summary: [
        `由「${label}」自动抽取生成，覆盖 ${current.length} 个节点；发布前需人工逐条核对。`,
        stats.dropped ? `另有 ${stats.dropped} 条太短或格式不合规被跳过。` : '',
        stats.failedChunks ? `有 ${stats.failedChunks} 块抽取失败，草稿可能不完整。` : '',
        supplement.length ? `${supplement.length} 个节点与已有图谱同名同类，未新建。` : '',
        pruned ? `${pruned} 条指向不存在标题的关系已丢弃。` : '',
        conflicts.length
          ? `${conflicts.length} 个节点与已有图谱同名但类型不同，未新建：`
            + conflicts.slice(0, 6).map(x => `${x.title}（已有${x.existingKind}，本次${x.candidateKind}）`).join('、')
            + (conflicts.length > 6 ? '…' : '')
          : '',
      ].filter(Boolean).join(''),
      sourceIds,
      nodes: current,
    })
    current = []
    titles.clear()
  }
  for (const node of fresh) {
    const key = titleKey(node.title)
    if (current.length >= MAX_NODES_PER_DRAFT || titles.has(key)) flush()
    current.push(node)
    titles.add(key)
  }
  flush()
  return { drafts, supplement, conflicts, prunedRelations: pruned }
}

// ---------------- 运行时 ----------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param {object} options
 * @param {string} options.dataDir 数据目录（同一份 data/，读 graph_data.json 做对账）
 * @param {import('./knowledge-store.js').KnowledgeStore} options.store
 * @param {() => object|undefined} options.resolveLlm 返回 ctx.llm（延迟解析，宿主可能后挂）
 * @param {() => {provider:string,model:string}|undefined} options.resolveTarget 返回用户当前选的模型
 * @param {(scope:string, level:string, message:string) => void} [options.log]
 * @param {object} [options.config]
 */
export function createBuilder({ dataDir, store, resolveLlm, resolveTarget, log = () => {}, config = {} }) {
  const settings = {
    maxChars: 2_500,
    maxChunks: 60,
    concurrency: 2,
    maxTokens: 8_000,
    // 抽取是机械活，关掉思考。实测：开思考时 8000 输出 token 全被 reasoning 吃掉
    // （completion_tokens_details.reasoning_tokens=8000，content 为空，finish_reason=length）；
    // 关掉后同一份资料 18 秒返回 34 个节点、finish_reason=stop。
    reasoningEffort: 'off',
    // 抽取要可复现：同一份资料两次跑出来的节点集合应当基本一致，别让它自由发挥
    temperature: 0.2,
    retryOnParseError: 1,
    ...config,
  }
  const state = {
    running: 0,
    queue: [],
    sources: {},
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  }
  const stateFile = path.join(dataDir, 'knowledge', 'build-state.json')
  const done = new Set()
  try {
    const previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    for (const id of previous.done || []) done.add(id)
  } catch { /* 首次运行没有状态文件 */ }

  const persist = () => {
    state.updatedAt = new Date().toISOString()
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify({ done: [...done], sources: state.sources }, null, 2))
    } catch (error) {
      log('georag', 'warn', `构建状态落盘失败：${error instanceof Error ? error.message : error}`)
    }
  }

  const knownTitles = () => {
    const titles = []
    const kindByTitle = new Map()
    try {
      const graph = JSON.parse(fs.readFileSync(path.join(dataDir, 'graph_data.json'), 'utf8'))
      for (const node of graph.nodes || []) {
        const title = node.t || node.id
        if (!title) continue
        titles.push(title)
        if (!kindByTitle.has(titleKey(title))) kindByTitle.set(titleKey(title), node.k)
      }
    } catch (error) {
      log('georag', 'warn', `读不到基础图谱，跳过对账：${error instanceof Error ? error.message : error}`)
    }
    for (const node of store.publishedNodes()) {
      titles.push(node.t)
      if (!kindByTitle.has(titleKey(node.t))) kindByTitle.set(titleKey(node.t), node.k)
    }
    return { titles, kindByTitle }
  }

  const readAll = (sourceId) => {
    const pages = []
    let offset = 0
    for (let guard = 0; guard < 200; guard++) {
      const page = store.readSource(sourceId, offset, 30_000)
      pages.push(page.text)
      if (page.nextOffset === undefined) break
      offset = page.nextOffset
    }
    return pages.join('')
  }

  /**
   * 一次模型调用：把流拼成文本，并区分「正常结束」「被 maxTokens 截断」「提供方报错」。
   * @returns {Promise<{ text: string, truncated: boolean }>}
   */
  const callModel = async (llm, target, messages) => {
    const parts = []
    let truncated = false
    let failure
    for await (const chunk of llm.stream({
      provider: target.provider,
      model: target.model,
      system: EXTRACT_SYSTEM,
      messages,
      maxTokens: settings.maxTokens,
      ...settings.temperature !== undefined ? { temperature: settings.temperature } : {},
      ...settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {},
    })) {
      if (chunk?.type === 'text-delta') parts.push(chunk.text)
      else if (chunk?.type === 'finish') {
        if (chunk.reason?.kind === 'max-tokens') truncated = true
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason
      }
    }
    if (failure) {
      const detail = failure.failure?.message || failure.failure?.code || '提供方返回错误'
      throw new Error(String(detail))
    }
    return { text: parts.join(''), truncated }
  }

  const callWithRetry = async (llm, target, messages) => {
    try {
      return await callModel(llm, target, messages)
    } catch (error) {
      // 提供方偶发抽风（空 chunk、SSE 截断）不该让整份资料前功尽弃
      log('georag', 'warn', `模型调用失败，重试一次：${error instanceof Error ? error.message : error}`)
      await sleep(500)
      return callModel(llm, target, messages)
    }
  }

  const extractChunk = async (llm, target, chunk, sourceName) => {
    let call = await callWithRetry(llm, target, buildExtractMessages(chunk, sourceName))
    let parsed = parseExtraction(call.text)
    if (call.truncated || parsed.error) {
      const salvaged = salvageTruncated(call.text)
      if (salvaged) {
        log('georag', 'warn', `输出不完整，已抢救出 ${salvaged.items.length} 条`)
        parsed = salvaged
      } else if (call.truncated) {
        parsed = { items: parsed.items, edges: parsed.edges, error: '输出被 maxTokens 截断' }
      }
    }
    for (let attempt = 0; attempt < settings.retryOnParseError && parsed.error; attempt++) {
      log('georag', 'warn', `抽取结果不可用（${parsed.error}），重试一次`)
      await sleep(300)
      call = await callWithRetry(llm, target, [
        ...buildExtractMessages(chunk, sourceName),
        createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: '上一条回复没有给出合法的完整 JSON。这次只输出那个 JSON 对象本身，宁可少抽几条，不要解释、不要围栏。' }],
        }),
      ])
      parsed = parseExtraction(call.text)
    }
    return parsed
  }

  /**
   * 构建一份或多份资料的草稿。返回每份资料的结果，不抛异常。
   * @param {string[]} sourceIds
   * @param {{ force?: boolean }} [options]
   */
  async function run(sourceIds, options = {}) {
    const llm = resolveLlm()
    const target = resolveTarget()
    const ids = [...new Set((sourceIds || []).map(String).filter(Boolean))]
    const summary = { sources: [], drafts: [], errors: [] }

    if (!llm || typeof llm.stream !== 'function') {
      return { ...summary, errors: ['模型调用服务未就绪（ctx.llm 不可用），无法自动构建'] }
    }
    if (!target?.provider || !target?.model) {
      return { ...summary, errors: ['没有可用的默认模型：请先在「设置 > 模型」选择模型'] }
    }

    for (const sourceId of ids) {
      if (done.has(sourceId) && !options.force) {
        summary.sources.push({ sourceId, state: 'skipped', reason: '已构建过' })
        continue
      }
      const record = { state: 'running', startedAt: new Date().toISOString(), chunks: 0, nodes: 0, drafts: [], error: undefined }
      state.sources[sourceId] = record
      state.running++
      state.queue = ids.slice(ids.indexOf(sourceId) + 1)
      persist()
      try {
        const source = store.listSources().find(item => item.id === sourceId)
        if (!source) throw new Error(`没有编号为「${sourceId}」的资料`)
        const text = readAll(sourceId)
        const all = splitSource(text, { maxChars: settings.maxChars })
        const capped = capChunks(all, settings.maxChunks)
        if (capped.dropped) log('georag', 'warn', `「${source.name}」块数超限，等距抽样 ${capped.chunks.length}/${all.length}`)
        if (!capped.chunks.length) throw new Error('资料没有可抽取的正文')
        record.chunks = capped.chunks.length

        const items = []
        const edges = []
        const failures = []
        let cursor = 0
        const worker = async () => {
          while (cursor < capped.chunks.length) {
            const index = cursor++
            try {
              const parsed = await extractChunk(llm, target, capped.chunks[index], source.name)
              if (parsed.error) throw new Error(parsed.error)
              items.push(...parsed.items)
              edges.push(...parsed.edges)
            } catch (error) {
              // 单块失败记下来继续跑：其余块的产出照样能成草稿，比整份作废有用
              const message = error instanceof Error ? error.message : String(error)
              failures.push({ chunk: index + 1, message })
              log('georag', 'warn', `「${source.name}」第 ${index + 1}/${capped.chunks.length} 块抽取失败：${message}`)
            }
          }
        }
        await Promise.all(Array.from({ length: Math.max(1, Math.min(settings.concurrency, capped.chunks.length)) }, worker))
        if (failures.length === capped.chunks.length) {
          throw new Error(`全部 ${capped.chunks.length} 块都抽取失败：${failures[0].message}`)
        }

        const { nodes, dropped } = normalizeItems(items)
        mergeEdges(nodes, edges)
        const { titles, kindByTitle } = knownTitles()
        const { drafts, supplement, conflicts, prunedRelations } = draftPayloads(nodes, {
          sourceIds: [sourceId],
          label: source.name.replace(/\.[^.]+$/, ''),
          existingTitles: titles,
          kindByTitle,
          stats: { dropped: dropped.length, failedChunks: failures.length },
        })
        for (const payload of drafts) {
          const draft = store.createDraft(payload)
          record.drafts.push({ id: draft.id, nodes: draft.nodes.length })
          summary.drafts.push({ sourceId, draftId: draft.id, nodes: draft.nodes.length })
        }
        record.nodes = nodes.length
        record.failedChunks = failures
        record.dropped = dropped.slice(0, 20)
        record.supplement = supplement.map(node => node.title)
        record.conflicts = conflicts
        record.prunedRelations = prunedRelations
        record.state = drafts.length ? 'drafted' : 'empty'
        record.finishedAt = new Date().toISOString()
        done.add(sourceId)
        log('georag', 'info', `自动构建完成：${source.name} → ${drafts.length} 份草稿 / ${nodes.length} 节点${supplement.length ? ` / ${supplement.length} 个同名待补充` : ''}`)
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error)
        const message = /no API key|api key|unauthor|401|403/i.test(raw)
          ? `${raw}｜去「设置 > 模型」给 ${target.provider} 填上 API Key 后重试（POST /wenshan/api/evolution/build {"sourceIds":["${sourceId}"]}）`
          : raw
        record.state = 'failed'
        record.error = error instanceof Error && error.stack
          ? `${message}\n${error.stack.split('\n').slice(1, 6).join('\n')}`
          : message
        record.finishedAt = new Date().toISOString()
        summary.errors.push(`${sourceId}：${message}`)
        log('georag', 'warn', `自动构建失败：${sourceId} — ${message}${error instanceof Error && error.stack ? `\n${error.stack.split('\n').slice(1, 6).join('\n')}` : ''}`)
      } finally {
        state.running = Math.max(0, state.running - 1)
        state.queue = state.queue.filter(id => id !== sourceId)
        persist()
      }
      summary.sources.push({ sourceId, state: record.state, drafts: record.drafts })
    }
    return summary
  }

  return {
    run,
    status: () => ({ ...state, done: [...done], model: resolveTarget() }),
    config: settings,
    settings: (patch) => Object.assign(settings, patch || {}),
  }
}
