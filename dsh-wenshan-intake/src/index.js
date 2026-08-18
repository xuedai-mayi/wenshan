import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const runFile = promisify(execFile)
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const defaultGraphPage = path.resolve(moduleDir, '../public/knowledge-graph.html')
const defaultEvolutionScript = path.resolve(moduleDir, '../public/evolution.js')
const defaultForceGraphScript = path.resolve(moduleDir, '../node_modules/force-graph/dist/force-graph.min.js')
const defaultWallpaper = path.resolve(moduleDir, '../public/wenshan-valley.webp')
const MAX_EXTRACTED_TEXT = 2_000_000
const PRODUCT_NAME = '问山：地理野外实习自成长智能助手'

export const name = 'wenshan-intake'
export const inject = ['webServer', 'lushanData']

const TYPES = {
  text: new Set(['.txt', '.md', '.markdown', '.csv', '.tsv']),
  document: new Set(['.pdf', '.docx']),
  image: new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tif', '.tiff']),
  audio: new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']),
  gis: new Set(['.geojson', '.json', '.gpx', '.zip']),
}

const TYPE_LABELS = { text: '文字', document: '文档', image: '图片', audio: '录音', gis: '空间数据' }

function detectKind(name) {
  const ext = path.extname(name).toLowerCase()
  for (const [kind, extensions] of Object.entries(TYPES)) if (extensions.has(ext)) return kind
  return null
}

function safeName(value) {
  return path.basename(String(value || '未命名资料.bin')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 180)
}

function safeRelativePath(value) {
  const parts = String(value || '').split(/[\\/]+/)
    .map(part => part.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim())
    .filter(Boolean)
    .slice(-12)
  return parts.join('/').slice(0, 480)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sendText(res, req, file, contentType) {
  return fs.promises.readFile(file).then(body => {
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  })
}

async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > maxBytes) throw new Error('文件超过 ' + Math.round(maxBytes / 1024 / 1024) + ' MB 限制')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('文件超过 ' + Math.round(maxBytes / 1024 / 1024) + ' MB 限制')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function geoJsonExtraction(buffer) {
  const parsed = JSON.parse(buffer.toString('utf8'))
  const features = parsed.type === 'FeatureCollection' ? parsed.features : parsed.type === 'Feature' ? [parsed] : []
  const rows = features.slice(0, 10_000).map((feature, index) => {
    const properties = feature.properties || {}
    const title = properties.name || properties.NAME || properties.Name || properties.名称 || '要素 ' + (index + 1)
    const geometry = feature.geometry || null
    let coordinate
    if (geometry && geometry.type === 'Point' && Array.isArray(geometry.coordinates)) coordinate = geometry.coordinates.slice(0, 2)
    return { title: String(title), geometryType: geometry ? geometry.type : 'Unknown', coordinate, properties }
  })
  const text = ['GIS 数据共 ' + features.length + ' 个要素。']
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    text.push((index + 1) + '. ' + row.title + '｜' + row.geometryType + (row.coordinate ? '｜坐标 ' + row.coordinate.join(', ') : '') + '｜属性 ' + JSON.stringify(row.properties))
  }
  return { text: text.join('\n'), structured: { format: 'GeoJSON', featureCount: features.length, features: rows }, metadata: { featureCount: features.length } }
}

function gpxExtraction(buffer) {
  const xml = buffer.toString('utf8')
  const points = []
  const re = /<(?:wpt|trkpt|rtept)\b[^>]*\blat=["']([^"']+)["'][^>]*\blon=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:wpt|trkpt|rtept)>/gi
  for (const match of xml.matchAll(re)) {
    const pointName = match[3].match(/<name>([\s\S]*?)<\/name>/i)
    const elevation = match[3].match(/<ele>([^<]+)<\/ele>/i)
    points.push({
      title: pointName ? pointName[1].replace(/<[^>]+>/g, '').trim() : '轨迹点 ' + (points.length + 1),
      coordinate: [Number(match[2]), Number(match[1])],
      elevation: elevation ? Number(elevation[1]) : undefined,
    })
    if (points.length >= 20_000) break
  }
  const text = ['GPX 共提取 ' + points.length + ' 个点。']
  for (let index = 0; index < points.length; index++) {
    const point = points[index]
    text.push((index + 1) + '. ' + point.title + '｜坐标 ' + point.coordinate.join(', ') + (Number.isFinite(point.elevation) ? '｜海拔 ' + point.elevation + ' m' : ''))
  }
  return { text: text.join('\n'), structured: { format: 'GPX', pointCount: points.length, points }, metadata: { pointCount: points.length } }
}

async function pythonExtraction(buffer, fileName, config) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wenshan-ingest-'))
  const inputPath = path.join(tempDir, safeName(fileName))
  try {
    fs.writeFileSync(inputPath, buffer)
    const result = await runFile(config.python, [...config.pythonArgs, config.extractorPath, inputPath], {
      encoding: 'utf8',
      timeout: config.extractTimeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1' },
    })
    return JSON.parse(result.stdout)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

async function extract(buffer, fileName, kind, config) {
  const ext = path.extname(fileName).toLowerCase()
  if (kind === 'text') return { text: buffer.toString('utf8'), metadata: {} }
  if (kind === 'gis' && (ext === '.json' || ext === '.geojson')) return geoJsonExtraction(buffer)
  if (kind === 'gis' && ext === '.gpx') return gpxExtraction(buffer)
  if (kind === 'image') {
    return {
      text: '图片资料「' + fileName + '」已保存。请在“知识演化”对话中附上这张图片，由视觉模型识读后再创建知识草稿。',
      metadata: { requiresVisionReview: true },
    }
  }
  return pythonExtraction(buffer, fileName, kind, config)
}

export function buildKnowledgeGraph(lushan) {
  const nodes = new Map()
  const links = new Map()
  const connect = (source, target, type) => {
    if (!source || !target || source === target) return
    const key = source < target ? source + '|' + target : target + '|' + source
    if (!links.has(key)) links.set(key, { source, target, type })
  }
  const baseNodes = Array.isArray(lushan.graph && lushan.graph.nodes) ? lushan.graph.nodes : []
  const titleToId = new Map()
  for (const node of baseNodes) {
    nodes.set(node.id, {
      id: node.id,
      title: node.t,
      kind: node.k,
      coordinate: node.c,
      source: 'published',
      hasContent: Boolean(node.md || node.content),
    })
    if (!titleToId.has(node.t)) titleToId.set(node.t, node.id)
  }
  for (const node of baseNodes) {
    for (const targetTitle of node.out || []) connect(node.id, titleToId.get(targetTitle), 'knowledge')
  }

  const collectionId = 'wenshan-source-collection'
  const sources = lushan.knowledge.listSources()
  nodes.set(collectionId, {
    id: collectionId,
    title: '本次资料夹',
    kind: '资料夹',
    source: 'collection',
    hasContent: true,
  })
  for (const source of sources) {
    const sourceId = source.id
    const relativePath = source.metadata && source.metadata.relativePath
    nodes.set(sourceId, {
      id: sourceId,
      title: source.name,
      subtitle: relativePath || TYPE_LABELS[source.kind] || source.kind,
      kind: '资料',
      source: 'source',
      fileKind: source.kind,
      size: source.size,
      textChars: source.textChars,
      hasContent: source.textChars > 0,
    })
    connect(collectionId, sourceId, 'source')
    let sourceText = source.name + '\n' + (relativePath || '')
    try {
      const extracted = lushan.knowledge.readSource(sourceId, 0, 30_000).text
      sourceText += '\n' + extracted
    } catch {}
    const matches = baseNodes
      .filter(node => String(node.t || '').length >= 3 && sourceText.includes(node.t))
      .sort((left, right) => String(right.t).length - String(left.t).length)
      .slice(0, 6)
    for (const node of matches) connect(sourceId, node.id, 'evidence')
  }

  const drafts = lushan.knowledge.listDrafts('pending')
  for (const draft of drafts) {
    for (const node of draft.nodes || []) {
      nodes.set(node.id, {
        id: node.id,
        title: node.t,
        kind: '草稿',
        draftKind: node.k,
        source: 'draft',
        coordinate: node.c,
        hasContent: Boolean(node.content),
      })
      for (const sourceId of draft.sourceIds || []) connect(sourceId, node.id, 'draft-source')
    }
  }
  for (const draft of drafts) {
    for (const node of draft.nodes || []) {
      for (const title of node.relations || node.out || []) connect(node.id, titleToId.get(title), 'draft-relation')
    }
  }
  const visibleLinks = [...links.values()].filter(link => nodes.has(link.source) && nodes.has(link.target))
  return {
    nodes: [...nodes.values()],
    links: visibleLinks,
    stats: {
      sources: sources.length,
      pendingDrafts: drafts.length,
      publishedNodes: lushan.knowledge.stats().publishedNodes,
      graphNodes: nodes.size,
      graphLinks: visibleLinks.length,
    },
  }
}

export function readKnowledgeGraphNode(lushan, value) {
  const id = String(value || '').trim()
  if (!id) return null

  for (const draft of lushan.knowledge.listDrafts('pending')) {
    for (const node of draft.nodes || []) {
      if (String(node.id) !== id) continue
      return {
        id,
        title: node.t,
        kind: '草稿',
        draftKind: node.k,
        source: 'draft',
        content: node.content || '',
      }
    }
  }

  const source = lushan.knowledge.listSources().find(item => String(item.id) === id)
  if (source) {
    const detail = lushan.knowledge.readSource(id, 0, 30_000)
    return {
      id,
      title: source.name,
      kind: '资料',
      source: 'source',
      fileKind: source.kind,
      content: detail.text,
      totalChars: detail.totalChars,
      truncated: detail.nextOffset != null,
    }
  }

  if (id === 'wenshan-source-collection') {
    return {
      id,
      title: '本次资料夹',
      kind: '资料夹',
      source: 'collection',
      content: '知识演化模式收录的实习资料会汇总在这里。点击资料节点可以查看已提取的文字内容。',
    }
  }

  const baseNodes = Array.isArray(lushan.graph && lushan.graph.nodes) ? lushan.graph.nodes : []
  const node = baseNodes.find(item => String(item.id) === id)
  if (!node) return null
  return {
    id,
    title: node.t,
    kind: node.k,
    source: 'published',
    markdown: typeof node.md === 'string' ? node.md : '',
    content: typeof node.content === 'string' ? node.content : '',
  }
}

function injectProductSurface(html) {
  const addition = [
    '<style id="wenshan-product-style">',
    'html,body{background:#12231d!important}body{isolation:isolate}',
    'body::before{content:"";position:fixed;inset:-3%;z-index:0;pointer-events:none;background:linear-gradient(180deg,rgba(13,31,25,.06),rgba(15,38,29,.13)),url("/wenshan/assets/valley.webp") center/cover no-repeat;filter:saturate(.88) contrast(.98);animation:wenshan-valley-drift 28s ease-in-out infinite alternate}',
    'body::after{content:"";position:fixed;inset:-22% -8%;z-index:0;pointer-events:none;opacity:.05;background-image:repeating-linear-gradient(104deg,transparent 0 41px,rgba(225,239,232,.62) 42px,transparent 43px 89px);background-size:168px 236px;animation:wenshan-rain 1.45s linear infinite;mask-image:linear-gradient(to bottom,rgba(0,0,0,.68),rgba(0,0,0,.10))}',
    '#root{position:relative;z-index:1}[data-details-collapsed]{background:transparent!important}',
    '[data-details-collapsed]>:first-child{background:linear-gradient(180deg,rgba(246,249,247,.72),rgba(239,245,241,.80))!important;border-right:1px solid rgba(35,72,52,.12);box-shadow:16px 0 44px rgba(24,53,37,.10);backdrop-filter:blur(8px) saturate(.84)}',
    '[data-slot="conversation"]>[data-phase]{background:linear-gradient(180deg,rgba(239,245,241,.16),rgba(245,248,246,.30))!important;backdrop-filter:blur(1px) saturate(.92)}',
    '[data-slot="sidebar"]>div,[data-slot="sidebar"]>div>div{background:transparent!important}[data-slot="sidebar"] [class*="_fade"]{background:linear-gradient(to bottom,transparent,rgba(239,245,241,.86))!important}',
    '[data-composer-card]{background:rgba(255,255,255,.88)!important;border:1px solid rgba(40,78,57,.16)!important;border-radius:20px!important;box-shadow:0 22px 64px rgba(31,62,44,.16),inset 0 1px 0 rgba(255,255,255,.68)!important;backdrop-filter:blur(22px) saturate(.9)}',
    '[class*="_headlineText"]{font-family:"Noto Serif SC","Source Han Serif SC","Songti SC","SimSun",serif;font-size:31px!important;font-weight:650!important;letter-spacing:.04em;color:#163c2d!important;text-shadow:0 2px 22px rgba(255,255,255,.72)}',
    'body[data-ds-dark-theme]::before{filter:saturate(.98) contrast(1.08) brightness(.76)}body[data-ds-dark-theme]::after{opacity:.045}',
    'body[data-ds-dark-theme] [data-slot="conversation"]>[data-phase]{background:radial-gradient(circle at 50% 42%,rgba(196,215,204,.08),transparent 36%),linear-gradient(180deg,rgba(4,12,9,.18),rgba(5,18,13,.50))!important}',
    'body[data-ds-dark-theme] [data-details-collapsed]>:first-child{background:linear-gradient(180deg,rgba(4,17,12,.32),rgba(5,22,15,.42))!important;border-right-color:rgba(194,218,205,.16);box-shadow:18px 0 46px rgba(0,0,0,.16);backdrop-filter:blur(6px) saturate(.82) brightness(1.22)}',
    'body[data-ds-dark-theme] [data-slot="sidebar"] [class*="_fade"]{background:linear-gradient(to bottom,transparent,rgba(5,22,15,.52))!important}',
    'body[data-ds-dark-theme] [data-composer-card]{background:linear-gradient(145deg,rgba(13,25,21,.84),rgba(17,24,22,.92))!important;border-color:rgba(214,231,221,.14)!important;box-shadow:0 24px 80px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.055)!important}',
    'body[data-ds-dark-theme] [class*="_headlineText"]{color:#f2f6f2!important;text-shadow:0 2px 20px rgba(0,0,0,.56)}',
    '@keyframes wenshan-valley-drift{from{transform:scale(1.015) translate3d(-.35%,0,0)}to{transform:scale(1.055) translate3d(.35%,-.5%,0)}}@keyframes wenshan-rain{from{transform:translate3d(0,-96px,0)}to{transform:translate3d(-38px,96px,0)}}',
    '@media(max-width:720px){[class*="_headlineText"]{font-size:25px!important}body::after{opacity:.035}}@media(prefers-reduced-motion:reduce){body::before,body::after{animation:none!important}}',
    '</style><script src="/wenshan/assets/evolution.js" defer></script>',
  ].join('')
  const brandedHtml = html.replace(/<title>[\s\S]*?<\/title>/i, '<title>' + PRODUCT_NAME + '</title>')
  return brandedHtml.includes('</body>') ? brandedHtml.replace('</body>', addition + '</body>') : brandedHtml + addition
}

export function apply(ctx, config = {}) {
  const options = {
    graphPage: config.graphPage || defaultGraphPage,
    evolutionScript: config.evolutionScript || defaultEvolutionScript,
    forceGraphScript: config.forceGraphScript || defaultForceGraphScript,
    wallpaperPath: config.wallpaperPath || defaultWallpaper,
    maxUploadBytes: Number(config.maxUploadBytes) || 200 * 1024 * 1024,
    python: config.python || 'python',
    pythonArgs: Array.isArray(config.pythonArgs) ? config.pythonArgs.map(String) : [],
    extractorPath: config.extractorPath || path.resolve(process.cwd(), 'tools/extract_source.py'),
    extractTimeoutMs: Number(config.extractTimeoutMs) || 30 * 60 * 1000,
  }

  ctx.effect(() => ctx.webServer.tapIndex(injectProductSurface), 'wenshan-intake:product-surface')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wenshan/assets/valley.webp',
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '仅支持 GET' })
      return sendText(res, req, options.wallpaperPath, 'image/webp')
    },
  }), 'wenshan-intake:wallpaper')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wenshan/assets/evolution.js',
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '仅支持 GET' })
      return sendText(res, req, options.evolutionScript, 'text/javascript; charset=utf-8')
    },
  }), 'wenshan-intake:evolution-script')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wenshan/assets/force-graph.min.js',
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '仅支持 GET' })
      return sendText(res, req, options.forceGraphScript, 'text/javascript; charset=utf-8')
    },
  }), 'wenshan-intake:force-graph-script')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wenshan/knowledge-graph',
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '仅支持 GET' })
      return sendText(res, req, options.graphPage, 'text/html; charset=utf-8')
    },
  }), 'wenshan-intake:graph-page')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/wenshan/api/evolution',
    async handler(req, res) {
      const url = new URL(req.url || '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/wenshan/api/evolution/status') {
        return sendJson(res, 200, buildKnowledgeGraph(ctx.lushanData).stats)
      }
      if (req.method === 'GET' && url.pathname === '/wenshan/api/evolution/graph') {
        return sendJson(res, 200, buildKnowledgeGraph(ctx.lushanData))
      }
      if (req.method === 'GET' && url.pathname === '/wenshan/api/evolution/node') {
        try {
          const detail = readKnowledgeGraphNode(ctx.lushanData, url.searchParams.get('id'))
          if (!detail) return sendJson(res, 404, { error: '没有找到这个知识节点' })
          return sendJson(res, 200, detail)
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (req.method === 'GET' && url.pathname === '/wenshan/api/evolution/sources') {
        return sendJson(res, 200, { sources: ctx.lushanData.knowledge.listSources() })
      }
      if (req.method === 'POST' && url.pathname === '/wenshan/api/evolution/sources') {
        try {
          const fileName = safeName(url.searchParams.get('name'))
          const kind = detectKind(fileName)
          if (!kind) throw new Error('不支持此文件类型。支持 TXT、Markdown、CSV、PDF、DOCX、图片、音频、GeoJSON、GPX，以及包含 Shapefile 或 GDB 的 ZIP。')
          const buffer = await readBody(req, options.maxUploadBytes)
          let extracted
          try {
            extracted = await extract(buffer, fileName, kind, options)
          } catch (error) {
            extracted = {
              text: '资料「' + fileName + '」原文件已保存，但自动提取失败：' + (error instanceof Error ? error.message : String(error)),
              metadata: { extractionError: error instanceof Error ? error.message : String(error) },
            }
          }
          if (String(extracted.text || '').length > MAX_EXTRACTED_TEXT) throw new Error('提取文本超过 ' + MAX_EXTRACTED_TEXT + ' 字，请拆分文件后重试')
          const relativePath = safeRelativePath(url.searchParams.get('path'))
          const result = ctx.lushanData.knowledge.importSource({
            name: fileName,
            buffer,
            text: extracted.text || '',
            mediaType: String(req.headers['content-type'] || 'application/octet-stream'),
            kind,
            metadata: { ...(extracted.metadata || {}), relativePath: relativePath || undefined, channel: 'knowledge-evolution-folder' },
            structured: extracted.structured,
          })
          return sendJson(res, 201, result)
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
      return sendJson(res, 404, { error: '接口不存在' })
    },
  }), 'wenshan-intake:evolution-api')
  ctx.logger('wenshan-intake').info('知识演化资料夹与图谱：/wenshan/knowledge-graph')
}
