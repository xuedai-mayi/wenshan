#!/usr/bin/env node
// 问山 · 统一命令行入口。
//
//   npm start           启动（未安装时会先引导安装）
//   npm run setup       安装：构建内置运行时 + 页面依赖 + 提取依赖 + 校验挂载层
//   npm run doctor      环境体检
//   npm run data        从原始资料重建 data/*.json
//   npm run terrain     生成地形晕渲底图
//   npm run eval        152 题检索消融评测
//   npm test            单元测试
//   npm run preflight   发布前自检
//   npm run backup      备份知识库与运行状态
//   npm run restore     从备份恢复
//   npm run health      探活运行中的服务
//
// 也可以 npm link 之后直接用 `wenshan <command>`。运行时自己的参数用 `--` 之后的
// 内容透传，例如 `npm start -- --trusted-host dev.internal:3080`。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cmdBackup, cmdData, cmdDoctor, cmdEval, cmdHealth, cmdInstall, cmdPreflight, cmdRestore,
  cmdStart, cmdTerrain, cmdTest,
} from '../scripts/lib/commands.mjs'
import { DEFAULT_HOST } from '../scripts/lib/launch.mjs'
import { c } from '../scripts/lib/ui.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const COMMANDS = {
  start: cmdStart,
  install: cmdInstall,
  doctor: cmdDoctor,
  data: cmdData,
  terrain: cmdTerrain,
  eval: cmdEval,
  test: cmdTest,
  preflight: cmdPreflight,
  backup: cmdBackup,
  restore: cmdRestore,
  health: cmdHealth,
}

const ALIASES = {
  web: 'start',
  serve: 'start',
  run: 'start',
  setup: 'install',
  check: 'doctor',
  status: 'doctor',
  'build-data': 'data',
  'build-terrain': 'terrain',
  snapshot: 'backup',
  recover: 'restore',
  ping: 'health',
}

const HELP = `
${c.bold('wenshan')} — 问山：地理野外实习自成长知识图谱智能体

用法
  wenshan [start] [选项] [-- 运行时参数]   启动 web 服务并自动打开浏览器（省略 start 亦可）
  wenshan install                       安装依赖并校验配置（别名 setup）
  wenshan doctor                        环境体检
  wenshan data                          从原始资料重建 data/*.json
  wenshan terrain                       生成地形晕渲底图
  wenshan eval                          检索消融评测
  wenshan test                          测试
  wenshan preflight                     发布前自检
  wenshan backup [目录] [--data-only]   备份知识库与运行状态（默认写入 backups/）
  wenshan restore <备份文件> [--dry-run] 从备份恢复（会先给现状留副本）
  wenshan health [--url URL] [--json]   探活运行中的服务

仓库内可用 npm run <命令>，例如 npm start -- --port 3081。
测试入口：npm test 跑单元测试，npm run test:integration 跑集成测试，
wenshan test 在运行时已构建时运行两组。

选项
  -p, --port <port>       监听端口，默认 ${3080}；被占用时自动顺延
      --host <host>       监听地址，默认 ${DEFAULT_HOST}
  -y, --yes               非交互：自动确认安装
  -f, --force             忽略"已完成"标记，重跑安装步骤
      --dry-run           只打印渲染后的挂载层与启动命令，不真的启动
      --keep-overlay      保留临时挂载层文件，便于排查
      --no-open           不自动打开浏览器（服务照常启动）
      --open              强制尝试打开浏览器（覆盖 CI / SSH 检测）
  -h, --help              显示帮助
  -V, --version           显示版本

示例
  wenshan                                 起服务并打开浏览器（等价 wenshan start）
  npm start                              仓库内同样起服务，首次运行会询问是否安装
  wenshan start --port 3081              换端口（全局链接后无需 npm run）
  wenshan start --port 0                 让系统分配端口
  wenshan doctor                         看环境缺什么
  wenshan backup                         备份到 backups/
  wenshan backup ~/wenshan-backups --data-only   只备份知识库，不含凭据
  wenshan health                         看服务是否健康
  WENSHAN_PYTHON=python3.12 wenshan doctor   钉住 Python 解释器
`

function parseArgv(argv) {
  const options = {
    port: undefined, host: undefined, yes: false, force: false, dryRun: false,
    keepOverlay: false, open: true,
  }
  const passthrough = []
  let command = null
  let help = false
  let version = false

  const takeValue = (token, index, inline) => {
    if (inline !== undefined) return { value: inline, next: index }
    const next = argv[index + 1]
    if (next === undefined) throw new Error(`${token} 缺少取值`)
    return { value: next, next: index + 1 }
  }

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--') {
      passthrough.push(...argv.slice(index + 1))
      break
    }
    if (token === '-h' || token === '--help') { help = true; continue }
    if (token === '-V' || token === '--version') { version = true; continue }
    if (token === '-y' || token === '--yes') { options.yes = true; continue }
    if (token === '-f' || token === '--force') { options.force = true; continue }
    if (token === '--dry-run') { options.dryRun = true; continue }
    if (token === '--keep-overlay') { options.keepOverlay = true; continue }
    if (token === '--open') { options.open = true; continue }
    if (token === '--no-open') { options.open = false; continue }

    if (token.startsWith('--port=') || token === '--port' || token === '-p') {
      const inline = token.startsWith('--port=') ? token.slice('--port='.length) : undefined
      const taken = takeValue(token, index, inline)
      options.port = Number(taken.value)
      index = taken.next
      continue
    }
    if (token.startsWith('--host=') || token === '--host') {
      const inline = token.startsWith('--host=') ? token.slice('--host='.length) : undefined
      const taken = takeValue(token, index, inline)
      options.host = taken.value
      index = taken.next
      continue
    }
    if (token.startsWith('-')) { passthrough.push(token); continue }
    if (command === null) { command = ALIASES[token] ?? token; continue }
    passthrough.push(token)
  }

  return { command: command ?? 'start', options, passthrough, help, version }
}

async function main() {
  let parsed
  try {
    parsed = parseArgv(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${c.red('参数错误：')}${error.message}\n`)
    return 2
  }

  if (parsed.version) {
    process.stdout.write(`wenshan ${pkg.version}\n`)
    return 0
  }
  if (parsed.help || parsed.command === 'help') {
    process.stdout.write(`${HELP}\n`)
    return 0
  }

  const run = COMMANDS[parsed.command]
  if (!run) {
    process.stderr.write(`${c.red('未知命令：')}${parsed.command}\n用 npm start -- --help 看运行时自己的参数，或 wenshan --help 看问山的命令。\n`)
    return 2
  }

  try {
    return await run({ root, options: parsed.options, passthrough: parsed.passthrough })
  } catch (error) {
    process.stderr.write(`\n${c.red('✗')} ${error?.message ?? error}\n`)
    return 1
  }
}

main().then(code => {
  process.exitCode = code ?? 0
}, error => {
  process.stderr.write(`\n${c.red('✗')} ${error?.stack ?? error}\n`)
  process.exitCode = 1
})
