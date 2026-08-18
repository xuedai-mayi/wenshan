// dsh-wenshan · 冒烟测试：在真实 cordis 上下文里挂载 georag + wenshan，
// 断言六工具 schema 已注册、执行返回通过 schema 校验的 canonical 值。
// 运行：在 实习向导/dsh-wenshan 下 node test-smoke.mjs
import { fileURLToPath } from 'node:url'
import { Context } from '../deepseek-harness-master/deepseek-harness-master/vendor/cordis/lib/index.js'
import SystemPrompt from '../deepseek-harness-master/deepseek-harness-master/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../deepseek-harness-master/deepseek-harness-master/packages/core/tools/lib/index.js'
import { CallId } from '../deepseek-harness-master/deepseek-harness-master/packages/llm/llm/lib/index.js'
import * as georag from '../dsh-georag/src/index.js'
import * as wenshan from './src/index.js'

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(georag, { dataDir: fileURLToPath(new URL('../data', import.meta.url)) })
await ctx.plugin(wenshan)

const names = ctx.tools.schemas().map(s => s.name)
console.log('注册工具:', names.join(', '))
const want = ['retrieve', 'read_note', 'neighbors', 'locate', 'weather', 'itinerary']
const missing = want.filter(n => !names.includes(n))
if (missing.length) {
  console.error('缺失工具:', missing.join(', '))
  process.exit(1)
}

let callCounter = 0
async function call(name, args) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`smoke-${++callCounter}`),
    name,
    arguments: args,
  })
}

// 先取一个真实笔记 id
const probe = await call('retrieve', { query: '含鄱口看云' })
const noteId = probe.value?.hits?.[0]?.ref

const cases = [
  ['retrieve', { query: '庐山的土壤类型有哪些' }],
  ['read_note', noteId ? { id: noteId } : { id: 'no-such-id' }],
  ['neighbors', noteId ? { id: noteId } : { id: 'no-such-id' }],
  ['locate', { lon: 115.99, lat: 29.56 }],
  ['weather', {}],
  ['itinerary', { date: '7.9' }],
]

let failed = 0
for (const [name, args] of cases) {
  try {
    const r = await call(name, args)
    if (r.isError) {
      console.error(`✗ ${name} isError:`, textOf(r))
      failed++
      continue
    }
    const v = r.value
    const note = v?.error ? `（业务错误: ${String(v.error).slice(0, 60)}）` : ''
    console.log(`✓ ${name}${note} → ${brief(v)}`)
  } catch (e) {
    console.error(`✗ ${name} 抛异常:`, e?.message ?? e)
    failed++
  }
}

function textOf(r) {
  return (r.content || []).map(b => b.text ?? '').join('').slice(0, 120)
}
function brief(v) {
  if (!v) return '空'
  if (v.hits) return `${v.hits.length} 条命中`
  if (v.days) return `${v.days.length} 天`
  if (v.neighbors) return `${v.count} 关联`
  if (v.text != null) return `《${v.title}》${v.text.length} 字`
  if (v.coord) return `地质=${v.geology?.unit ?? '—'} 土壤=${v.soil ?? '—'} 植被=${v.vegetation ?? '—'}`
  return 'ok'
}

console.log(failed ? `\n${failed} 个失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
