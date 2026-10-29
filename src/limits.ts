/**
 * UTF-16 长度上限约束，供协议校验、界面文案与状态机共享：
 * - MAX_QUESTION_LENGTH: 单次提问文本上限（8,000 字符）
 * - MAX_REFERENCE_LENGTH: 单次划词选区原文上限（8,000 字符，单条引用与旁问共用）
 * - MAX_TOTAL_QUOTES_LENGTH: 会话草稿内多条引用合计总长度上限（16,000 字符，最多容纳多条选区参考）
 */
export const MAX_QUESTION_LENGTH = 8_000
export const MAX_REFERENCE_LENGTH = 8_000
export const MAX_TOTAL_QUOTES_LENGTH = 16_000

/**
 * 一个旁问气泡允许的问答轮次上限（首轮 + 追问）。
 * 达到上限后客户端禁用追问输入，服务端仍二次校验，避免旧客户端绕过。
 */
export const MAX_TURNS_PER_BUBBLE = 10

/**
 * 插件侧同时进行的旁问轮次上限。
 *
 * 宿主默认 `maxActiveSubagents = 8`，与普通 subagent 共用；旁问留出 2 个名额
 * 给主任务，避免连续追问把主任务的委派全部挤掉。条目本身在轮次结束后不占名额
 * （宿主会在子会话空闲后自然释放激活，后续追问走冷恢复）。
 */
export const MAX_ACTIVE_TURNS = 6

/**
 * 旁问子代理的输出预算上限（completion tokens）。
 *
 * 旁问会继承整段主任务上下文；如果同时继承主任务的 max_tokens（例如 1M 窗口路由上的
 * 256,000），「继承的历史 + 输出预留」很容易越过上游窗口，表现为 HTTP 400
 * (`requested N tokens (X in the messages, Y in the completion)`)。
 * 旁问只做一次性只读回答，不需要主任务级别的输出预算，因此固定压到 32,000：
 * 既够写长答案，也给历史留出余量；确需更大预算时可在此调整。
 */
export const SIDE_MAX_OUTPUT_TOKENS = 32_000

/**
 * 设置项输入上限，Host 解析与客户端卡片共用，避免两侧各写一份而漂移：
 * - MAX_TOOL_NAME_LENGTH: 单个放行工具名的字符上限
 * - MAX_PROMPT_LENGTH: 自定义提示词的 UTF-16 长度上限（与提问文本同量级）
 */
export const MAX_TOOL_NAME_LENGTH = 120
export const MAX_PROMPT_LENGTH = 8_000
