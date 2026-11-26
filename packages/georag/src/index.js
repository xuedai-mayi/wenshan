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

export const name = 'georag'
export const inject = []

export const Config = z.object({
  /**
   * 数据目录：build_data.py 的输出目录，
   * 含 site_data / graph_data / days_data / map_data / photos_index.json。
   */
  dataDir: z.string().default(() => path.join(process.cwd(), 'data')),
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
