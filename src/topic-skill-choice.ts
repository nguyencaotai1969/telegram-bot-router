import { hasProjectSkill, installSkill, projectSkillsDir, removeSkill } from './project-skill-install'
import { SKILL_SOURCES, type SkillSource, type SourceSkill, sourceSkills } from './skill-sources'
import { buttonRows, type InlineButton } from './telegram-api'
import type { Reply } from './topic-model-choice'
import { errorText, type RunDeps, type TopicContext } from './topic-run'

/**
 * Button data: `skills:home` (the sources), `skills:<source>:<page>` (a page of its skills),
 * `skills:<source>:<page>:+<skill>` / `-<skill>` (install / remove, then that page again). The action
 * is fixed when the button is drawn: a double tap installs once, it never installs then removes.
 */
const PREFIX = 'skills:'
const HOME = `${PREFIX}home`
const PAGE_SIZE = 16
const PER_ROW = 2
const DESCRIPTION_CHARS = 70
const UNBOUND = 'Topic này chưa gắn dự án. Gõ /bind trước.'

/** `/skills`: the sources, each with how many of its skills the project already has. */
export function skillsCommand(deps: RunDeps, ctx: TopicContext): Reply {
  const cwd = deps.store.get(ctx.key)?.cwd
  return cwd ? homePanel(deps, cwd) : { text: UNBOUND }
}

/**
 * A press on a /skills panel button: acts, then redraws the panel in place. False: not ours.
 * `panelText` is the panel as Telegram shows it: one drawn for another folder (the topic was bound
 * elsewhere since) is redrawn for the current one without acting.
 */
export async function onSkillButton(
  deps: RunDeps,
  panel: TopicContext & { messageId: number },
  data: string,
  queryId: string,
  panelText = '',
): Promise<boolean> {
  if (!data.startsWith(PREFIX)) return false
  const cwd = deps.store.get(panel.key)?.cwd
  const { reply, toast } = !cwd
    ? { reply: { text: UNBOUND }, toast: UNBOUND }
    : !panelText.split('\n').includes(folderLine(cwd))
      ? { reply: homePanel(deps, cwd), toast: '⌛ Bảng này của thư mục cũ: đã mở lại cho thư mục hiện tại của topic.' }
      : press(deps, cwd, data.slice(PREFIX.length))
  await Promise.all([
    deps.api.editText(panel.chatId, panel.messageId, reply.text, reply.buttons).catch(() => {}), // e.g. "not modified"
    deps.api.answerCallback(queryId, toast?.slice(0, 200)).catch(() => {}), // Telegram's toast limit
  ])
  return true
}

function press(deps: RunDeps, cwd: string, action: string): { reply: Reply; toast?: string } {
  if (action === 'home') return { reply: homePanel(deps, cwd) }
  const [sourceId, pageText, pick, ...rest] = action.split(':')
  const source = SKILL_SOURCES.find(s => s.id === sourceId)
  const page = Number(pageText)
  if (!source || !Number.isInteger(page) || rest.length > 0) return { reply: homePanel(deps, cwd), toast: '⛔ Nút không hợp lệ.' }
  const skills = sourceSkills(source, deps.config.claudeDir)
  if (!skills) return { reply: homePanel(deps, cwd), toast: `Máy chưa có ${source.label}: ${source.missingHint}.` }
  const toast = pick ? applyPick(cwd, source, skills, pick) : undefined
  return { reply: sourcePanel(cwd, source, skills, page, toast), toast }
}

/** `+name` installs, `-name` removes: only a skill the source lists, so a forged `../x` never touches the disk. */
function applyPick(cwd: string, source: SkillSource, skills: SourceSkill[], pick: string): string {
  if (pick[0] !== '+' && pick[0] !== '-') return '⛔ Nút không hợp lệ.'
  const name = pick.slice(1)
  const skill = skills.find(s => s.name === name)
  if (!skill) return `⛔ ${source.label} không có skill "${name.slice(0, 40)}".`
  try {
    if (pick[0] === '+') return installSkill(cwd, skill) === 'installed' ? `✅ Đã cài ${name}.` : `${name} đã có trong dự án.`
    const removed = removeSkill(cwd, skill)
    if (removed === 'removed') return `🗑️ Đã gỡ ${name}.`
    if (removed === 'missing') return `${name} không còn trong dự án.`
    const why = removed === 'foreign' ? 'không phải bản bot cài (skill riêng của dự án)' : 'có tệp đã bị sửa, thêm hoặc xoá sau khi cài'
    return `⛔ Không gỡ ${name}: ${why}. Muốn gỡ thì xoá tay .claude/skills/${name}.`
  } catch (err) {
    return `⚠️ Không ${pick[0] === '+' ? 'cài' : 'gỡ'} được ${name}: ${errorText(err)}`
  }
}

function homePanel(deps: RunDeps, cwd: string): Reply {
  const buttons = SKILL_SOURCES.map(source => {
    const skills = sourceSkills(source, deps.config.claudeDir)
    const count = skills ? `${skills.filter(s => hasProjectSkill(cwd, s.name)).length}/${skills.length}` : 'chưa có'
    return { text: `${source.label} · ${count}`, data: `${PREFIX}${source.id}:0` }
  })
  const text = [
    '🧩 Skill cho dự án',
    folderLine(cwd),
    'Chọn nguồn, rồi bấm skill để chép vào thư mục trên; bấm lại để gỡ.',
    'Claude Code tự nhận skill mới. Chưa thấy thì /stop rồi nhắn lại.',
  ].join('\n')
  return { text, buttons: buttonRows(buttons, PER_ROW) }
}

function sourcePanel(cwd: string, source: SkillSource, skills: SourceSkill[], page: number, headline?: string): Reply {
  const pages = Math.max(1, Math.ceil(skills.length / PAGE_SIZE))
  const current = Math.min(Math.max(page, 0), pages - 1)
  const shown = skills.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  const installed = new Set(skills.filter(s => hasProjectSkill(cwd, s.name)).map(s => s.name))
  const text = [
    ...(headline ? [headline, ''] : []),
    `🧩 ${source.label} · dự án có ${installed.size}/${skills.length}${pages > 1 ? ` · trang ${current + 1}/${pages}` : ''}`,
    folderLine(cwd),
    '',
    ...(shown.length > 0 ? shown.map(s => `${installed.has(s.name) ? '✓' : '•'} ${s.name}${short(s.description)}`) : ['(Nguồn này chưa có skill nào.)']),
  ].join('\n')
  const at = `${PREFIX}${source.id}:${current}`
  const skillButtons = shown.map(s =>
    installed.has(s.name) ? { text: `✓ ${s.name}`, data: `${at}:-${s.name}` } : { text: s.name, data: `${at}:+${s.name}` },
  )
  const nav: InlineButton[] = [
    ...(current > 0 ? [{ text: '‹ Trước', data: `${PREFIX}${source.id}:${current - 1}` }] : []),
    { text: '« Nguồn', data: HOME },
    ...(current < pages - 1 ? [{ text: 'Sau ›', data: `${PREFIX}${source.id}:${current + 1}` }] : []),
  ]
  return { text, buttons: [...buttonRows(skillButtons, PER_ROW), nav] }
}

/** On every panel: which folder its buttons act on. */
function folderLine(cwd: string): string {
  return `📁 ${projectSkillsDir(cwd)}`
}

function short(description: string): string {
  const chars = Array.from(description) // never cuts an emoji in half
  if (chars.length === 0) return ''
  return ` — ${chars.length > DESCRIPTION_CHARS ? `${chars.slice(0, DESCRIPTION_CHARS - 1).join('').trimEnd()}…` : description}`
}
