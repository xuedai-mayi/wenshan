// 命令行层测试：环境探测、挂载层渲染、端口选择。零外部依赖，不碰网络也不构建运行时，
// 所以 `npm test` 在没有装过依赖的机器上也能跑。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dataFilesReady, detectPython, findFreePort, intakeInstalled, parsePythonSpec, parseTriple,
  portListening, pythonCandidates, pythonDependencies, semverGte, vendorBuilt, waitForListening,
} from '../scripts/lib/detect.mjs'
import { PLACEHOLDERS, overlayValues, renderOverlay } from '../scripts/lib/overlay.mjs'
import {
  browserCommand, buildUrls, canOpenBrowser, resolvePort,
} from '../scripts/lib/launch.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function equal(actual, expected, message) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${message}\n  期望: ${right}\n  实际: ${left}`)
}

function throws(fn, matcher, message) {
  try {
    fn()
  } catch (error) {
    if (matcher && !String(error.message).includes(matcher)) {
      throw new Error(`${message}：报错信息里没有「${matcher}」，实际是「${error.message}」`)
    }
    return
  }
  throw new Error(`${message}：没有抛错`)
}

try {
  // —— 版本解析 ——
  equal(parseTriple('v24.22.0'), [24, 22, 0], 'node 版本解析失败')
  equal(parseTriple('3.11'), [3, 11, 0], '两段版本号补零失败')
  assert(parseTriple('python') === null, '无法解析时应返回 null')
  assert(semverGte([24, 22, 0], [22, 19, 0]), '24.22 应 >= 22.19')
  assert(!semverGte([22, 18, 9], [22, 19, 0]), '22.18 不应 >= 22.19')
  assert(semverGte([3, 11, 0], [3, 11, 0]), '同版本应判定为 >=')
  assert(!semverGte([3, 9, 0], [3, 11, 0]), '3.9 不应 >= 3.11')

  // —— Python 解释器候选 ——
  equal(parsePythonSpec('py -3.11'), { cmd: 'py', args: ['-3.11'] }, '带参数的 Python 规格解析失败')
  equal(parsePythonSpec('python3.11'), { cmd: 'python3.11', args: [] }, '裸解释器解析失败')
  assert(parsePythonSpec('  ') === null, '空规格应返回 null')

  const winCandidates = pythonCandidates({}, 'win32').map(item => item.cmd)
  assert(winCandidates[0] === 'py', 'Windows 应优先 py 启动器')
  const posixCandidates = pythonCandidates({}, 'linux').map(item => `${item.cmd} ${item.args.join(' ')}`.trim())
  assert(posixCandidates.includes('python3.11'), '非 Windows 应尝试 python3.11')
  assert(posixCandidates.includes('python3'), '非 Windows 应回退 python3')
  const pinned = pythonCandidates({ WENSHAN_PYTHON: 'python3.12 -X utf8' }, 'linux')
  equal(pinned[0], { cmd: 'python3.12', args: ['-X', 'utf8'] }, 'WENSHAN_PYTHON 应能钉住解释器与参数')
  const deduped = pythonCandidates({ WENSHAN_PYTHON: 'python3' }, 'linux')
  equal(deduped.filter(item => item.cmd === 'python3').length, 1, '钉住的解释器不应重复出现')

  // —— Python 探测（注入 runner，不真的启动进程） ——
  // runner 收到的参数形如 ['-3.11', '-c', '<code>']；按「解释器 + 前置参数」做键。
  const fakeRunner = table => (cmd, args) => {
    const codeIndex = args.indexOf('-c')
    const head = codeIndex === -1 ? args : args.slice(0, codeIndex)
    const output = table[`${cmd} ${head.join(' ')}`.trim()]
    if (output === undefined) return { ok: false, stdout: '', stderr: 'ENOENT' }
    return { ok: true, stdout: output, stderr: '' }
  }
  const detected = detectPython({
    env: {}, platform: 'linux',
    runner: fakeRunner({ 'python3.11': '3.11.9', 'python3': '3.12.1' }),
  })
  assert(detected.found && detected.version === '3.11.9', '应优先选到 python3.11')
  assert(detected.preferred && detected.usable, '3.11 应标记为推荐且可用')

  const fallback = detectPython({ env: {}, platform: 'linux', runner: fakeRunner({ python3: '3.12.1' }) })
  assert(fallback.found && fallback.cmd === 'python3', '缺少 3.11 时应回退 python3')
  assert(!fallback.preferred && fallback.usable, '3.12 应标记为"可用但不推荐"')
  assert(fallback.attempts.length >= 1, '应记录失败过的候选，便于在 doctor 里解释')

  const missing = detectPython({ env: {}, platform: 'linux', runner: fakeRunner({}) })
  assert(!missing.found && missing.attempts.length >= 3, '全部缺失时应返回 found=false 与尝试记录')

  // —— 依赖探测 ——
  const deps = pythonDependencies({ found: true, cmd: 'python3', args: [] }, {
    runner: (cmd, args) => ({ ok: String(args[args.length - 1]).includes('fiona') ? false : true, stdout: 'ok', stderr: 'no module' }),
  })
  assert(deps.ready, '必需依赖齐全时应 ready=true（fiona 属于可选组）')
  assert(deps.groups.find(group => group.key === 'gis').installed === false, '可选组缺失应如实报告')
  assert(deps.groups.find(group => group.key === 'audio').installed === true, '已安装组应报告 installed')

  // —— 挂载层渲染 ——
  const templatePath = path.join(root, 'config', 'wenshan.yml')
  const template = fs.readFileSync(templatePath, 'utf8')
  for (const token of Object.values(PLACEHOLDERS)) {
    assert(template.includes(token), `配置模板缺少占位符 ${token}`)
  }

  const values = overlayValues(root, { found: true, cmd: 'python3.11', args: [] })
  assert(path.isAbsolute(values.extractorPath), '提取器路径应为绝对路径')
  assert(values.georagPlugin.startsWith('file://'), '插件应渲染为 file URL')
  const rendered = renderOverlay(template, values)
  assert(!rendered.includes('__WENSHAN_'), '渲染后不应残留占位符')
  assert(rendered.includes('"python3.11"'), 'Python 解释器应以 YAML 双引号标量注入')
  assert(rendered.includes('pythonArgs: []'), '无参数时 pythonArgs 应渲染成空序列')

  const winValues = overlayValues(root, { found: true, cmd: 'py', args: ['-3.11'] })
  const winRendered = renderOverlay(template, winValues)
  assert(winRendered.includes('["-3.11"]'), 'py -3.11 的参数应渲染成数组')

  throws(() => renderOverlay(template, { ...values, python: undefined }), '__WENSHAN_PYTHON__', '缺值应报出占位符名')
  throws(() => renderOverlay('no placeholder here', values), '缺少占位符', '模板缺占位符应报错')

  // —— 端口选择 ——
  const urls = buildUrls(3081)
  equal(urls.base, 'http://127.0.0.1:3081', 'URL 拼接失败')
  equal(buildUrls(3081, '0.0.0.0').base, 'http://127.0.0.1:3081', '绑定 0.0.0.0 时展示回环地址')

  const busy = new Set([3080, 3081])
  const probe = async port => !busy.has(port)
  equal(await resolvePort({ explicit: 3082, probe }), { port: 3082, shifted: false, explicit: true }, '显式端口空闲时应直接用')
  await resolvePort({ explicit: 3080, probe }).then(
    () => { throw new Error('显式端口被占用时应报错') },
    error => assert(error.message.includes('已被占用'), '占用报错应说明端口被占用'),
  )
  equal(await resolvePort({ probe }), { port: 3082, shifted: true, explicit: false }, '未指定端口时应顺延到第一个空闲端口')
  await resolvePort({ probe: async () => false }).then(
    () => { throw new Error('端口全被占用时应报错') },
    error => assert(error.message.includes('都被占用'), '耗尽报错应说明端口耗尽'),
  )
  equal(await findFreePort(3080, { probe }), { port: 3082, shifted: true }, 'findFreePort 应返回顺延结果')

  // —— 自动打开浏览器 ——
  equal(browserCommand('http://127.0.0.1:3080/', 'darwin'), { cmd: 'open', args: ['http://127.0.0.1:3080/'] }, 'macOS 应调用 open')
  equal(browserCommand('http://127.0.0.1:3080/', 'linux'), { cmd: 'xdg-open', args: ['http://127.0.0.1:3080/'] }, 'Linux 应调用 xdg-open')
  equal(
    browserCommand('http://127.0.0.1:3080/', 'win32'),
    { cmd: 'cmd', args: ['/c', 'start', '""', 'http://127.0.0.1:3080/'] },
    'Windows 需要用 cmd /c start 打开默认浏览器',
  )

  assert(canOpenBrowser({}, 'darwin'), '普通桌面会话应允许打开浏览器')
  assert(canOpenBrowser({ DISPLAY: ':0' }, 'linux'), '有 DISPLAY 的 Linux 应允许打开')
  assert(!canOpenBrowser({}, 'linux'), '无图形会话的 Linux 不应打开浏览器')
  assert(!canOpenBrowser({ CI: 'true' }, 'darwin'), 'CI 环境不应打开浏览器')
  assert(!canOpenBrowser({ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, 'darwin'), 'SSH 会话不应打开浏览器')
  assert(!canOpenBrowser({ WENSHAN_OPEN: '0' }, 'darwin'), 'WENSHAN_OPEN=0 应关掉自动打开')

  // —— 就绪探测：浏览器必须在端口监听之后才打开 ——
  let probes = 0
  const becomesListening = await waitForListening(3080, '127.0.0.1', {
    timeoutMs: 1000, intervalMs: 5, probe: async () => (++probes < 3),
  })
  assert(becomesListening, '端口开始监听后应返回 true')
  assert(probes >= 3, '应反复探测直到监听')
  const neverListening = await waitForListening(3080, '127.0.0.1', {
    timeoutMs: 40, intervalMs: 5, probe: async () => true,
  })
  assert(!neverListening, '超过超时仍未监听应返回 false')
  assert(await portListening(3080, '127.0.0.1', { probe: async () => false }), '探针说被占用时 portListening 应为 true')
  assert(!(await portListening(3080, '127.0.0.1', { probe: async () => true })), '探针说空闲时 portListening 应为 false')

  // —— 安装状态探测（临时目录构造各种"半装好"状态） ——
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wenshan-cli-test-'))
  try {
    assert(!vendorBuilt(fixture), '空目录不应判定为已构建')
    fs.mkdirSync(path.join(fixture, 'vendor/runtime/apps/cli/lib'), { recursive: true })
    fs.writeFileSync(path.join(fixture, 'vendor/runtime/apps/cli/lib/bin.js'), '')
    fs.writeFileSync(path.join(fixture, 'vendor/runtime/apps/cli/lib/../.keep'), '')
    assert(!vendorBuilt(fixture), '缺少 schemastery / node_modules 时不应判定为已构建')
    fs.mkdirSync(path.join(fixture, 'vendor/runtime/vendor/schemastery/lib'), { recursive: true })
    fs.writeFileSync(path.join(fixture, 'vendor/runtime/vendor/schemastery/lib/index.mjs'), '')
    fs.mkdirSync(path.join(fixture, 'vendor/runtime/node_modules'), { recursive: true })
    assert(vendorBuilt(fixture), '三件套齐全时应判定为已构建')

    assert(!intakeInstalled(fixture), '页面依赖未装时不应判定为已装')
    fs.mkdirSync(path.join(fixture, 'packages/intake/node_modules/force-graph/dist'), { recursive: true })
    fs.writeFileSync(path.join(fixture, 'packages/intake/node_modules/force-graph/dist/force-graph.min.js'), '')
    assert(intakeInstalled(fixture), 'force-graph dist 存在时应判定为已装')

    assert(!dataFilesReady(fixture).ready, '缺数据文件时 ready 应为 false')
    fs.mkdirSync(path.join(fixture, 'data'), { recursive: true })
    for (const file of ['site_data.json', 'graph_data.json', 'days_data.json', 'map_data.json', 'photos_index.json']) {
      fs.writeFileSync(path.join(fixture, 'data', file), '{}')
    }
    equal(dataFilesReady(fixture), { ready: true, missing: [] }, '数据齐全时应 ready=true')
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }

  // —— 业务包对内置运行时的相对引用 ——
  // 这些 import 写错一级目录时不会在测试期暴露，只有真正启动那一刻才炸（曾经就是这样）。
  const vendorRefs = ['packages/agent/src/index.js', 'packages/georag/src/index.js', 'packages/agent/src/tools.js']
  for (const file of vendorRefs) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    for (const match of source.matchAll(/from '(\.[^']+)'/g)) {
      const target = path.resolve(path.dirname(path.join(root, file)), match[1])
      assert(fs.existsSync(target), `${file} 引用的 ${match[1]} 不存在（解析为 ${target}）`)
    }
  }

  console.log('命令行测试通过：环境探测、挂载层渲染、端口顺延、浏览器就绪判定、安装状态与 vendor 引用')
} catch (error) {
  console.error(`命令行测试失败：${error.message}`)
  process.exit(1)
}
