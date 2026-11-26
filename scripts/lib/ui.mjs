// 问山 · 终端输出：颜色、步骤、检查表。
// 零依赖；NO_COLOR / 非 TTY 时自动降级为纯文本，Windows 10+ 默认终端支持 ANSI。

const colorEnabled = process.env.NO_COLOR == null
  && process.env.TERM !== 'dumb'
  && process.env.FORCE_COLOR !== '0'
  && Boolean(process.stdout.isTTY)

const paint = code => text => (colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : String(text))

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
}

/** 产品标题块：只画左边框，中英文混排也不会错位。 */
export function banner(title, lines = []) {
  process.stdout.write(`\n${c.cyan('┌')} ${c.bold(title)}\n`)
  for (const line of lines) {
    process.stdout.write(`${c.cyan('│')} ${line}\n`)
  }
  process.stdout.write(`${c.cyan('└')}\n\n`)
}

/** 阶段标题，例如 `[2/5] 构建内置运行时`。 */
export function step(index, total, title) {
  process.stdout.write(`\n${c.cyan(`[${index}/${total}]`)} ${c.bold(title)}\n`)
}

export function ok(message, extra = '') {
  process.stdout.write(`  ${c.green('✓')} ${message}${extra ? c.dim(` ${extra}`) : ''}\n`)
}

export function skip(message) {
  process.stdout.write(`  ${c.dim('·')} ${c.dim(message)}\n`)
}

export function warn(message) {
  process.stdout.write(`  ${c.yellow('!')} ${message}\n`)
}

export function fail(message) {
  process.stdout.write(`  ${c.red('✗')} ${message}\n`)
}

export function detail(message) {
  process.stdout.write(`    ${c.dim(message)}\n`)
}

/** 等宽两列表格：用于 doctor 的检查清单。 */
export function table(rows, { indent = '  ' } = {}) {
  const width = Math.max(0, ...rows.map(row => row[0].length))
  for (const [name, value] of rows) {
    process.stdout.write(`${indent}${name.padEnd(width)}  ${value}\n`)
  }
}

/** 把毫秒说成人能读的时长。 */
export function duration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`
}

export function bullet(message) {
  process.stdout.write(`  ${c.dim('•')} ${message}\n`)
}
