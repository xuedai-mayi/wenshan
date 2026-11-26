// 运维层测试：备份 / 恢复 / 健康探测。零外部依赖、不碰网络、不启动服务。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  archiveTarget, backupFileName, createBackup, fetchHealth, parseBackup, readBackup,
  restoreBackup, writeBackup,
} from '../scripts/lib/ops.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function throws(fn, matcher, message) {
  try {
    fn()
  } catch (error) {
    if (matcher && !String(error.message).includes(matcher)) {
      throw new Error(`${message}：报错信息里没有「${matcher}」，实际是「${error.message}」`)
    }
    return error
  }
  throw new Error(`${message}：没有抛错`)
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wenshan-ops-test-'))

function makeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
}

try {
  // —— 归档路径白名单 ——
  assert(archiveTarget('data/knowledge/events.jsonl')?.type === 'knowledge', '知识库路径应被接受')
  assert(archiveTarget('.wenshan-home/credentials.yaml')?.type === 'state', '运行状态路径应被接受')
  for (const bad of ['../etc/passwd', '/etc/passwd', 'data/knowledge/../../x', 'config/wenshan.yml', 'C:/Windows/win.ini', 'data/knowledge//x', '']) {
    assert(archiveTarget(bad) === null, `非法路径应被拒绝：${bad}`)
  }

  // —— 备份文件名 ——
  const named = backupFileName(new Date(2026, 0, 2, 3, 4, 5))
  assert(named === 'wenshan-backup-20260102-030405.wenshan.gz', `备份文件名格式不对：${named}`)

  // —— 备份 → 恢复闭环 ——
  const sourceRoot = path.join(workspace, 'source')
  const sourceHome = path.join(workspace, 'source-state')
  makeTree(sourceRoot, {
    'data/knowledge/events.jsonl': '{"type":"draft.published"}\n',
    'data/knowledge/sources/src-1/original.txt': '庐山三叠泉观察记录',
    'data/knowledge/structured/src-1.json': '{"nodes":3}',
    'data/graph_data.json': '不该被备份',
  })
  makeTree(sourceHome, {
    'credentials.yaml': 'apiKey: sk-test-not-a-real-key',
    'profiles/web/notes.txt': 'profile layer',
  })

  const created = createBackup({ root: sourceRoot, home: sourceHome, productVersion: '1.0.0' })
  assert(created.stats.files === 5, `应备份 5 个文件，实际 ${created.stats.files}`)
  const manifest = parseBackup(created.buffer)
  assert(manifest.product.version === '1.0.0', '清单应记录产品版本')
  assert(manifest.files.every(entry => entry.path.startsWith('data/knowledge/') || entry.path.startsWith('.wenshan-home/')), '归档只应包含知识库与运行状态')
  assert(!manifest.files.some(entry => entry.path.includes('graph_data.json')), '基础数据不应进入备份')

  const outDir = path.join(workspace, 'out')
  const written = writeBackup({ root: sourceRoot, home: sourceHome, outDir, productVersion: '1.0.0' })
  assert(fs.existsSync(written.file), '备份文件应已落盘')
  assert(readBackup(written.file).files.length === 5, '读回的清单应一致')

  // —— 只备份知识库（不带走凭据）——
  const dataOnly = createBackup({ root: sourceRoot, home: sourceHome, includeState: false })
  assert(dataOnly.manifest.files.every(entry => entry.path.startsWith('data/knowledge/')), '--data-only 不应包含运行状态')
  assert(!JSON.stringify(dataOnly.manifest).includes('sk-test-not-a-real-key'), '--data-only 不应带走凭据')

  // —— 恢复到另一个目录 ——
  const targetRoot = path.join(workspace, 'target')
  const targetHome = path.join(workspace, 'target-state')
  fs.mkdirSync(targetRoot, { recursive: true })
  makeTree(targetHome, { 'credentials.yaml': 'apiKey: old-key' })
  const dry = restoreBackup({ file: written.file, root: targetRoot, home: targetHome, dryRun: true })
  assert(dry.files === 5 && dry.dryRun, '--dry-run 应只校验不写入')
  assert(!fs.existsSync(path.join(targetRoot, 'data', 'knowledge', 'events.jsonl')), '--dry-run 不应写文件')

  const restored = restoreBackup({ file: written.file, root: targetRoot, home: targetHome })
  assert(restored.files === 5, '恢复文件数应一致')
  assert(fs.readFileSync(path.join(targetRoot, 'data', 'knowledge', 'sources', 'src-1', 'original.txt'), 'utf8') === '庐山三叠泉观察记录', '知识库内容恢复失败')
  assert(fs.readFileSync(path.join(targetHome, 'profiles', 'web', 'notes.txt'), 'utf8') === 'profile layer', '运行状态内容恢复失败')
  assert(fs.readFileSync(path.join(targetHome, 'credentials.yaml'), 'utf8').includes('sk-test'), '凭据应被恢复')
  assert(restored.snapshots.length >= 1 && fs.existsSync(restored.snapshots[0]), '恢复前应给现状留副本')

  // —— 损坏与伪造的归档 ——
  throws(() => parseBackup(Buffer.from('不是 gzip')), '损坏', '非 gzip 内容应被拒绝')
  const forged = JSON.parse(JSON.stringify(manifest))
  forged.files.push({ path: '../../.ssh/authorized_keys', data: Buffer.from('x').toString('base64'), size: 1 })
  throws(() => parseBackup(zlib.gzipSync(Buffer.from(JSON.stringify(forged)))), '非法路径', '路径穿越应被拒绝')
  const tampered = JSON.parse(JSON.stringify(manifest))
  tampered.files[0].size = tampered.files[0].size + 1
  const tamperedFile = path.join(workspace, 'tampered.wenshan.gz')
  fs.writeFileSync(tamperedFile, zlib.gzipSync(Buffer.from(JSON.stringify(tampered))))
  throws(() => restoreBackup({ file: tamperedFile, root: targetRoot, home: targetHome }), '大小与清单不符', '篡改后的归档应被拒绝')

  // —— 空目录 ——
  const emptyRoot = path.join(workspace, 'empty')
  fs.mkdirSync(emptyRoot, { recursive: true })
  throws(() => createBackup({ root: emptyRoot, home: path.join(emptyRoot, 'home') }), '没有可备份的数据', '空目录应给出可读提示')

  // —— 健康探测（注入 fetch，不真的联网）——
  const okFetch = async (url, init) => {
    assert(String(url).endsWith('/wenshan/api/health'), `探活路径不对：${url}`)
    assert(init.signal != null, '探活应带超时信号')
    return { ok: true, status: 200, json: async () => ({ status: 'ok', site: '庐山', knowledge: { sources: 2 } }) }
  }
  const healthy = await fetchHealth({ baseUrl: 'http://127.0.0.1:3080', fetchImpl: okFetch })
  assert(healthy.ok && healthy.body.site === '庐山', '健康响应应被识别为可用')

  const degraded = await fetchHealth({
    baseUrl: 'http://127.0.0.1:3080/',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ status: 'degraded' }) }),
  })
  assert(!degraded.ok && degraded.status === 503, '503 应识别为不健康')

  const offline = await fetchHealth({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: async () => { throw new Error('fetch failed') },
  })
  assert(!offline.ok && offline.error === 'fetch failed', '网络错误应归一成结果')

  console.log('运维层测试通过：归档白名单、备份恢复闭环、篡改拒绝与健康探测')
} finally {
  fs.rmSync(workspace, { recursive: true, force: true })
}
