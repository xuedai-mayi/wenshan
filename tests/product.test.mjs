import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '../vendor/runtime/vendor/cordis/lib/index.js'
import SystemPrompt from '../vendor/runtime/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../vendor/runtime/packages/core/tools/lib/index.js'
import { CallId } from '../vendor/runtime/packages/llm/llm/lib/index.js'
import { buildPhotoMapData } from '../packages/intake/src/index.js'
import * as georag from '../packages/georag/src/index.js'
import * as wenshan from '../packages/agent/src/index.js'

const dataDir = fileURLToPath(new URL('../data', import.meta.url))
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wenshan-product-test-'))
for (const file of ['site_data.json', 'graph_data.json', 'days_data.json', 'map_data.json', 'photos_index.json']) {
  fs.copyFileSync(path.join(dataDir, file), path.join(fixture, file))
}

let counter = 0
const execute = (ctx, name, args) => ctx.tools.execute({
  signal: new AbortController().signal,
  callId: CallId(`product-${++counter}`),
  name,
  arguments: args,
})

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function context(mode) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(georag, { dataDir: fixture })
  await ctx.plugin(wenshan, { mode })
  return ctx
}

try {
  const build = await context('build')
  const buildNames = build.tools.schemas().map(schema => schema.name)
  assert(buildNames.includes('publish_knowledge_draft'), '建库模式缺少发布工具')
  assert(buildNames.includes('retrieve'), '建库模式缺少查重检索工具')

  const captured = await execute(build, 'capture_source_text', {
    name: '产品链路测试记录',
    text: '青岚岭北坡观察点位于东经116.123、北纬29.456。该点可见测试砂岩层，野外记录把它命名为青岚层。青岚层与北坡观察点直接关联。',
  })
  assert(!captured.isError && captured.value?.source?.id, '来源保存失败')
  const sourceId = captured.value.source.id

  const created = await execute(build, 'create_knowledge_draft', {
    title: '青岚岭测试草稿',
    summary: '从测试记录提取一个地点和一个概念。',
    sourceIds: [sourceId],
    nodes: [
      {
        title: '青岚岭北坡观察点',
        kind: '讲解点',
        content: '记录给出该观察点的经纬度，并指出现场可见测试砂岩层，是本批资料中的野外讲解位置。',
        relations: ['青岚层'],
        coordinate: [116.123, 29.456],
      },
      {
        title: '青岚层',
        kind: '概念',
        content: '本次产品链路测试资料将观察到的测试砂岩层命名为青岚层，并把它与北坡观察点建立直接关联。',
        relations: ['青岚岭北坡观察点'],
      },
    ],
  })
  assert(!created.isError && created.value?.draft?.id, '草稿创建失败')
  const draftId = created.value.draft.id

  const denied = await execute(build, 'publish_knowledge_draft', { draftId, confirmation: '可以发布' })
  assert(denied.value?.error?.includes('明确发送'), '非精确确认口令没有被拒绝')

  const published = await execute(build, 'publish_knowledge_draft', { draftId, confirmation: `确认发布 ${draftId}` })
  assert(!published.isError && published.value?.publishedNodes === 2, '草稿发布失败')
  assert(build.lushanData.engine.nodeById['learned-70c6c425bedb3222'] || build.lushanData.engine.stats.nodes === 253, '图谱没有热更新')

  const hotSearch = await execute(build, 'retrieve', { query: '青岚层是什么' })
  assert(hotSearch.value?.hits?.some(hit => hit.title === '青岚层'), '发布后未能立即检索到新节点')
  await build.fiber.dispose()

  const qa = await context('qa')
  const qaNames = qa.tools.schemas().map(schema => schema.name)
  assert(qaNames.includes('retrieve'), '问答模式缺少检索工具')
  assert(!qaNames.includes('capture_source_text'), '问答模式泄露了来源写入工具')
  assert(!qaNames.includes('publish_knowledge_draft'), '问答模式泄露了发布工具')
  assert(qaNames.includes('report_knowledge_gap'), '问答模式缺少知识缺口登记工具')
  assert(!qaNames.includes('resolve_knowledge_gap'), '问答模式泄露了缺口处理工具')
  const replaySearch = await execute(qa, 'retrieve', { query: '青岚岭北坡观察点' })
  assert(replaySearch.value?.hits?.some(hit => hit.title === '青岚岭北坡观察点'), '重启重放后未检索到已发布节点')
  assert(qa.lushanData.knowledge.stats().events === 3, '事件日志数量不符合预期')

  // 知识缺口闭环：野外助教登记（重复问法去重累计）→ 知识演化查看并销掉
  const gapFirst = await execute(qa, 'report_knowledge_gap', {
    question: '青岚岭有没有冰川擦痕？',
    note: '已检索"冰川擦痕/冰川遗迹"，无结果',
  })
  assert(!gapFirst.isError && gapFirst.value?.gap?.status === 'open', '缺口登记失败')
  const gapAgain = await execute(qa, 'report_knowledge_gap', { question: '青岚岭有没有冰川擦痕' })
  assert(gapAgain.value?.gap?.id === gapFirst.value.gap.id, '同一问题的不同标点写法没有归并')
  assert(gapAgain.value?.gap?.count === 2, '重复上报没有累计次数')
  await qa.fiber.dispose()

  const build2 = await context('build')
  const build2Names = build2.tools.schemas().map(schema => schema.name)
  assert(build2Names.includes('list_knowledge_gaps') && build2Names.includes('resolve_knowledge_gap'), '建库模式缺少缺口待办工具')
  assert(!build2Names.includes('report_knowledge_gap'), '建库模式不应有缺口登记工具')
  const gapList = await execute(build2, 'list_knowledge_gaps', {})
  assert(gapList.value?.count === 1 && gapList.value.gaps[0].count === 2, '重放后缺口待办不符合预期')
  const resolved = await execute(build2, 'resolve_knowledge_gap', {
    gapId: gapList.value.gaps[0].id,
    resolution: '测试：由青岚岭草稿覆盖',
    draftId,
  })
  assert(!resolved.isError && resolved.value?.gap?.status === 'resolved', '缺口未能标记解决')
  const gapListAfter = await execute(build2, 'list_knowledge_gaps', {})
  assert(gapListAfter.value?.count === 0, '已解决缺口仍出现在待办里')
  assert(build2.lushanData.knowledge.stats().events === 6, '缺口事件没有落盘')

  // 照片地图数据：讲解点坐标、照片索引与底图图层齐备
  const photoMap = buildPhotoMapData(build2.lushanData)
  assert(Array.isArray(photoMap.bounds) && photoMap.bounds.length === 4, '照片地图缺少范围')
  assert(photoMap.stats.points > 0 && photoMap.stats.photos > 0, '照片地图没有讲解点或照片')
  assert(photoMap.days.every(day => day.points.every(point => Array.isArray(point.coord))), '照片地图混入了无坐标讲解点')
  assert(Array.isArray(photoMap.layers.water) && Array.isArray(photoMap.layers.roads), '照片地图缺少底图图层')
  await build2.fiber.dispose()

  console.log('产品链路测试通过：来源、草稿、确认门禁、发布热更新、事件重放、问答只读隔离、知识缺口闭环、照片地图数据均正常')
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
