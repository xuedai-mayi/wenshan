[CmdletBinding()]
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$ProductName = '问山：地理野外实习自成长智能助手'

if ($PSVersionTable.PSVersion.Major -lt 6) {
  throw 'Windows PowerShell 5.1 会剥离内嵌脚本的引号导致校验误报，请改用 PowerShell 7 运行：pwsh -File .\scripts\preflight.ps1'
}

function Invoke-CheckedCommand {
  param(
    [string]$Label,
    [scriptblock]$Command
  )

  Write-Host "[检查] $Label"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label 失败，退出码：$LASTEXITCODE"
  }
}

Push-Location $ProjectRoot
try {
  if (-not $SkipBuild) {
    Push-Location 'vendor\runtime'
    try {
      Invoke-CheckedCommand '构建内置运行时' { pnpm build }
    } finally {
      Pop-Location
    }
  }

  Invoke-CheckedCommand '校验站点配置和运行数据' {
    node -e "const fs=require('fs'); const name='$ProductName'; for (const file of ['config/lushan.json','data/site_data.json']) { const value=JSON.parse(fs.readFileSync(file,'utf8')); const site=value.site ?? value; if (site.title!==name || site.brand!==name) throw new Error(file+' 的产品名称未同步'); }"
  }
  Invoke-CheckedCommand '校验仓库可移植配置' {
    node -e 'const fs=require("fs"); const files=["config/wenshan.yml","agents/field-qa/agent.cordis.yml","agents/knowledge-build/agent.cordis.yml","tests/smoke.test.mjs"]; for (const file of files) { const text=fs.readFileSync(file,"utf8"); if (/file:\/\/\/[A-Za-z]:\//.test(text) || /[A-Za-z]:\/[^\s"\x27]+/g.test(text)) throw new Error(file+" 仍包含本机绝对路径"); }'
  }
  if (-not (Test-Path 'packages\intake\public\wenshan-valley.webp')) {
    throw '缺少项目自有的山谷背景资源。'
  }
  if (Test-Path '背景') {
    Write-Warning '检测到旧 Wallpaper Engine 素材目录。该目录不会进入 Git 仓库。'
  }
  Invoke-CheckedCommand '校验产品挂载配置' {
    node 'scripts\run.mjs' web --dump-config | Out-Null
  }
  Invoke-CheckedCommand '运行只读工具冒烟测试' { node 'tests\smoke.test.mjs' }
  Invoke-CheckedCommand '运行知识演化与发布链路测试' { node 'tests\product.test.mjs' }

  Write-Host ''
  Write-Host '发布前检查通过。如需浏览器验收，请按 README 安装 Playwright 后运行 tests/test_wenshan_web.py。'
  Write-Host '公开发布前请确认基础实习数据的授权，并检查 data/knowledge 中是否含有个人资料。'
} finally {
  Pop-Location
}
