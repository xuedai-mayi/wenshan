// 问山 · 产品挂载层（config/wenshan.yml）的占位符渲染。
//
// 挂载层是模板：插件路径、提取器路径、Python 解释器都在启动时按真实环境注入，
// 因此同一份仓库在 Windows / macOS / Linux、py -3.11 或 python3.12 上都能直接跑，
// 不需要改配置也不需要 bat 里的字符串拼接。
//
// 注入值一律用 JSON 编码：JSON 字符串就是合法的 YAML 双引号标量，JSON 数组就是
// 合法的 YAML 流式序列，不必再手写转义规则。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { RUNTIME_CLI } from './detect.mjs'

/** 模板里必须被替换的占位符，缺一个就说明配置和启动器已经不同步。 */
export const PLACEHOLDERS = {
  georagPlugin: '__WENSHAN_GEORAG_PLUGIN__',
  intakePlugin: '__WENSHAN_INTAKE_PLUGIN__',
  extractorPath: '__WENSHAN_EXTRACTOR_PATH__',
  python: '__WENSHAN_PYTHON__',
  pythonArgs: '__WENSHAN_PYTHON_ARGS__',
}

/**
 * 渲染挂载层。
 * @param {string} template config/wenshan.yml 原文
 * @param {Record<string, string|string[]>} values 占位符 → 值
 * @returns {string} 可直接交给运行时 --patch 的 YAML
 */
export function renderOverlay(template, values) {
  let output = template
  for (const [key, token] of Object.entries(PLACEHOLDERS)) {
    if (!template.includes(token)) throw new Error(`挂载层模板缺少占位符 ${token}（${key}）`)
    const value = values[key]
    if (value === undefined || value === null || value === '') {
      throw new Error(`没有为占位符 ${token} 提供值（${key}）`)
    }
    output = output.replaceAll(token, JSON.stringify(value))
  }
  const leftover = output.match(/__WENSHAN_[A-Z_]+__/g)
  if (leftover) throw new Error(`挂载层仍残留未替换的占位符：${[...new Set(leftover)].join('、')}`)
  return output
}

/** 探测结果 → 占位符取值。Python 缺失时给平台默认值，让启动先跑起来（只有提取会降级）。 */
export function overlayValues(root, python) {
  const pythonCmd = python?.found ? python.cmd : (process.platform === 'win32' ? 'py' : 'python3')
  const pythonArgs = python?.found ? python.args : (process.platform === 'win32' ? ['-3.11'] : [])
  return {
    georagPlugin: pathToFileURL(path.join(root, 'packages', 'georag', 'src', 'index.js')).href,
    intakePlugin: pathToFileURL(path.join(root, 'packages', 'intake', 'src', 'index.js')).href,
    extractorPath: path.join(root, 'scripts', 'extract_source.py'),
    python: pythonCmd,
    pythonArgs,
  }
}

/**
 * 生成临时 overlay 文件。调用方负责调 cleanup()（进程退出兜底也会清）。
 * @returns {{ path: string, cleanup: () => void, content: string }}
 */
export function createOverlay({ root, python, keep = false }) {
  const templatePath = path.join(root, 'config', 'wenshan.yml')
  const template = fs.readFileSync(templatePath, 'utf8')
  const content = renderOverlay(template, overlayValues(root, python))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wenshan-overlay-'))
  const overlayPath = path.join(directory, 'wenshan.patch.yml')
  fs.writeFileSync(overlayPath, content, 'utf8')
  const cleanup = () => {
    if (keep) {
      process.stdout.write(`  overlay 已保留：${overlayPath}\n`)
      return
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
  return { path: overlayPath, cleanup, content }
}

export async function validateOverlay({ root, python }) {
  const overlay = createOverlay({ root, python })
  try {
    return await new Promise(resolve => {
      const args = [path.join(root, RUNTIME_CLI), 'web', '--patch', overlay.path, '--dump-config']
      const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
      child.once('error', error => resolve({ code: 1, output: error.message }))
      child.once('close', code => resolve({ code: code ?? 1, output }))
    })
  } finally {
    overlay.cleanup()
  }
}
