// 问山 · 运维层：跨平台备份 / 恢复 / 健康探测。
//
// 备份格式刻意不用系统 tar：三个平台上的 tar 参数与行为并不一致（macOS 是 bsdtar，
// Windows 只在 10 以后才带 tar.exe），而这两种数据恰恰是「换机器 / 重装」时最需要的。
// 这里用 gzip(JSON) 的自描述归档：清单里写清路径、大小、权限和 SHA-256，恢复时逐条校验，
// 一个 Node 就能读，Windows / macOS / Linux 完全同一条代码路径。
//
// 归档里只有两类内容：
//   data/knowledge/**   人工审核过的知识、原始资料、结构化结果、事件日志
//   .wenshan-home/**    会话、模型凭据、profile 层（含 API Key，默认包含，--data-only 可排除）
// 恢复时也只往这两处写，清单里出现别的路径一律拒绝，避免归档被改造成任意文件写入。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export const BACKUP_FORMAT = 'wenshan-backup'
export const BACKUP_VERSION = 1
export const BACKUP_EXT = '.wenshan.gz'
export const STATE_PREFIX = '.wenshan-home'
export const KNOWLEDGE_PREFIX = 'data/knowledge'

/** 归档内的相对路径白名单：只认这两个前缀，且不允许跳出目录。 */
export function archiveTarget(rel) {
  const normalized = String(rel || '').replaceAll('\\', '/')
  if (!normalized || normalized.includes('\0')) return null
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) return null
  if (normalized === KNOWLEDGE_PREFIX || normalized.startsWith(`${KNOWLEDGE_PREFIX}/`)) return { type: 'knowledge' }
  if (normalized === STATE_PREFIX || normalized.startsWith(`${STATE_PREFIX}/`)) return { type: 'state' }
  return null
}

/** 递归收集普通文件；符号链接跳过（备份不该把外部路径卷进来）。 */
function walk(absDir, relPrefix, out) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name)
    const rel = `${relPrefix}/${entry.name}`
    if (entry.isDirectory()) walk(abs, rel, out)
    else if (entry.isFile()) out.push({ abs, rel })
  }
}

/** 列出要进归档的文件。includeState=false 时只备份知识库，不含凭据。 */
export function collectStateFiles({ root, home, includeState = true }) {
  const files = []
  const knowledgeDir = path.join(root, 'data', 'knowledge')
  if (fs.existsSync(knowledgeDir)) walk(knowledgeDir, KNOWLEDGE_PREFIX, files)
  if (includeState && home && fs.existsSync(home)) walk(home, STATE_PREFIX, files)
  return files
}

export function backupFileName(now = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  const stamp = [
    now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()), '-',
    pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds()),
  ].join('')
  return `wenshan-backup-${stamp}${BACKUP_EXT}`
}

/**
 * 生成备份内容（不落盘，便于测试）。
 * @returns {{buffer: Buffer, manifest: object, stats: {files: number, bytes: number}}}
 */
export function createBackup({ root, home, includeState = true, now = new Date(), productVersion = '' }) {
  const files = collectStateFiles({ root, home, includeState })
  if (!files.length) {
    throw new Error('没有可备份的数据：data/knowledge 与运行状态目录都还是空的。先在「知识演化」里收录一份资料再备份。')
  }
  let raw = 0
  const entries = files.map(({ abs, rel }) => {
    const body = fs.readFileSync(abs)
    const stat = fs.statSync(abs)
    raw += body.length
    return {
      path: rel,
      size: body.length,
      mode: stat.mode & 0o777,
      mtime: stat.mtime.toISOString(),
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      data: body.toString('base64'),
    }
  })
  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    product: { name: 'wenshan', version: productVersion },
    includeState,
    stats: { files: entries.length, bytes: raw },
    files: entries,
  }
  const buffer = zlib.gzipSync(Buffer.from(JSON.stringify(manifest)), { level: 9 })
  return { buffer, manifest, stats: { files: entries.length, bytes: raw } }
}

/** 写备份文件，返回实际路径与清单。 */
export function writeBackup({ root, home, outDir, includeState = true, now = new Date(), productVersion = '' }) {
  const targetDir = path.resolve(outDir || path.join(root, 'backups'))
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  const { buffer, manifest, stats } = createBackup({ root, home, includeState, now, productVersion })
  const file = path.join(targetDir, backupFileName(now))
  // 归档可能含模型 API Key：默认 600，只有当前用户能读。
  fs.writeFileSync(file, buffer, { mode: 0o600 })
  return { file, manifest, stats, bytes: buffer.length }
}

/** 读取并校验归档清单；任何一条不合规都整体拒绝，不做部分恢复。 */
export function parseBackup(buffer) {
  let manifest
  try {
    manifest = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'))
  } catch {
    throw new Error('不是问山的备份文件，或者文件已经损坏（gzip / JSON 解析失败）')
  }
  if (!manifest || manifest.format !== BACKUP_FORMAT) throw new Error('备份格式不匹配：缺少 wenshan-backup 标记')
  if (manifest.version !== BACKUP_VERSION) {
    const higher = Number(manifest.version) > BACKUP_VERSION
    throw new Error(higher
      ? `备份由更高版本生成（v${manifest.version}），先升级问山再恢复`
      : `备份版本不受支持（v${manifest.version ?? '未知'}），请用同版本问山重新导出`)
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('备份里没有文件')
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string') throw new Error('备份清单损坏：存在没有路径的条目')
    if (!archiveTarget(entry.path)) throw new Error(`备份清单含非法路径：${entry.path}`)
    if (typeof entry.data !== 'string') throw new Error(`备份清单损坏：${entry.path} 没有内容`)
  }
  return manifest
}

export function readBackup(file) {
  return parseBackup(fs.readFileSync(file))
}

/** 恢复前给磁盘上的现状留一份副本，恢复错了还能退回来。 */
function snapshotExisting(absDir, stamp) {
  if (!fs.existsSync(absDir)) return null
  const target = `${absDir}-restore-${stamp}`
  fs.cpSync(absDir, target, { recursive: true })
  return target
}

/**
 * 恢复备份。
 * @returns {{files: number, bytes: number, targets: string[], snapshots: string[]}}
 */
export function restoreBackup({ file, root, home, dryRun = false, now = new Date() }) {
  const manifest = readBackup(file)
  const stamp = `${backupFileName(now).replace(BACKUP_EXT, '')}-${process.pid}`
  const snapshots = []
  let bytes = 0
  if (!dryRun) {
    for (const absDir of [path.join(root, 'data', 'knowledge'), home].filter(Boolean)) {
      const snapshot = snapshotExisting(absDir, stamp)
      if (snapshot) snapshots.push(snapshot)
    }
  }
  for (const entry of manifest.files) {
    const target = archiveTarget(entry.path)
    const base = target.type === 'state' ? home : path.join(root, 'data', 'knowledge')
    if (!base) throw new Error('运行状态目录未知，无法恢复 .wenshan-home（检查 WENSHAN_HOME）')
    const relative = target.type === 'state'
      ? entry.path.slice(STATE_PREFIX.length + 1)
      : entry.path.slice(KNOWLEDGE_PREFIX.length + 1)
    const abs = path.resolve(base, ...relative.split('/'))
    if (!abs.startsWith(path.resolve(base) + path.sep)) throw new Error(`拒绝写入备份目录之外的路径：${entry.path}`)
    const body = Buffer.from(entry.data, 'base64')
    if (entry.size != null && body.length !== entry.size) throw new Error(`文件大小与清单不符：${entry.path}`)
    if (entry.sha256 && crypto.createHash('sha256').update(body).digest('hex') !== entry.sha256) {
      throw new Error(`校验失败，备份可能已损坏：${entry.path}`)
    }
    bytes += body.length
    if (dryRun) continue
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
    if (entry.mode) {
      try { fs.chmodSync(abs, entry.mode) } catch {}
    }
  }
  return {
    files: manifest.files.length,
    bytes,
    createdAt: manifest.createdAt,
    includeState: Boolean(manifest.includeState),
    targets: [...new Set(manifest.files.map(entry => archiveTarget(entry.path).type))],
    snapshots,
    dryRun,
  }
}

/** 健康探测：访问运行中的 /wenshan/api/health，把网络错误也归一成结果而不是抛栈。 */
export async function fetchHealth({ baseUrl, timeoutMs = 5000, fetchImpl = globalThis.fetch }) {
  let url
  try {
    url = new URL('/wenshan/api/health', baseUrl)
  } catch {
    throw new Error(`健康检查地址不合法：${baseUrl}，应形如 http://127.0.0.1:3080`)
  }
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    let body = null
    try { body = await response.json() } catch {}
    if (!body) {
      return {
        ok: false,
        status: response.status,
        url: url.href,
        body: null,
        error: `目标不是问山服务（HTTP ${response.status}）`,
      }
    }
    return { ok: response.ok && body.status === 'ok', status: response.status, url: url.href, body }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url: url.href,
      body: null,
      error: error?.name === 'TimeoutError' ? `连接超时（${timeoutMs}ms）` : (error?.message ?? String(error)),
    }
  }
}
