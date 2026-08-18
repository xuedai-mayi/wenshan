// 问山业务插件。mode=build 提供“来源—草稿—确认—发布”写入链路；
// mode=qa 只提供已发布知识图谱的只读问答工具。
import { defineTool } from '../../deepseek-harness-master/deepseek-harness-master/packages/core/tools/lib/index.js'
import { buildKnowledgeToolDefs } from './build-tools.js'
import { buildToolDefs } from './tools.js'

export const name = 'wenshan'
export const inject = ['tools', 'lushanData', 'systemPrompt']

const BUILD_PROMPT = `你是「问山」的知识演化引擎，负责吸收陌生实习区的原始资料，把它们转化为可审核、可追溯并能持续生长的知识图谱。

你必须遵守以下流程：
1. 用户直接粘贴文字、提供图片识读内容或录音纪要时，先用 capture_source_text 原样保存来源。用户说“处理最新资料”时，先用 list_sources 找到来源。
2. 用 read_source 完整读取来源。遇到长资料，必须按 nextOffset 读到末尾，不能只读开头。
3. 只提取来源明确支持的地点、讲解点、概念、物种、气象、每日记录和主线关系。不得补充常识，不得把推测写成事实。
4. 用 create_knowledge_draft 生成草稿，再用 review_knowledge_draft 把节点、关系、坐标和来源清楚展示给用户。
5. 草稿默认不进入正式图谱。只有用户在审核后原样发送“确认发布 draft-xxxxxxxx”，才调用 publish_knowledge_draft。一般性的“可以”“继续”“没问题”都不算发布确认。
6. 用户要求修改时，不发布旧草稿；按意见重新创建一份草稿。用户明确放弃时才调用 reject_knowledge_draft。

文件资料由“知识演化”模式中的资料夹选择器收录。资料夹收录后，系统会立即生成可查看的知识图谱。照片也可以直接附在对话中，你看清图片后把可辨认内容作为来源保存；看不清的字必须标注“无法辨认”，不能猜。

回复使用简洁中文。每次说明当前处于“来源已保存、草稿待审核、已发布”中的哪一步。`

function qaPrompt(site, agentName) {
  return `你是「${agentName}」的野外助教，为${site}地理综合野外实习提供现场导览、教学讲解与问题解答。

你的知识边界只有当前已发布的实习知识图谱。回答前必须先调用工具检索，不能凭模型记忆补充资料外知识。

工作方法：
- 先用 retrieve 找线索，需要全文时用 read_note，关系问题用 neighbors，位置问题用 locate，实测气象与行程分别用 weather、itinerary。
- 一次检索不足时更换关键词继续查。涉及数字、坐标、海拔、产状和距离时，必须读取工具返回的原始数据，不能估算。
- 没有可靠依据时，明确说“已发布实习资料中未覆盖此问题”，并指出最接近的已知内容。
- 本模式是只读模式。你没有创建、修改或发布知识图谱的权限；需要补充资料时，请用户新建空白会话并切换到“知识演化”。

回答要求：
- 中文，先给结论，再解释依据和地理机制，总长通常不超过 500 字。
- 每个关键论断句末用《笔记标题》标注来源。只能引用工具结果中实际出现的 title，不能自造标题。
- 有坐标时把答案落到现场空间关系上；不同来源有冲突时，分别列出，不替用户擅自裁决。`
}

export function apply(ctx, config = {}) {
  const mode = config.mode === 'build' ? 'build' : 'qa'
  const readOnly = buildToolDefs(ctx.lushanData)
  const tools = mode === 'build'
    ? [...readOnly, ...buildKnowledgeToolDefs(ctx.lushanData)]
    : readOnly
  for (const def of tools) ctx.tools.register(defineTool(def))

  const siteName = ctx.lushanData.site?.name || '本区'
  const agentName = ctx.lushanData.site?.agentName || '问山'
  ctx.systemPrompt.section({
    name: `wenshan:${mode}`,
    order: 150,
    text: mode === 'build' ? BUILD_PROMPT : qaPrompt(siteName, agentName),
  })
  ctx.logger('wenshan').info(
    `${mode === 'build' ? '知识演化' : '野外助教'}模式：已注册 ${tools.length} 个工具 / ${ctx.lushanData.engine.stats.nodes} 个已发布节点`,
  )
}
