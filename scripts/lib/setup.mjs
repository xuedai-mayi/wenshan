// 问山 · 安装：构建内置运行时、安装页面依赖、装文档/音频/GIS 提取依赖、校验挂载层。
//
// 全部步骤幂等：已经完成的部分直接跳过，`--force` 才会重跑。任何一步都不会写进
// 版本库（node_modules / lib / __pycache__ 均已 ignore）。

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createOverlay } from './overlay.mjs'
import {
  detectNode, detectPnpm, detectPython, hasVenv, intakeInstalled, missingModules,
  vendorBuilt, venvPaths,
} from './detect.mjs'
import { c, detail, duration, fail, ok, skip, step, warn } from './ui.mjs'

const npmCommand = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm')

/** 前台子进程：输出直通终端，Ctrl+C 由父进程转发。 */
export function spawnInherit(cmd, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`  ${c.dim(`$ ${[cmd, ...args].join(' ')}`)}\n`)
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }))
  })
}

/** 运行时安装时用 CI=true 跳过 vendor 的 lefthook 安装：它会给宿主仓库写 git hook。 */
const vendorEnv = () => ({ ...process.env, CI: 'true' })

/** Windows 控制台默认 GBK；给所有 Python 子进程钉死 UTF-8，避免中文输出报编码错。 */
export const pythonEnv = () => ({ ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' })

/**
 * 安装计划：每步都可以自我判断「已经装好了吗」。
 * @returns {Array<{ id: string, title: string, optional?: boolean, why: (ctx: object) => string|false, run: (ctx: object) => Promise<void> }>}
 */
export function buildPlan({ root, python, force = false }) {
  const steps = []

  steps.push({
    id: 'runtime',
    title: '构建内置运行时（vendor/runtime）',
    why: ctx => {
      if (vendorBuilt(root) && !force) return '已构建，跳过'
      const pnpm = detectPnpm()
      if (!pnpm.found) {
        throw new Error('找不到 pnpm。先安装：npm install -g pnpm（或 corepack enable pnpm），再运行 npm run setup')
      }
      ctx.pnpm = pnpm
      return false
    },
    async run(ctx) {
      const cwd = path.join(root, 'vendor', 'runtime')
      detail(`pnpm ${ctx.pnpm.version} · ${cwd}`)
      let result = await spawnInherit(ctx.pnpm.cmd, ['install', '--frozen-lockfile'], { cwd, env: vendorEnv() })
      if (result.code !== 0) {
        warn('带 frozen-lockfile 的安装失败，改用 --no-frozen-lockfile 重试一次')
        result = await spawnInherit(ctx.pnpm.cmd, ['install', '--no-frozen-lockfile'], { cwd, env: vendorEnv() })
        if (result.code !== 0) throw new Error('运行时依赖安装失败，日志见上方')
      }
      const build = await spawnInherit(ctx.pnpm.cmd, ['build'], { cwd })
      if (build.code !== 0) throw new Error('运行时构建失败，日志见上方')
      if (!vendorBuilt(root)) throw new Error('运行时构建后仍缺少 apps/cli/lib/bin.js 或 schemastery，请检查构建日志')
    },
  })

  steps.push({
    id: 'intake',
    title: '安装知识图谱页面依赖（force-graph / 3d-force-graph）',
    why: () => (intakeInstalled(root) && !force ? '已安装，跳过' : false),
    async run() {
      const cwd = path.join(root, 'packages', 'intake')
      const result = await spawnInherit(npmCommand(), ['ci', '--omit=dev', '--legacy-peer-deps'], { cwd })
      if (result.code !== 0) throw new Error('页面依赖安装失败，日志见上方')
    },
  })

  // Python 依赖按组拆成独立步骤：文档提取必需，录音 / GIS / 数据管线缺轮子只降级对应格式，
  // 而且各组装好之后各自跳过——不会因为核心已就绪就永远不再尝试其它组。
  const pythonGroups = [
    { id: 'python-core', file: 'requirements-core.txt', label: '文档提取', modules: ['pypdf', 'docx'], required: true },
    { id: 'python-audio', file: 'requirements-audio.txt', label: '录音转写', modules: ['faster_whisper'], required: false },
    { id: 'python-gis', file: 'requirements-gis.txt', label: 'GIS 矢量', modules: ['fiona'], required: false },
    { id: 'python-tools', file: 'requirements-tools.txt', label: '数据重建', modules: ['fiona', 'shapely', 'numpy', 'PIL'], required: false },
  ]

  const noPython = () => {
    if (!python?.found) return '没有可用的 Python，跳过（仅影响 PDF / Word / 录音 / GIS 提取与数据重建）'
    if (!python.usable) return `Python ${python.version} 低于 3.9，跳过`
    return false
  }

  steps.push({
    id: 'venv',
    title: '准备项目虚拟环境（.venv）',
    optional: true,
    why: () => {
      const blocked = noPython()
      if (blocked) return blocked
      return hasVenv(root) ? '.venv 已存在，跳过' : false
    },
    async run() {
      const { dir } = venvPaths(root)
      detail(`创建虚拟环境 ${dir}`)
      const created = await spawnInherit(python.cmd, [...python.args, '-m', 'venv', dir], { cwd: root, env: pythonEnv() })
      if (created.code !== 0) throw new Error('创建 .venv 失败：该 Python 缺少 venv / ensurepip 模块，可改用 python3.11')
    },
  })

  for (const group of pythonGroups) {
    steps.push({
      id: group.id,
      title: `${group.label}依赖（${group.file}）`,
      optional: !group.required,
      why: () => {
        const blocked = noPython()
        if (blocked) return blocked
        if (!hasVenv(root)) return '.venv 未创建，跳过'
        if (force) return false
        return missingModules({ found: true, cmd: venvPaths(root).python, args: [] }, group.modules).length === 0
          ? `已安装，跳过`
          : false
      },
      async run(ctx) {
        const venvPython = venvPaths(root).python
        // 可选组加 --only-binary 是为了快速失败：否则 pip 会为 onnxruntime 这类包回溯数分钟。
        const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(root, group.file)]
        if (!group.required) args.push('--only-binary=:all:')
        const result = await spawnInherit(venvPython, args, { cwd: root, env: pythonEnv() })
        if (result.code === 0) return
        if (group.required) throw new Error(`${group.label}依赖安装失败，请查看上面的 pip 日志；换 Python 3.11 通常可解`)
        const message = `${group.label}依赖未安装（Python ${python.version} 无可用轮子），相关功能暂不可用`
        warn(message)
        ;(ctx.warnings ??= []).push(message)
      },
    })
  }

  steps.push({
    id: 'validate',
    title: '校验产品挂载层（--dump-config）',
    why: () => (vendorBuilt(root) ? false : '运行时未构建，跳过'),
    async run() {
      // 重新探测：上一步刚创建/补齐了 .venv，运行期应当用 venv 里的解释器。
      const overlay = createOverlay({ root, python: detectPython({ root }) })
      try {
        const cli = path.join(root, 'vendor', 'runtime', 'apps', 'cli', 'lib', 'bin.js')
        const result = await new Promise(resolve => {
          const child = spawn(process.execPath, [cli, 'web', '--patch', overlay.path, '--dump-config'], {
            cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
          })
          let output = ''
          child.stdout.on('data', chunk => { output += chunk })
          child.stderr.on('data', chunk => { output += chunk })
          child.once('error', error => resolve({ code: 1, output: error.message }))
          child.once('exit', code => resolve({ code: code ?? 1, output }))
        })
        if (result.code !== 0) {
          throw new Error(`挂载层校验失败：\n${result.output.split('\n').slice(-25).join('\n')}`)
        }
        const lines = result.output.split('\n').filter(Boolean).length
        detail(`挂载层解析成功（${lines} 行配置输出）`)
      } finally {
        overlay.cleanup()
      }
    },
  })

  return steps
}

/**
 * 跑完整个安装计划。
 * @returns {Promise<{ installed: string[], skipped: string[], warnings: string[] }>}
 */
export async function runInstall({ root, python, force = false, log = true }) {
  const steps = buildPlan({ root, python, force })
  const ctx = {}
  const installed = []
  const skipped = []
  const warnings = []

  for (let index = 0; index < steps.length; index++) {
    const item = steps[index]
    if (log) step(index + 1, steps.length, item.title)
    let reason
    try {
      reason = item.why(ctx)
    } catch (error) {
      if (log) fail(error.message)
      throw error
    }
    if (reason) {
      if (log) skip(reason)
      skipped.push(item.id)
      continue
    }
    const startedAt = Date.now()
    const warningsBefore = ctx.warnings?.length ?? 0
    try {
      await item.run(ctx)
      if ((ctx.warnings?.length ?? 0) > warningsBefore) {
        // 步骤本身跑通了，但其中一部分可选依赖不可用：不当成"完成"来粉饰。
        if (log) skip('该步骤只有部分依赖可用，详见上面的提示')
        skipped.push(item.id)
      } else {
        if (log) ok('完成', duration(Date.now() - startedAt))
        installed.push(item.id)
      }
    } catch (error) {
      if (item.optional) {
        if (log) warn(error.message)
        warnings.push(error.message)
        continue
      }
      if (log) {
        fail(error.message)
        detail('修好上面的问题后重新运行：npm run setup')
      }
      throw error
    }
  }

  if (ctx.warnings?.length) warnings.push(...ctx.warnings)
  return { installed, skipped, warnings }
}

/** 安装前置条件自检：Node 版本不够就没有继续的意义。 */
export function preflightNode() {
  const node = detectNode()
  if (!node.ok) {
    throw new Error(`需要 Node ${node.required}，当前 ${node.version}。可用 nvm/fnm 安装：nvm install 22`)
  }
  return node
}

export { detectPython }
