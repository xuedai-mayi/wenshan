// 问山 · 启动：解析端口 → 渲染挂载层 → 拉起内置运行时的 web 面。
// 与安装解耦：这里只负责「起得来」，缺依赖时给出可执行的下一步。

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createOverlay } from './overlay.mjs'
import { findFreePort, portFree, waitForListening } from './detect.mjs'
import { banner, bullet, c, fail, warn } from './ui.mjs'

export const DEFAULT_PORT = 3080
export const DEFAULT_HOST = '127.0.0.1'
/** 产品默认界面语言：中文。可用 WENSHAN_LOCALE=en 改默认值。 */
export const DEFAULT_LOCALE = 'zh'

/**
 * 运行时状态目录（会话、凭据、profile、存储）。
 *
 * 默认放在仓库内的 `.wenshan-home`，而不是共享用户主目录：内置运行时是随包分发的快照，
 * 状态格式与系统里其它服务未必兼容（实测旧快照会拒绝新版写出的 credentials.yaml），
 * 共享目录会让「问山起不来」变成别人的问题。隔离之后这个目录删掉即可重置，
 * 也不会和同机 3080 上跑着的其它服务互相污染。
 *
 * 覆盖用 `WENSHAN_HOME`。启动器只为本进程设置运行时读取的状态变量，不继承宿主的值：
 * 否则从别的 agent 会话里启动问山时，宿主的状态目录会泄漏进来，两个产品又绑回同一目录。
 */
export function resolveHome(root, env = process.env) {
  return env.WENSHAN_HOME ?? path.join(root, '.wenshan-home')
}

/**
 * 首次启动写给运行时的默认语言偏好。
 *
 * 运行时的界面语言默认跟随浏览器；浏览器是英文环境时，教师会看到英文界面。
 * 问山面向中文教学场景，所以首次启动在 `.wenshan-home/settings.yaml` 里写一条
 * `locale.preference`。已经存在的偏好（教师自己切过语言）不动。
 */
export function preferredLocale(env = process.env) {
  const raw = String(env.WENSHAN_LOCALE || '').trim().toLowerCase()
  return raw === 'en' ? 'en' : DEFAULT_LOCALE
}

/**
 * 在状态目录里补一条语言偏好，保留文件里的其它设置。
 * @returns {{file: string, changed: boolean, reason: string}}
 */
export function ensureLocalePreference(home, locale = DEFAULT_LOCALE) {
  const file = path.join(home, 'settings.yaml')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (/^\s*locale\s*:/m.test(text)) return { file, changed: false, reason: '已有语言设置' }
  const block = `locale:\n  preference: ${locale}\n`
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(file, text.trim() ? `${text.replace(/\s*$/, '')}\n\n${block}` : block, { mode: 0o600 })
  return { file, changed: true, reason: `默认语言 ${locale}` }
}

/** 对外展示的入口地址。绑定 0.0.0.0 时给人看的仍是回环地址。 */
export function buildUrls(port, host = DEFAULT_HOST) {
  const shown = host === '0.0.0.0' || host === '::' ? DEFAULT_HOST : host
  const base = `http://${shown}:${port}`
  return {
    base,
    graph: `${base}/wenshan/knowledge-graph`,
    galaxy: `${base}/wenshan/knowledge-galaxy`,
    photoMap: `${base}/wenshan/photo-map`,
  }
}

/**
 * 各平台「用默认浏览器打开 URL」的命令。抽成纯函数，测试里直接断言，不必真的开窗口。
 * Windows 走 `cmd /c start "" <url>`：空标题占位不能省，否则带引号的 URL 会被当成窗口标题。
 */
export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', url] }
  if (platform === 'darwin') return { cmd: 'open', args: [url] }
  return { cmd: 'xdg-open', args: [url] }
}

/**
 * 当前环境能不能自动开浏览器：CI、SSH 会话、无图形会话的 Linux 都不该弹窗。
 * 可用 WENSHAN_OPEN=0 全局关掉。
 */
export function canOpenBrowser(env = process.env, platform = process.platform) {
  if (env.WENSHAN_OPEN === '0' || env.WENSHAN_OPEN === 'false') return false
  if (env.CI === 'true' || env.CI === '1') return false
  if (env.SSH_CONNECTION || env.SSH_TTY) return false
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false
  return true
}

/** 用系统默认浏览器打开 URL；失败只提示，不影响服务。 */
export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const { cmd, args } = browserCommand(url, platform)
  try {
    const child = spawnImpl(cmd, args, { stdio: 'ignore', detached: true })
    child.on?.('error', () => {})
    child.unref?.()
    return true
  } catch {
    return false
  }
}

/**
 * 选监听端口。
 * 显式指定则尊重用户：被占用就报错，不偷偷换端口。
 * 未指定则从 3080 顺延：同机常有其它 agent 服务占着 3080。
 */
export async function resolvePort({ explicit, host = DEFAULT_HOST, probe = portFree }) {
  if (explicit != null) {
    const port = Number(explicit)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`端口不合法：${explicit}`)
    if (port !== 0 && !(await probe(port, host))) {
      throw new Error(`端口 ${port} 已被占用。换一个：npm start -- --port ${port + 1}`)
    }
    return { port, shifted: false, explicit: true }
  }
  const found = await findFreePort(DEFAULT_PORT, { host, probe })
  if (found.port == null) throw new Error(`从 ${DEFAULT_PORT} 起的 20 个端口都被占用了，请用 --port 指定`)
  return { ...found, explicit: false }
}

/**
 * 启动运行时。
 * @returns {Promise<number>} 退出码
 */
export async function launch({
  root, python, port, host, passthrough = [], dryRun = false, overlayKeep = false, open = true,
}) {
  const home = resolveHome(root)
  const cliPath = path.join(root, 'runtime', 'apps', 'cli', 'lib', 'bin.js')
  const overlay = createOverlay({ root, python, keep: overlayKeep })
  const args = [cliPath, 'web', '--patch', overlay.path]
  if (port != null) args.push('--port', String(port))
  if (host && host !== DEFAULT_HOST) args.push('--host', host)
  args.push(...passthrough)

  const urls = buildUrls(port ?? DEFAULT_PORT, host)

  if (dryRun) {
    process.stdout.write(`${c.dim('$')} node ${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}\n`)
    process.stdout.write(`\n${c.dim('— 渲染后的挂载层 —')}\n${overlay.content}\n`)
    overlay.cleanup()
    return 0
  }

  banner('问山 · 地理野外实习自成长知识助手', [
    `主界面    ${urls.base}/`,
    `知识图谱  ${urls.graph}`,
    `照片地图  ${urls.photoMap}`,
    `知识星系  ${urls.galaxy}`,
  ])
  bullet(python?.found
    ? `Python ${python.version}（${python.cmd}）负责文档 / 音频 / GIS 提取`
    : '未找到 Python：只能收录纯文本，其余格式提取会降级')
  bullet(`运行状态目录 ${path.relative(root, home) || home}（删掉即重置，不与其它服务共用）`)
  bullet(`首次使用请在 ${c.bold('设置 > 模型')} 里配置模型与 API Key`)
  bullet('按 Ctrl+C 停止服务')
  process.stdout.write('\n')

  fs.mkdirSync(home, { recursive: true })
  try {
    ensureLocalePreference(home, preferredLocale())
  } catch (error) {
    warn(`没有写入默认语言偏好：${error instanceof Error ? error.message : error}`)
  }
  // 运行时按自己的契约读取状态目录变量；对产品层只暴露 WENSHAN_HOME。
  const env = { ...process.env, DSH_HOME: home }
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' })

  let cleaned = false
  const finish = () => {
    if (cleaned) return
    cleaned = true
    overlay.cleanup()
  }

  const forward = signal => {
    if (!child.killed) child.kill(signal)
  }
  const onInt = () => forward('SIGINT')
  const onTerm = () => forward('SIGTERM')
  process.once('SIGINT', onInt)
  process.once('SIGTERM', onTerm)
  process.once('exit', finish)

  // 服务真正开始监听之后再开浏览器：先开的话浏览器会撞上「无法访问此网站」。
  const wantsBrowser = open !== false && port !== 0
  if (wantsBrowser) bullet('服务就绪后自动打开浏览器（--no-open 关闭）')
  const ready = wantsBrowser
    ? waitForListening(port ?? DEFAULT_PORT, host ?? DEFAULT_HOST).then(listening => {
      if (!listening) {
        warn('服务在 30 秒内没有开始监听，暂不打开浏览器')
        return
      }
      if (!canOpenBrowser()) {
        bullet('未自动打开浏览器（CI / SSH / 无图形会话），请手动访问上面的地址')
        return
      }
      if (openBrowser(urls.base)) bullet(`已在默认浏览器打开 ${urls.base}`)
      else bullet(`未能自动打开浏览器，请手动访问 ${urls.base}`)
    })
    : Promise.resolve()
  if (open !== false && port === 0) bullet('端口由系统分配，未自动打开浏览器；实际地址见运行时的输出')

  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)))
    })
    ready.catch(() => {})
    finish()
    if (code !== 0) fail(`运行时装载失败（退出码 ${code}）。若是首次运行，先执行：npm run setup`)
    return code
  } catch (error) {
    finish()
    if (error?.code === 'ENOENT' || String(error?.message).includes('bin.js')) {
      warn('内置运行时还没构建，先执行：npm run setup')
    }
    fail(String(error?.message ?? error))
    return 1
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
    process.off('exit', finish)
  }
}
