// 问山 · 环境探测：Node / pnpm / Python / 端口 / 已构建状态。
// 每个探测都只读、可注入，tests/cli.test.mjs 直接调用纯函数做断言。

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** Node 运行时的最低与推荐版本（package.json engines 同源）。 */
export const NODE_MIN = [22, 19]
export const PYTHON_MIN = [3, 9]
/** 文档、音频与 GIS 提取的轮子只对 3.11 稳定供应，其余版本降级为警告。 */
export const PYTHON_PREFERRED = [3, 11]

/** `v24.22.0` / `3.11.9` / `24` → [24,22,0] / [3,11,9] / [24,0,0]；解析失败返回 null。 */
export function parseTriple(value) {
  const match = String(value ?? '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) return null
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

/** a >= b。 */
export function semverGte(a, b) {
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return true
}

export function formatTriple(triple) {
  return triple ? triple.join('.') : 'unknown'
}

/**
 * `python3.11` → { cmd: 'python3.11', args: [] }
 * `py -3.11`   → { cmd: 'py', args: ['-3.11'] }
 */
export function parsePythonSpec(spec) {
  const parts = String(spec ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  return { cmd: parts[0], args: parts.slice(1) }
}

/**
 * 候选解释器，按优先级排列。用户可以钉住一个：WENSHAN_PYTHON="python3.11"。
 * 不写死 `python3.11`：macOS/Homebrew 常只有 `python3.12`，Linux 发行版甚至只有 `python3`。
 */
export function pythonCandidates(env = process.env, platform = process.platform) {
  const pinned = parsePythonSpec(env.WENSHAN_PYTHON)
  const list = pinned ? [pinned] : []
  if (platform === 'win32') {
    list.push({ cmd: 'py', args: ['-3.11'] }, { cmd: 'python', args: [] })
  }
  list.push({ cmd: 'python3.11', args: [] }, { cmd: 'python3', args: [] }, { cmd: 'python', args: [] })
  const seen = new Set()
  return list.filter(item => {
    const key = `${item.cmd} ${item.args.join(' ')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 静默执行，返回 { ok, stdout, stderr, error }，永不抛出。 */
export function runQuiet(cmd, args = [], options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 15_000,
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
  })
  if (result.error) return { ok: false, stdout: '', stderr: String(result.error.message), error: result.error }
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

export function detectNode(version = process.version) {
  const version_ = version.startsWith('v') ? version.slice(1) : version
  const triple = parseTriple(version_)
  return {
    version: version_,
    triple,
    ok: triple !== null && semverGte(triple, NODE_MIN),
    required: `>=${NODE_MIN.join('.')}`,
  }
}

/** pnpm 是构建内置运行时的唯一前置；取不到就报清楚怎么装。 */
export function detectPnpm() {
  const probe = runQuiet(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'])
  if (!probe.ok) return { found: false, version: null, cmd: null }
  return { found: true, version: probe.stdout.split('\n')[0], cmd: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm' }
}

/** 项目内虚拟环境的位置。抽成常量是因为 launch / doctor / setup 三处都要用同一个。 */
export function venvPaths(root, platform = process.platform) {
  const dir = path.join(root, '.venv')
  const python = platform === 'win32'
    ? path.join(dir, 'Scripts', 'python.exe')
    : path.join(dir, 'bin', 'python')
  return { dir, python }
}

export function hasVenv(root) {
  try {
    return fs.existsSync(venvPaths(root).python)
  } catch {
    return false
  }
}

/**
 * 逐个候选解释器试 `sys.version_info`，返回第一个能跑的。
 * 顺序上项目 `.venv` 永远优先：依赖装在里面，系统解释器只负责创建它。
 */
export function detectPython({ root, env = process.env, platform = process.platform, runner = runQuiet } = {}) {
  const probeCode = 'import sys;print("%d.%d.%d" % sys.version_info[:3])'
  const attempts = []
  const candidates = []
  if (root && hasVenv(root)) candidates.push({ cmd: venvPaths(root, platform).python, args: [], source: 'venv' })
  for (const candidate of pythonCandidates(env, platform)) candidates.push({ ...candidate, source: 'system' })

  for (const candidate of candidates) {
    const result = runner(candidate.cmd, [...candidate.args, '-c', probeCode], { timeout: 10_000 })
    if (!result.ok) {
      attempts.push({ ...candidate, error: (result.stderr || 'not found').split('\n')[0] })
      continue
    }
    const triple = parseTriple(result.stdout)
    if (!triple) {
      attempts.push({ ...candidate, error: `无法解析版本号：${result.stdout}` })
      continue
    }
    return {
      found: true,
      ...candidate,
      version: formatTriple(triple),
      triple,
      usable: semverGte(triple, PYTHON_MIN),
      // 推荐版本 = 仓库固定的 3.11（fiona / ctranslate2 的轮子覆盖最好）；更高版本可用但会提示。
      preferred: triple[0] === PYTHON_PREFERRED[0] && triple[1] === PYTHON_PREFERRED[1],
      attempts,
    }
  }
  return { found: false, attempts }
}

const PYTHON_DEPENDENCIES = [
  { key: 'document', label: '文档（pypdf / python-docx）', modules: ['pypdf', 'docx'], optional: false },
  { key: 'gis', label: 'GIS（fiona）', modules: ['fiona'], optional: true },
  { key: 'audio', label: '录音（faster-whisper）', modules: ['faster_whisper'], optional: true },
]

/** 逐个 import 试一遍提取依赖；不跑 pip，代价固定 10s 内。 */
export function pythonDependencies(python, { runner = runQuiet } = {}) {
  if (!python?.found) return { ready: false, groups: [] }
  const groups = []
  for (const dependency of PYTHON_DEPENDENCIES) {
    const code = `import ${dependency.modules.join(', ')};print("ok")`
    const result = runner(python.cmd, [...python.args, '-c', code], { timeout: 30_000 })
    groups.push({ ...dependency, installed: result.ok, error: result.ok ? undefined : result.stderr.split('\n').slice(-2).join(' ') })
  }
  return {
    ready: groups.filter(group => !group.optional).every(group => group.installed),
    groups,
  }
}

/** 检查任意 Python 模块是否可导入，返回缺失的模块名（module 名，不是包名）。 */
export function missingModules(python, modules, { runner = runQuiet } = {}) {
  if (!python?.found) return [...modules]
  const missing = []
  for (const module of modules) {
    const result = runner(python.cmd, [...python.args, '-c', `import ${module}`], { timeout: 20_000 })
    if (!result.ok) missing.push(module)
  }
  return missing
}

/** 端口是否空闲。用一次 connect 判定：连上即被占用。 */
export function portFree(port, host = '127.0.0.1', { timeout = 700 } = {}) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host })
    let settled = false
    const finish = free => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(free)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => finish(false))
    socket.once('timeout', () => finish(true))
    socket.once('error', () => finish(true))
  })
}

/** 端口上是否已有服务在监听（启动器用它判断「web 面真的起来了」）。 */
export async function portListening(port, host = '127.0.0.1', { probe = portFree, ...options } = {}) {
  return !(await probe(port, host, options))
}

/**
 * 等端口开始监听。启动器在打开浏览器之前用它，避免浏览器先于服务到达。
 * @returns {Promise<boolean>} 是否在超时前就绪
 */
export async function waitForListening(port, host = '127.0.0.1', {
  timeoutMs = 30_000, intervalMs = 200, probe = portFree,
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await probe(port, host))) return true
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return false
}

/**
 * 从 start 开始找第一个空闲端口。默认顺延 20 个，避免和同机其它 agent 服务（例如占用
 * 3080 的 dsh）互撞。返回 { port, shifted }。
 */
export async function findFreePort(start, { host = '127.0.0.1', limit = 20, probe = portFree } = {}) {
  for (let offset = 0; offset < limit; offset++) {
    const port = start + offset
    // eslint-disable-next-line no-await-in-loop
    if (await probe(port, host)) return { port, shifted: offset > 0 }
  }
  return { port: null, shifted: false }
}

/** 内置运行时是否已构建：CLI 入口、运行时依赖树、业务包硬依赖的 schemastery 都在。 */
export function vendorBuilt(root) {
  const relative = [
    'vendor/runtime/apps/cli/lib/bin.js',
    'vendor/runtime/vendor/schemastery/lib/index.mjs',
    'vendor/runtime/node_modules',
  ]
  return relative.every(entry => fs.existsSync(path.join(root, entry)))
}

/** 前端图谱依赖是否装过（force-graph 的 dist 由 intake 直接对外提供）。 */
export function intakeInstalled(root) {
  return fs.existsSync(path.join(root, 'packages/intake/node_modules/force-graph/dist/force-graph.min.js'))
}

/** 基础数据是否齐全：缺任何一份都无法构建检索。 */
export function dataFilesReady(root) {
  const files = ['site_data.json', 'graph_data.json', 'days_data.json', 'map_data.json', 'photos_index.json']
  const missing = files.filter(file => !fs.existsSync(path.join(root, 'data', file)))
  return { ready: missing.length === 0, missing }
}
