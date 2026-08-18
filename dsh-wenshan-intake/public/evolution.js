(() => {
  const api = '/wenshan/api/evolution'
  let queuedFiles = []
  let isUploading = false

  const style = document.createElement('style')
  style.id = 'wenshan-evolution-style'
  style.textContent = [
    '#wenshan-graph-entry{position:fixed;right:20px;top:18px;z-index:2147483000;display:inline-flex;align-items:center;gap:7px;padding:8px 13px;border:1px solid rgba(42,76,57,.25);border-radius:999px;background:rgba(246,248,244,.9);color:#244936;text-decoration:none;font:600 13px/1 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 10px 30px rgba(25,50,36,.16);backdrop-filter:blur(16px);transition:transform .18s ease,background .18s ease}',
    '#wenshan-graph-entry:hover{background:#edf2eb;border-color:#6c8d76;transform:translateY(-1px)}#wenshan-graph-entry svg{width:16px;height:16px}',
    '#wenshan-folder-entry{position:fixed;right:20px;top:58px;z-index:2147483000;display:none;align-items:center;gap:7px;padding:8px 13px;border:1px solid rgba(42,76,57,.25);border-radius:999px;background:rgba(39,93,65,.94);color:#fff;font:650 13px/1 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 10px 30px rgba(25,50,36,.18);backdrop-filter:blur(16px);cursor:pointer;transition:transform .18s ease,background .18s ease}#wenshan-folder-entry.show{display:inline-flex}#wenshan-folder-entry:hover{background:#1c4d35;transform:translateY(-1px)}#wenshan-folder-entry svg{width:16px;height:16px}',
    '#wenshan-folder-panel{position:fixed;inset:0;z-index:2147483640;display:none;align-items:center;justify-content:center;padding:22px;background:rgba(7,22,15,.48);backdrop-filter:blur(12px)}#wenshan-folder-panel.show{display:flex}',
    '.wenshan-folder-card{width:min(620px,100%);position:relative;overflow:hidden;border:1px solid rgba(223,236,226,.72);border-radius:24px;background:linear-gradient(150deg,rgba(250,253,250,.98),rgba(238,246,239,.98));box-shadow:0 32px 110px rgba(5,25,16,.32);color:#173827;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}',
    '.wenshan-folder-card::before{content:"";position:absolute;inset:0 0 auto;height:6px;background:linear-gradient(90deg,#2f6b4a,#a4c7a0,#d4b278)}.wenshan-folder-head{display:flex;gap:18px;padding:31px 32px 12px}.wenshan-folder-mark{flex:0 0 40px;height:40px;border-radius:13px;display:grid;place-items:center;background:#275d41;color:#fff;box-shadow:0 10px 25px rgba(37,88,61,.2)}.wenshan-folder-mark svg{width:23px}.wenshan-folder-head h2{margin:0;font-family:"Noto Serif SC","Songti SC",serif;font-size:25px;line-height:1.3;letter-spacing:.03em}.wenshan-folder-head p{margin:6px 0 0;color:#587060}',
    '.wenshan-folder-close{position:absolute;right:16px;top:16px;width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:#54705e;font-size:19px;cursor:pointer}.wenshan-folder-close:hover{background:rgba(37,93,65,.09)}.wenshan-folder-body{padding:12px 32px 30px}.wenshan-folder-well{padding:20px;border:1px dashed #8cad98;border-radius:17px;background:rgba(255,255,255,.55)}.wenshan-folder-well strong{display:block;font-size:16px}.wenshan-folder-well span{display:block;margin-top:4px;color:#637d6c}.wenshan-folder-actions{display:flex;align-items:center;gap:10px;margin-top:18px;flex-wrap:wrap}.wenshan-folder-primary,.wenshan-folder-secondary{border:0;border-radius:10px;padding:10px 14px;font:650 14px/1 system-ui,"Microsoft YaHei",sans-serif;cursor:pointer}.wenshan-folder-primary{background:#275d41;color:#fff;box-shadow:0 9px 18px rgba(37,93,65,.2)}.wenshan-folder-primary:hover{background:#1c4d35}.wenshan-folder-primary:disabled{opacity:.55;cursor:wait}.wenshan-folder-secondary{background:transparent;color:#53705d}.wenshan-folder-status{min-height:22px;margin-top:16px;color:#4e6f5a}.wenshan-folder-progress{height:5px;overflow:hidden;margin-top:9px;border-radius:999px;background:#dce9de}.wenshan-folder-progress i{display:block;width:0;height:100%;background:linear-gradient(90deg,#2d704b,#9abf7f);transition:width .22s ease}.wenshan-folder-result{margin-top:13px;padding:11px 13px;border-radius:11px;background:rgba(49,111,75,.1);color:#234f37}.wenshan-folder-result a{color:#1d6744;font-weight:700}.wenshan-folder-error{color:#9e3b32}',
    'body[data-ds-dark-theme] #wenshan-graph-entry{background:rgba(9,24,18,.78);border-color:rgba(211,230,219,.18);color:#eef5f0;box-shadow:0 12px 36px rgba(0,0,0,.26)}body[data-ds-dark-theme] #wenshan-graph-entry:hover{background:rgba(19,45,33,.92)}@media(max-width:720px){#wenshan-graph-entry{top:auto;right:14px;bottom:14px}#wenshan-folder-entry{top:auto;right:14px;bottom:60px}.wenshan-folder-panel{padding:12px}.wenshan-folder-head{padding:27px 20px 9px;gap:13px}.wenshan-folder-head h2{font-size:22px}.wenshan-folder-body{padding:12px 20px 22px}}',
  ].join('')
  document.head.append(style)

  const graphEntry = document.createElement('a')
  graphEntry.id = 'wenshan-graph-entry'
  graphEntry.href = '/wenshan/knowledge-graph'
  graphEntry.title = '查看知识图谱'
  graphEntry.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="5.4" cy="7" r="2.2" stroke="currentColor" stroke-width="1.8"/><circle cx="17.6" cy="5.5" r="1.9" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="17.2" r="2.7" stroke="currentColor" stroke-width="1.8"/><path d="m7.4 8.2 2.8 7M15.9 6.9l-2.3 8M7.6 7.4l8-1.5" stroke="currentColor" stroke-width="1.5"/></svg><span>知识图谱</span>'
  document.body.append(graphEntry)

  const folderEntry = document.createElement('button')
  folderEntry.id = 'wenshan-folder-entry'
  folderEntry.type = 'button'
  folderEntry.title = '选择实习资料总文件夹'
  folderEntry.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 18 9.2 8.5l3.1 4.4L15.2 9 21 18H3Z" fill="currentColor" opacity=".86"/><path d="M12 4v6.4m0-6.4L9.7 6.3M12 4l2.3 2.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>选择资料夹</span>'
  document.body.append(folderEntry)

  const panel = document.createElement('section')
  panel.id = 'wenshan-folder-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-labelledby', 'wenshan-folder-title')
  panel.innerHTML = '<div class="wenshan-folder-card"><button class="wenshan-folder-close" type="button" aria-label="关闭">×</button><div class="wenshan-folder-head"><div class="wenshan-folder-mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 18 9.2 8.5l3.1 4.4L15.2 9 21 18H3Z" fill="currentColor" opacity=".9"/><path d="M12 4v6.4m0-6.4L9.7 6.3M12 4l2.3 2.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div><div><h2 id="wenshan-folder-title">选择实习资料总文件夹</h2><p>请选中所有照片、录音、文档和空间数据所在的同一个文件夹。</p></div></div><div class="wenshan-folder-body"><div class="wenshan-folder-well"><strong id="wenshan-folder-summary">尚未选择资料夹</strong><span>系统会保留原文件和目录位置，自动提取可读内容，并生成资料关联图谱。</span></div><div class="wenshan-folder-actions"><button class="wenshan-folder-primary" type="button" data-action="choose">选择资料总文件夹</button><button class="wenshan-folder-secondary" type="button" data-action="close">稍后再说</button><input data-role="files" type="file" hidden multiple webkitdirectory directory></div><div class="wenshan-folder-status" data-role="status"></div><div class="wenshan-folder-progress" hidden><i></i></div><div class="wenshan-folder-result" data-role="result" hidden></div></div></div>'
  document.body.append(panel)

  const input = panel.querySelector('[data-role="files"]')
  const chooseButton = panel.querySelector('[data-action="choose"]')
  const summary = panel.querySelector('#wenshan-folder-summary')
  const status = panel.querySelector('[data-role="status"]')
  const progress = panel.querySelector('.wenshan-folder-progress')
  const progressBar = progress.querySelector('i')
  const result = panel.querySelector('[data-role="result"]')

  function openPanel() {
    if (isUploading) return
    panel.classList.add('show')
    chooseButton.focus()
  }

  function closePanel() {
    if (!isUploading) panel.classList.remove('show')
  }

  function showEvolutionEntry(show) {
    folderEntry.classList.toggle('show', show)
  }

  function bytes(value) {
    if (value < 1024 * 1024) return Math.max(1, Math.round(value / 1024)) + ' KB'
    return (value / 1024 / 1024).toFixed(1) + ' MB'
  }

  function selectFiles(files) {
    queuedFiles = Array.from(files || [])
    result.hidden = true
    status.textContent = ''
    if (!queuedFiles.length) {
      summary.textContent = '没有找到可收录的文件'
      return
    }
    const relative = queuedFiles[0].webkitRelativePath || queuedFiles[0].name
    const folder = relative.split('/')[0]
    const total = queuedFiles.reduce((sum, file) => sum + file.size, 0)
    summary.textContent = folder + '，共 ' + queuedFiles.length + ' 份文件，' + bytes(total)
    chooseButton.textContent = '收录并生成图谱'
  }

  async function uploadFile(file) {
    const params = new URLSearchParams({
      name: file.name,
      path: file.webkitRelativePath || file.name,
    })
    const response = await fetch(api + '/sources?' + params.toString(), {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || '收录失败')
    return payload
  }

  async function startUpload() {
    if (isUploading) return
    if (!queuedFiles.length) {
      input.click()
      return
    }
    isUploading = true
    chooseButton.disabled = true
    progress.hidden = false
    result.hidden = true
    let cursor = 0
    let completed = 0
    let failed = 0
    const total = queuedFiles.length
    const worker = async () => {
      while (cursor < total) {
        const index = cursor++
        const file = queuedFiles[index]
        status.textContent = '正在收录 ' + (index + 1) + '/' + total + '：' + file.name
        try {
          await uploadFile(file)
        } catch (error) {
          failed++
        }
        completed++
        progressBar.style.width = Math.round(completed / total * 100) + '%'
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, total) }, worker))
    try {
      const graph = await fetch(api + '/graph', { cache: 'no-store' }).then(response => response.json())
      status.textContent = failed ? '已收录 ' + (total - failed) + ' 份文件，' + failed + ' 份未成功。' : '已收录全部 ' + total + ' 份文件。'
      status.className = 'wenshan-folder-status' + (failed ? ' wenshan-folder-error' : '')
      result.innerHTML = '资料关联图谱已生成，当前有 ' + graph.stats.graphNodes + ' 个节点、' + graph.stats.graphLinks + ' 条关联。<a href="/wenshan/knowledge-graph">查看知识图谱</a>'
      result.hidden = false
      chooseButton.textContent = '已完成'
    } catch (error) {
      status.textContent = '资料已收录，但图谱加载失败：' + error.message
      status.className = 'wenshan-folder-status wenshan-folder-error'
    } finally {
      isUploading = false
      chooseButton.disabled = false
    }
  }

  chooseButton.addEventListener('click', startUpload)
  folderEntry.addEventListener('click', openPanel)
  input.addEventListener('change', () => selectFiles(input.files))
  panel.querySelector('[data-action="close"]').addEventListener('click', closePanel)
  panel.querySelector('.wenshan-folder-close').addEventListener('click', closePanel)
  panel.addEventListener('click', event => { if (event.target === panel) closePanel() })

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('button,[role="button"]') : null
    if (!target) return
    const label = String(target.textContent || '').replace(/\s+/g, '')
    if (label.includes('知识演化')) setTimeout(() => showEvolutionEntry(true), 120)
    if (label.includes('野外助教')) setTimeout(() => showEvolutionEntry(false), 120)
  }, true)
})()
