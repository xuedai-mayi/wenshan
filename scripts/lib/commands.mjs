// 问山 · 子命令实现。安装、体检、启动、数据重建、评测、测试都从这里出发，
// `wenshan <cmd>` 与 `npm run <cmd>` 走的是同一条代码路径，没有平台分支。

import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  DEFAULT_HOST, DEFAULT_PORT, launch, resolveHome, resolvePort,
} from './launch.mjs'
import {
  PYTHON_PREFERRED, dataFilesReady, detectNode, detectPnpm, detectPython,
  formatTriple, hasVenv, intakeInstalled, missingModules, portFree, pythonDependencies,
  vendorBuilt,
} from './detect.mjs'
import { preflightNode, pythonEnv, runInstall, spawnInherit } from './setup.mjs'
import { validateOverlay } from './overlay.mjs'
import { banner, bullet, c, detail, duration, fail, ok, table, warn } from './ui.mjs'
import { fetchHealth, restoreBackup, writeBackup } from './ops.mjs'

function productVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? ''
  } catch {
    return ''
  }
}

function flagValue(passthrough, names) {
  for (let index = 0; index < passthrough.length; index++) {
    const token = passthrough[index]
    for (const name of names) {
      if (token === name) return passthrough[index + 1]
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1)
    }
  }
  return undefined
}

async function ask(question, { fallback = true } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase()
    if (!answer) return fallback
    return answer === 'y' || answer === 'yes' || answer === '是' || answer === '回车'
  } finally {
    rl.close()
  }
}

/** 需要安装时给出一次性引导，避免用户第一步就撞见「Cannot find module bin.js」。 */
async function ensureInstalled({ root, python, options }) {
  if (vendorBuilt(root) && intakeInstalled(root)) return true
  const missing = []
  if (!vendorBuilt(root)) missing.push('内置运行时未构建')
  if (!intakeInstalled(root)) missing.push('页面依赖未安装')

  banner('问山 · 首次运行准备', [
    missing.join(' · '),
    '需要构建内置运行时，通常 3—8 分钟（只做一次）',
  ])

  let proceed = options.yes === true
  if (!proceed) {
    if (!process.stdin.isTTY) {
      fail('当前不是交互终端，无法确认安装。请先运行：npm run setup')
      return false
    }
    proceed = await ask('现在开始安装？[Y/n]', { fallback: true })
  }
  if (!proceed) {
    fail('已取消。需要时运行：npm run setup')
    return false
  }
  try {
    await runInstall({ root, python, force: options.force === true })
  } catch {
    return false
  }
  return vendorBuilt(root) && intakeInstalled(root)
}

export async function cmdStart({ root, options, passthrough }) {
  preflightNode()
  const python = detectPython({ root })
  if (python.found && !python.preferred) {
    warn(`Python ${python.version}（推荐 3.11）：音频与 GIS 提取的轮子可能不可用`)
  }
  if (!python.found) warn('未找到 Python：可以启动，但只有纯文本资料能直接收录')

  if (!(await ensureInstalled({ root, python, options }))) return 1

  const port = await resolvePort({ explicit: options.port, host: options.host ?? DEFAULT_HOST })
  if (port.shifted) warn(`默认端口 ${DEFAULT_PORT} 被占用，改用 ${port.port}（--port 可指定）`)
  return launch({
    root,
    python,
    port: port.port,
    host: options.host ?? DEFAULT_HOST,
    passthrough,
    dryRun: options.dryRun === true,
    overlayKeep: options.keepOverlay === true,
    open: options.open !== false,
  })
}

export async function cmdInstall({ root, options }) {
  const node = preflightNode()
  const pnpm = detectPnpm()
  const python = detectPython({ root })

  banner('问山 · 安装', [
    `Node ${node.version}`,
    `pnpm ${pnpm.found ? pnpm.version : '未找到'}`,
    python.found ? `Python ${python.version}（${[python.cmd, ...python.args].join(' ')}）` : 'Python 未找到',
  ])

  const result = await runInstall({ root, python, force: options.force === true })
  process.stdout.write('\n')
  for (const warning of result.warnings) warn(warning)

  if (!vendorBuilt(root) || !intakeInstalled(root)) {
    fail('安装未完成，请按上面的日志处理后重跑：npm run setup')
    return 1
  }
  ok('安装完成')
  bullet(`启动：${c.bold('npm start')}（或 npm link 后用 ${c.bold('wenshan')}）`)
  bullet('首次进入界面在 设置 > 模型 里配置模型与 API Key')
  return 0
}

const CHECK_GLYPH = { ok: c.green('✓'), warn: c.yellow('!'), fail: c.red('✗') }

function checkRows() {
  const rows = []
  const add = (name, status, value) => rows.push([name, `${CHECK_GLYPH[status]} ${value}`])
  return { rows, add }
}

export async function cmdDoctor({ root, options }) {
  const { rows, add } = checkRows()
  const blockers = []

  const node = detectNode()
  add('Node', node.ok ? 'ok' : 'fail', `${node.version}（需要 ${node.required}）`)
  if (!node.ok) blockers.push('Node 版本')

  const pnpm = detectPnpm()
  add('pnpm', pnpm.found ? 'ok' : 'fail', pnpm.found ? pnpm.version : '未安装：npm install -g pnpm')
  if (!pnpm.found) blockers.push('pnpm')

  const python = detectPython({ root })
  let pythonStatus = 'fail'
  let pythonValue = `未找到（尝试过 ${python.attempts.map(a => a.cmd).join(' / ')}）`
  if (python.found) {
    pythonStatus = python.usable ? (python.preferred ? 'ok' : 'warn') : 'fail'
    pythonValue = `${python.version}（${[python.cmd, ...python.args].join(' ')}）`
    if (python.source === 'venv') pythonValue += ' · 项目 .venv'
    if (!python.preferred && python.usable) pythonValue += `，推荐 ${formatTriple(PYTHON_PREFERRED)}`
  }
  add('Python', pythonStatus, pythonValue)

  if (python.found) {
    const deps = pythonDependencies(python)
    for (const group of deps.groups) {
      add(`  ${group.label}`, group.installed ? 'ok' : (group.optional ? 'warn' : 'fail'), group.installed ? '可用' : '缺失（npm run setup）')
      if (!group.installed && !group.optional) blockers.push(group.label)
    }
  }

  const runtimeOk = vendorBuilt(root)
  add('内置运行时', runtimeOk ? 'ok' : 'fail', runtimeOk ? '已构建' : '未构建（npm run setup）')
  if (!runtimeOk) blockers.push('内置运行时')

  const intakeOk = intakeInstalled(root)
  add('页面依赖', intakeOk ? 'ok' : 'fail', intakeOk ? '已安装' : '未安装（npm run setup）')
  if (!intakeOk) blockers.push('页面依赖')

  const data = dataFilesReady(root)
  add('基础数据', data.ready ? 'ok' : 'fail', data.ready ? 'data/*.json 齐全' : `缺少 ${data.missing.join('、')}`)
  if (!data.ready) blockers.push('基础数据')

  const home = resolveHome(root)
  const customHome = Boolean(process.env.WENSHAN_HOME)
  const homeLabel = customHome ? `${home}（WENSHAN_HOME）` : `${path.relative(root, home)}（项目内，删掉即重置）`
  add('运行状态', 'ok', fs.existsSync(home) ? `${homeLabel} · 已创建` : `${homeLabel} · 首次启动时创建`)

  const venv = hasVenv(root)
  add('提取环境', venv ? 'ok' : (python.found ? 'warn' : 'fail'), venv ? '.venv 已创建' : '未创建（npm run setup 会建）')

  const knowledgeRoot = path.join(root, 'data', 'knowledge')
  const eventsFile = path.join(knowledgeRoot, 'events.jsonl')
  const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).length : 0
  add('知识事件日志', 'ok', fs.existsSync(eventsFile) ? `${events} 条事件` : '尚未创建，首次启动后生成')

  const port = options.port ?? DEFAULT_PORT
  const free = await portFree(port, options.host ?? DEFAULT_HOST)
  add(`端口 ${port}`, free ? 'ok' : 'warn', free ? '空闲' : '被占用，npm start 会自动顺延')

  const env = python.found ? `WENSHAN_PYTHON=${[python.cmd, ...python.args].join(' ')}` : 'WENSHAN_PYTHON 未设置'
  add('提取器', python.found ? 'ok' : 'warn', `${path.join('scripts', 'extract_source.py')} · ${env}`)

  process.stdout.write('\n')
  table(rows)
  process.stdout.write('\n')

  if (runtimeOk) {
    const result = await validateOverlay({ root, python })
    if (result.code === 0) ok('挂载层校验通过')
    else {
      fail('挂载层校验失败')
      detail(result.output.split('\n').slice(-15).join('\n'))
      blockers.push('挂载层')
    }
  }

  if (blockers.length) {
    fail(`阻塞项：${blockers.join('、')}`)
    detail('执行 npm run setup 补齐；细节用 npm run doctor 复看')
    return 1
  }
  ok('环境就绪，可以启动：npm start')
  console.log()
  return 0
}

function requirePython(root) {
  const python = detectPython({ root })
  if (!python.found) throw new Error('没有可用的 Python。先安装 Python 3.11：brew install python@3.11 或 WENSHAN_PYTHON=/path/to/python')
  return python
}

/** 数据管线依赖 GDAL 与编译轮子，缺了就直说缺什么，而不是把 Python traceback 甩给用户。 */
function requireModules(python, modules, hint) {
  const missing = missingModules(python, modules)
  if (!missing.length) return
  throw new Error(`缺少 Python 模块 ${missing.join('、')}：${hint}\n  安装：npm run setup -- --force（建议配 Python 3.11），或 WENSHAN_PYTHON=<python3.11> 后重跑`)
}

export async function cmdData({ root, passthrough }) {
  const python = requirePython(root)
  requireModules(python, ['fiona', 'shapely', 'PIL'], '重建基础数据要从 GDB / Shapefile 读几何')
  const script = path.join(root, 'scripts', 'build_data.py')
  const targets = passthrough.length ? passthrough : [path.join('config', 'lushan.json')]
  const result = await spawnInherit(python.cmd, [...python.args, script, ...targets], { cwd: root, env: pythonEnv() })
  return result.code
}

export async function cmdTerrain({ root, passthrough }) {
  const python = requirePython(root)
  requireModules(python, ['numpy', 'PIL'], '生成地形晕渲底图要重采样 DEM 位图')
  const script = path.join(root, 'scripts', 'build_terrain.py')
  const result = await spawnInherit(python.cmd, [...python.args, script, ...passthrough], { cwd: root, env: pythonEnv() })
  return result.code
}

export async function cmdEval({ root, passthrough }) {
  const result = await spawnInherit(process.execPath, [path.join(root, 'scripts', 'eval_qa.mjs'), ...passthrough], { cwd: root })
  return result.code
}

/** 测试：零依赖部分永远跑；需要运行时的部分在未构建时明确跳过而不是假装通过。 */
export async function cmdTest({ root }) {
  const suites = ['test']
  if (vendorBuilt(root)) suites.push('test:integration')
  else warn('内置运行时未构建，跳过 smoke / product 集成测试（npm run setup 后自动纳入）')

  let status = 0
  for (const suite of suites) {
    const { code } = await spawnInherit(process.execPath, ['--run', suite], { cwd: root })
    if (code !== 0) status = 1
  }
  return status
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/**
 * 备份：知识库 + 运行状态打成一个自描述归档。
 * 默认包含 .wenshan-home（模型凭据），因为它决定了「换台机器还能不能直接用」；
 * 要交给别人或放进网盘时用 --data-only。
 */
export async function cmdBackup({ root, passthrough }) {
  const includeState = !passthrough.includes('--data-only')
  const positional = passthrough.filter(token => !token.startsWith('-'))
  const outDir = positional[0] ? path.resolve(positional[0]) : path.join(root, 'backups')
  const home = resolveHome(root)
  const started = Date.now()

  banner('问山 · 备份', [
    '知识库   data/knowledge',
    includeState ? `运行状态 ${path.relative(root, home) || home}（含模型凭据）` : '运行状态 已排除（--data-only）',
    `输出目录 ${path.relative(process.cwd(), outDir) || outDir}`,
  ])

  const result = writeBackup({ root, home, outDir, includeState, productVersion: productVersion(root) })
  ok(`已写入 ${result.file}`)
  bullet(`${result.stats.files} 个文件，原始 ${formatBytes(result.stats.bytes)}，归档 ${formatBytes(result.bytes)}`)
  if (includeState) warn('归档内含模型 API Key 与会话，不要提交仓库、不要放公共网盘')
  bullet(`恢复：${c.bold(`wenshan restore "${result.file}"`)}`)
  bullet(`耗时 ${duration(Date.now() - started)}`)
  return 0
}

/** 恢复：先给现状留副本，再逐文件校验 SHA-256 写回。 */
export async function cmdRestore({ root, options, passthrough }) {
  const file = passthrough.find(token => !token.startsWith('-'))
  if (!file) throw new Error('用法：wenshan restore <备份文件> [--dry-run] [--yes]')
  const archive = path.resolve(file)
  if (!fs.existsSync(archive)) throw new Error(`找不到备份文件：${archive}`)
  const home = resolveHome(root)
  const dryRun = options.dryRun === true

  if (!dryRun && options.yes !== true) {
    if (!process.stdin.isTTY) throw new Error('非交互终端恢复需要显式确认：wenshan restore <文件> --yes')
    const confirmed = await ask('将覆盖 data/knowledge 与运行状态目录，继续？[y/N]', { fallback: false })
    if (!confirmed) {
      fail('已取消，未改动任何文件')
      return 1
    }
  }

  banner('问山 · 恢复', [
    `备份文件 ${path.relative(process.cwd(), archive) || archive}`,
    `知识库   data/knowledge`,
    `运行状态 ${path.relative(root, home) || home}`,
    dryRun ? '模式     仅校验（--dry-run）' : '模式     写回磁盘',
  ])

  const result = restoreBackup({ file: archive, root, home, dryRun })
  if (dryRun) {
    ok(`校验通过：${result.files} 个文件，${formatBytes(result.bytes)}（未写入）`)
    return 0
  }
  ok(`已恢复 ${result.files} 个文件，${formatBytes(result.bytes)}`)
  if (result.createdAt) bullet(`备份时间 ${result.createdAt}`)
  for (const snapshot of result.snapshots) bullet(`恢复前副本 ${snapshot}`)
  bullet(`重新启动服务让知识库生效：${c.bold('npm start')}`)
  return 0
}

/** 健康检查：探 /wenshan/api/health，给人看表格，给脚本 --json。 */
export async function cmdHealth({ root, options, passthrough }) {
  const explicit = flagValue(passthrough, ['--url'])
  const port = Number(flagValue(passthrough, ['--port']) ?? options.port ?? DEFAULT_PORT)
  const baseUrl = explicit ?? `http://${options.host ?? DEFAULT_HOST}:${port}`
  const asJson = passthrough.includes('--json')
  const result = await fetchHealth({ baseUrl })

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ baseUrl, ...result }, null, 2)}\n`)
    return result.ok ? 0 : 1
  }

  banner('问山 · 健康检查', [`目标 ${baseUrl}`])
  if (!result.body) {
    fail(`连不上：${result.error ?? `HTTP ${result.status}`}`)
    detail('服务没起？先 npm start；端口不是 3080 就用 --url 指到实际地址')
    return 1
  }
  const body = result.body
  const rows = [
    ['状态', body.status === 'ok' ? c.green('ok') : c.yellow(String(body.status))],
    ['站点', body.site || '—'],
    ['数据', body.data?.ready ? '齐全' : `缺少 ${(body.data?.missing || []).join('、')}`],
    ['资料 / 待审草稿', `${body.knowledge?.sources ?? 0} / ${body.knowledge?.pendingDrafts ?? 0}`],
    ['已发布节点', String(body.knowledge?.publishedNodes ?? 0)],
    ['待补缺口', String(body.knowledge?.openGaps ?? 0)],
    ['服务运行', `${Math.round(body.uptimeSeconds ?? 0)} 秒`],
  ]
  table(rows)
  if (result.ok) {
    ok('服务可用')
    return 0
  }
  fail('服务可达但不健康')
  if (body.error) detail(String(body.error))
  return 1
}

/** 发布前自检：体检（含挂载层校验）与测试。 */
export async function cmdPreflight({ root, options }) {
  banner('问山 · 发布前自检', ['体检（含挂载层校验） → 测试'])
  const doctorCode = await cmdDoctor({ root, options })
  if (doctorCode !== 0) {
    fail('体检未通过，先修环境再谈发布')
    return doctorCode
  }
  const testCode = await cmdTest({ root })
  if (testCode !== 0) return testCode
  process.stdout.write('\n')
  ok('自检通过')
  return 0
}
