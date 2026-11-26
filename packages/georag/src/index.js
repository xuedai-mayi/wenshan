// 问山 · GeoRAG 引擎与数据服务
//
// 从 build_data.py 产出的 data/*.json 构建三路检索（词法 BM25 中文二元组 +
// 知识图谱双链扩展 + 空间距离衰减）引擎，以 ctx.lushanData 服务暴露。
// engine.js 为纯 ESM 零依赖实现（与页面脚本共用同一份），此处原样复用，
// 因此 scripts/eval_qa.mjs 评测可以直接 import 本包的 engine 做回归。
import fs from 'node:fs'
import path from 'node:path'
import z from '../../../vendor/runtime/vendor/schemastery/lib/index.mjs'
import { createEngine } from './engine.js'
import { KnowledgeStore } from './knowledge-store.js'
import { createBuilder } from './build.js'

export const name = 'georag'
export const inject = []

export const Config = z.object({
  /**
   * 数据目录：build_data.py 的输出目录，
   * 含 site_data / graph_data / days_data / map_data / photos_index.json。
   */
  dataDir: z.string().default(() => path.join(process.cwd(), 'data')),
  /**
   * 自动构建：上传资料后用宿主已配置的模型抽取知识草稿。
   * 模型与凭据都来自宿主（设置 > 模型），这里只控制分块与并发。
   */
  build: z.object({
    enabled: z.boolean().default(true),
    maxChars: z.number().default(2500),
    maxChunks: z.number().default(60),
    concurrency: z.number().default(2),
    maxTokens: z.number().default(8000),
  }).default({}),
})

const readJson = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir ?? path.join(process.cwd(), 'data')
  const knowledge = new KnowledgeStore(dataDir)
  const service = { dataDir, knowledge }

  function load() {
    const site = readJson(dataDir, 'site_data.json')
    const graph = readJson(dataDir, 'graph_data.json')
    const days = readJson(dataDir, 'days_data.json')
    const map = readJson(dataDir, 'map_data.json')
    const photos = readJson(dataDir, 'photos_index.json')
    const publishedNodes = knowledge.publishedNodes()
    const mergedGraph = { ...graph, nodes: [...graph.nodes, ...publishedNodes] }
    const engine = createEngine({ nodes: mergedGraph.nodes, days, mapLayers: map.layers })
    Object.assign(service, { site, graph: mergedGraph, baseGraph: graph, days, map, photos, engine, stats: engine.stats })
    ctx.logger('georag').info(
      `${site.name}：${graph.nodes.length} 基础节点 + ${publishedNodes.length} 已发布节点 / ${engine.stats.chunks} 知识块 / ${days.length} 天`,
    )
    return service
  }

  // 自动构建：provider/model 取自「设置 > 模型」当前选择，凭据由宿主适配器解析，
  // 本插件不读任何密钥。两个服务都可能晚于本插件挂载，所以在调用时懒解析。
  const builder = createBuilder({
    dataDir,
    store: knowledge,
    resolveLlm: () => ctx.reflect.get('llm', false),
    resolveTarget: () => {
      const selection = ctx.reflect.get('agentDefaultModel', false)?.currentSelection?.()
      return selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : undefined
    },
    log: (scope, level, message) => ctx.logger(scope)[level](message),
    config: {
      maxChars: config.build?.maxChars,
      maxChunks: config.build?.maxChunks,
      concurrency: config.build?.concurrency,
      maxTokens: config.build?.maxTokens,
    },
  })
  service.build = builder
  service.autoBuild = config.build?.enabled !== false

  service.reload = load
  service.publishDraft = (id, confirmation) => {
    const result = knowledge.publishDraft(id, confirmation)
    load()
    return result
  }

  // 对外始终暴露同一个可变服务对象，热重载后既有 preset 立即看到新引擎。
  load()
  ctx.provide('lushanData', service)
}
