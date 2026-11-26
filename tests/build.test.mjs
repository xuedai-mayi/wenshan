// 自动构建测试：假的模型服务 + 真的 KnowledgeStore，验证「上传资料 → 抽取出草稿」这条链路。
//
// 关键点：这里不接任何真实模型，但走的是和线上完全相同的代码路径
// （分块 → 逐块调用 → JSON 解析 → 校验合并 → 与基础图谱对账 → createDraft）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createBuilder, splitSource, capChunks, parseExtraction, salvageTruncated,
  normalizeItems, mergeEdges, reconcile, draftPayloads, titleKey,
} from '../packages/georag/src/build.js'
import { KnowledgeStore } from '../packages/georag/src/knowledge-store.js'

const fail = (message) => { throw new Error(message) }
const check = (ok, message) => { if (!ok) fail(message) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wenshan-build-test-'))
try {
  // —— 基础图谱：用于对账（只有「芦林湖」这一个已知地点） ——
  fs.writeFileSync(path.join(root, 'graph_data.json'), JSON.stringify({
    nodes: [{ id: '芦林湖', t: '芦林湖', k: '地点', md: '# 芦林湖\n\n## 资料整理\n已有的湖盆描述。' }],
  }))

  const store = new KnowledgeStore(root)

  // —— 纯函数部分 ——
  const longText = Array.from({ length: 12 }, (_, i) =>
    `## 第 ${i + 1} 节\n芦林湖第 ${i + 1} 处剖面出露灰白色泥砾，砾石磨圆度差，可见擦痕砾，属冰川堆积。`).join('\n\n')
  const chunks = splitSource(longText, { maxChars: 400 })
  check(chunks.length >= 2, `分块过少：${chunks.length}`)
  check(chunks.every(chunk => chunk.trim().length > 0), '出现空块')
  check(chunks.every(chunk => chunk.length <= 460), '单块明显超过上限')
  check(chunks.join('').replace(/\s/g, '').length === longText.replace(/\s/g, '').length, '分块丢字')
  check(capChunks(chunks, 2).chunks.length === 2, 'capChunks 没有按上限抽样')

  check(parseExtraction('前废话 ```json\n{"items":[],"edges":[]}\n``` 后废话').items.length === 0, '围栏解析失败')
  check(parseExtraction('{"items":[{"kind":"概念"}],"edges":[]}').items.length === 1, '正常解析失败')
  check(parseExtraction('{"items":[{"kind":"概念"},],"edges":[],}').items.length === 1, '尾随逗号修补失败')
  check(parseExtraction('{"items":[').error !== undefined, '截断输出应报错')
  check(parseExtraction('没有 JSON').error !== undefined, '无 JSON 应报错')
  const truncated = '{"items":[{"kind":"概念","title":"甲","content":"一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十"},{"kind":"概念","title":"乙","content":"被截断的'
  const salvaged = salvageTruncated(truncated)
  check(salvaged?.items.length === 1, `截断抢救应救回 1 条，实际 ${salvaged?.items.length}`)
  check(salvageTruncated('{}') === undefined, '无 items 时不应抢救')

  const { nodes, dropped } = normalizeItems([
    { kind: '讲解点', title: '芦林湖冰碛剖面', content: '剖面出露灰白色泥砾，砾石磨圆度差，可见擦痕砾。'.padEnd(30, '正文'), coordinate: [115.97, 29.55], altitude: '1040m' },
    { kind: '讲解点', title: '芦林湖冰碛剖面', content: '第二次抽取的更长正文，描述泥砾层的杂基支撑结构，长度明显超过第一次。' },
    { kind: '概念', title: '短', content: '太短的标题会被丢掉，这条应该被丢弃。' },
    { kind: '不存在', title: '非法类型', content: '这个 kind 不在七类白名单里，应该被丢弃掉。' },
  ])
  check(nodes.length === 1, `合并后应只剩 1 个节点，实际 ${nodes.length}`)
  check(nodes[0].coordinate?.[0] === 115.97, '坐标没有保留')
  check(nodes[0].altitude === 1040, '带单位的海拔没有被解析')
  check(nodes[0].content.includes('杂基支撑'), '合并没有取更长的正文')
  check(dropped.length === 2, `应丢弃 2 条，实际 ${dropped.length}`)

  mergeEdges(nodes, [{ from: '芦林湖冰碛剖面', to: '芦林湖', type: '位于' }])
  check(nodes[0].relations.includes('芦林湖'), '边没有补成 relations')

  const sameKind = reconcile(
    [{ kind: '地点', title: '芦林湖', content: '补充描述，正文超过二十个字，用于验证同名同类归入 supplement。', relations: [] }],
    ['芦林湖'], new Map([[titleKey('芦林湖'), '地点']]))
  check(sameKind.supplement.length === 1 && sameKind.fresh.length === 0, '同名同类应归入 supplement')

  const crossKind = reconcile(
    [{ kind: '讲解点', title: '芦林湖', content: '模型把已有的地点又抽成了讲解点，正文长度足够二十个字。', relations: [] }],
    ['芦林湖'], new Map([[titleKey('芦林湖'), '地点']]))
  check(crossKind.conflicts.length === 1, '同名不同类应记为冲突')
  check(crossKind.conflicts[0].existingKind === '地点' && crossKind.conflicts[0].candidateKind === '讲解点', '冲突信息不完整')
  check(crossKind.fresh.length === 0, '同名不同类不该直接新建（会让《标题》引用歧义）')

  const many = Array.from({ length: 150 }, (_, i) => ({
    kind: '概念', title: `概念 ${i}`, content: `第 ${i} 个概念的正文，长度超过二十个字，用于验证分批上限。`,
  }))
  const batched = draftPayloads(normalizeItems(many).nodes, { sourceIds: ['src-1'], label: '批量' })
  check(batched.drafts.length === 2, `150 个节点应切成 2 份草稿，实际 ${batched.drafts.length}`)
  check(batched.drafts.every(draft => draft.nodes.length <= 100), '单份草稿超过 100 节点')

  // —— 端到端：假模型服务 ——
  const source = store.importSource({
    name: '庐山 7 月 10 日野外记录.pdf',
    buffer: Buffer.from('pdf-stub-1'),
    text: longText,
    kind: 'document',
    mediaType: 'application/pdf',
  }).source

  const calls = []
  // 每块的第一次调用故意返回坏 JSON，验证「解析失败 → 重试一次」这条路；
  // 第二次调用返回正常结果。键用块正文前缀，重试时正文不变。
  const attempts = new Map()
  const llm = {
    async *stream(options) {
      calls.push({ provider: options.provider, model: options.model, hasSystem: typeof options.system === 'string' })
      const prompt = options.messages.find(message => message.role === 'user')
        .content.map(block => block.text || '').join('\n')
      const section = /## 第 (\d+) 节/.exec(prompt)?.[1] || '0'
      const key = prompt.slice(-80)
      const attempt = (attempts.get(key) || 0) + 1
      attempts.set(key, attempt)
      if (attempt === 1) {
        yield { type: 'text-delta', index: 0, text: '这段不是 JSON，抱歉。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const payload = {
        items: [
          { kind: '讲解点', title: `冰碛剖面 ${section}`, content: `第 ${section} 处剖面出露灰白色泥砾，砾石磨圆度差，可见擦痕砾，属冰川堆积。`, coordinate: [115.97, 29.55] },
          { kind: '地点', title: '芦林湖', content: '芦林湖湖盆由冰川洼地积水而成，湖岸可见冰碛垄与漂砾。' },
        ],
        edges: [{ from: `冰碛剖面 ${section}`, to: '芦林湖', type: '位于' }],
      }
      yield { type: 'text-delta', index: 0, text: '好的，结果如下：```json\n' + JSON.stringify(payload) + '\n```' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const builder = createBuilder({
    dataDir: root,
    store,
    resolveLlm: () => llm,
    resolveTarget: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    log: () => {},
    config: { maxChars: 400, concurrency: 2, retryOnParseError: 1 },
  })

  const summary = await builder.run([source.id])
  check(summary.errors.length === 0, `端到端构建报错：${summary.errors.join('；')}`)
  check(summary.drafts.length >= 1, '没有生成草稿')
  check(calls.every(call => call.provider === 'deepseek-account' && call.model === 'deepseek-flash' && call.hasSystem),
    '模型调用没有使用用户配置的 provider/model 或缺少 system 提示词')

  const drafts = store.listDrafts('pending')
  check(drafts.length === summary.drafts.length, '草稿数量与摘要不一致')
  const titles = drafts.flatMap(draft => draft.nodes.map(node => node.t))
  check(titles.some(title => title.startsWith('冰碛剖面')), '抽出的讲解点没有进草稿')
  check(!titles.includes('芦林湖'), '同名同类节点不该新建（应对账到 supplement）')
  check(drafts.every(draft => draft.sourceIds.length === 1 && draft.sourceIds[0] === source.id), '草稿来源没有唯一指向该资料')

  const status = builder.status()
  check(status.sources[source.id].state === 'drafted', `状态应为 drafted，实际 ${status.sources[source.id].state}`)
  check(status.done.includes(source.id), '已完成集合里没有该资料')

  // 幂等：再跑一次应该跳过
  const again = await builder.run([source.id])
  check(again.sources[0].state === 'skipped', '重复构建没有跳过')

  // 模型服务缺失 / 未配置模型时给出可读错误，而不是抛异常
  const bare = createBuilder({ dataDir: root, store, resolveLlm: () => undefined, resolveTarget: () => undefined, log: () => {} })
  const bareResult = await bare.run([source.id])
  check(bareResult.errors.length === 1 && bareResult.errors[0].includes('模型'), '模型缺失时没有给出可读错误')

  check(calls.length >= chunks.length * 2, `重试路径没有被触发：调用 ${calls.length} 次 / ${chunks.length} 块`)
  console.log(`自动构建测试通过：分块 ${chunks.length} 块 → ${drafts.length} 份草稿 / ${titles.length} 节点，模型调用 ${calls.length} 次（含重试）`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
