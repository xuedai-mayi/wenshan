// 问山 · 检索评测：A(纯词法) / B(+知识图谱) / C(+空间感知) 三组对照
// 测试集由知识库自动构建：概念定义型 + 讲解点中心型 + 空间型
// 运行：node scripts/eval_qa.mjs   （在仓库根目录下）
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { createEngine, haversine } from '../packages/georag/src/engine.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA = p => JSON.parse(readFileSync(path.join(here, '../data', p), 'utf8'))

const nodes = DATA('graph_data.json').nodes
const days = DATA('days_data.json')
const mapLayers = DATA('map_data.json').layers
const eng = createEngine({ nodes, days, mapLayers })

// ---------------- 测试集构建 ----------------
const testset = []

// F1 概念定义型：89 个概念，"X是什么/为什么"
for (const n of nodes) {
  if (n.k !== '概念') continue
  testset.push({ family: '概念定义', q: `${n.t}是什么？`, gold: [n.id] })
}

// F2 讲解点中心型：以"讲解中心"原文为查询，目标是命中对应讲解点笔记
for (const d of days) {
  for (const p of d.points) {
    if (!p.center || p.center.length < 12) continue
    testset.push({ family: '讲解中心', q: p.center, gold: [p.id] })
  }
}

// F3 空间型："X附近讲了什么"，gold = 400m 内全部讲解点笔记
const allPts = days.flatMap(d => d.points.filter(p => p.coord))
for (const pl of mapLayers.places) {
  const near = allPts.filter(p => haversine([pl.x, pl.y], p.coord) <= 400).map(p => p.id)
  if (!near.length) continue
  testset.push({ family: '空间', q: `${pl.n}附近讲了什么？`, gold: near, spatialQ: true })
}

// ---------------- 三组配置 ----------------
const CONFIGS = {
  'A 纯词法': { lex: 1, graph: 0, spatial: 0 },
  'B +图谱': { lex: 1, graph: 0.5, spatial: 0 },
  'C +空间(问山)': { lex: 1, graph: 0.5, spatial: 0.6 },
}

function evalConfig(weights) {
  const per = {}
  for (const t of testset) {
    const res = eng.search(t.q, { weights, topK: 10, perNote: 1 })
    const ranked = res.hits.map(h => h.chunk.nid)
    const goldSet = new Set(t.gold)
    const rank = ranked.findIndex(nid => goldSet.has(nid))
    const fam = per[t.family] || (per[t.family] = { n: 0, h1: 0, h3: 0, h5: 0, rr: 0 })
    fam.n++
    if (rank === 0) fam.h1++
    if (rank > -1 && rank < 3) fam.h3++
    if (rank > -1 && rank < 5) fam.h5++
    if (rank > -1) fam.rr += 1 / (rank + 1)
  }
  const total = { n: 0, h1: 0, h3: 0, h5: 0, rr: 0 }
  for (const f of Object.values(per)) for (const k of ['n', 'h1', 'h3', 'h5', 'rr']) total[k] += f[k]
  per['总计'] = total
  return per
}

const pct = (a, b) => (100 * a / b).toFixed(1)
const results = {}
for (const [name, w] of Object.entries(CONFIGS)) results[name] = evalConfig(w)

// ---------------- 输出 ----------------
const fams = ['概念定义', '讲解中心', '空间', '总计']
const counts = Object.fromEntries(fams.map(f => [f, results['A 纯词法'][f]?.n || 0]))
console.log(`测试集：共 ${testset.length} 题（概念定义 ${counts['概念定义']} · 讲解中心 ${counts['讲解中心']} · 空间 ${counts['空间']}）\n`)

let md = `# 问山 GeoRAG 检索评测报告\n\n`
md += `- 语料：知识图谱 ${nodes.length} 节点 → ${eng.stats.chunks} 个知识块；地名词典 ${eng.stats.gaz} 条\n`
md += `- 测试集：**${testset.length} 题**，由知识库自动构建 — 概念定义 ${counts['概念定义']} 题（"X是什么"→命中概念笔记）、讲解中心 ${counts['讲解中心']} 题（讲解中心原文→命中讲解点笔记）、空间 ${counts['空间']} 题（"X附近讲了什么"→命中 400 m 内讲解点，多正解）\n`
md += `- 指标：Hit@k = 前 k 条结果（按笔记去重）命中任一正解的比例；MRR = 平均倒数排名\n`
md += `- 对照：A 纯词法(BM25 中文二元组)；B = A + 知识图谱双链扩展；C = B + 空间检索（地名解析→距离衰减加权，即问山完整配置）\n\n`

for (const fam of fams) {
  md += `## ${fam}（${counts[fam]} 题）\n\n| 配置 | Hit@1 | Hit@3 | Hit@5 | MRR |\n|---|---|---|---|---|\n`
  console.log(`【${fam}】 (${counts[fam]} 题)`)
  for (const [name, per] of Object.entries(results)) {
    const f = per[fam]
    if (!f) continue
    const row = `${pct(f.h1, f.n)}% | ${pct(f.h3, f.n)}% | ${pct(f.h5, f.n)}% | ${(f.rr / f.n).toFixed(3)}`
    md += `| ${name} | ${row.replaceAll(' | ', ' | ')} |\n`
    console.log(`  ${name.padEnd(12)} Hit@1 ${pct(f.h1, f.n)}%  Hit@3 ${pct(f.h3, f.n)}%  Hit@5 ${pct(f.h5, f.n)}%  MRR ${(f.rr / f.n).toFixed(3)}`)
  }
  md += `\n`
  console.log()
}

// 失例样本（C 配置 Hit@5 未命中）
const misses = []
for (const t of testset) {
  const res = eng.search(t.q, { weights: CONFIGS['C +空间(问山)'], topK: 5, perNote: 1 })
  if (!res.hits.some(h => t.gold.includes(h.chunk.nid))) misses.push(t)
}
md += `## 失例（C 配置 Hit@5 未命中，共 ${misses.length} 题）\n\n`
for (const m of misses.slice(0, 15)) md += `- [${m.family}] ${m.q.slice(0, 60)} → 期望 ${m.gold[0]}${m.gold.length > 1 ? ` 等${m.gold.length}项` : ''}\n`
console.log(`C 配置未命中 ${misses.length}/${testset.length} 题`)

const outDir = path.join(here, '../docs/evaluation')
mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, 'eval_report.md'), md, 'utf8')
writeFileSync(path.join(outDir, 'eval_results.json'), JSON.stringify({ testsetSize: testset.length, counts, results, misses: misses.map(m => ({ family: m.family, q: m.q, gold: m.gold })) }, null, 2), 'utf8')
console.log('\n报告已写入 docs/evaluation/eval_report.md')
