import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fakeClaudeHome } from './helpers/fake-claude-home'
import { topicMessage } from './helpers/fake-telegram'
import { routerHarness } from './helpers/router-harness'

describe('/skills: pick skills for the project', () => {
  const home = fakeClaudeHome()
  const env = routerHarness({ claudeDir: home })
  afterAll(async () => {
    await env.cleanUp()
    rmSync(home, { recursive: true, force: true })
  })

  /** A bound topic with its /skills panel open, and helpers to press its buttons. */
  async function openPanel() {
    const topic = await env.boundTopic()
    await topic.send('/skills')
    const panel = env.api.log.find(item => item.kind === 'send' && item.threadId === topic.threadId && item.buttons)
    const panelId = panel?.messageId ?? -1
    const press = async (data: string) => {
      await topic.press(panelId, data)
      const redrawn = env.api.log.filter(item => item.kind === 'edit' && item.messageId === panelId).at(-1)
      const toast = env.api.log.filter(item => item.kind === 'answer').at(-1)?.text.replace(/^q\d+:/, '')
      return { text: redrawn?.text ?? '', buttons: redrawn?.buttons ?? [], toast }
    }
    const skillsDir = join(topic.folder, '.claude', 'skills')
    return { topic, panel, press, skillsDir }
  }

  test('lists each source with its count; a source page lists only its skills, 16 per page', async () => {
    // Arrange
    const { panel, press } = await openPanel()

    // Act
    const first = await press('skills:ck:0')
    const second = await press('skills:ck:1')
    const ponytail = await press('skills:ponytail:0')

    // Assert
    expect(panel?.text).toContain('🧩 Skill cho dự án\n📁 ')
    expect(panel?.buttons).toEqual([['skills:ponytail:0', 'skills:ck:0']])
    expect(first.text).toContain('🧩 ClaudeKit · dự án có 0/20 · trang 1/2')
    expect(first.text).toContain('• cook — ALWAYS activate this skill before implementing EVERY feature, plan, o…')
    expect(first.text).not.toContain('bmad-prd')
    expect(first.text).not.toContain('_shared')
    expect(first.buttons.flat()).toContain('skills:ck:0:+chrome-devtools')
    expect(first.buttons.flat().filter(data => data.includes('+'))).toHaveLength(16)
    expect(first.buttons.at(-1)).toEqual(['skills:home', 'skills:ck:1'])
    expect(second.buttons.at(-1)).toEqual(['skills:ck:0', 'skills:home'])
    expect(ponytail.text).toContain('• ponytail — Lazy senior dev mode: the smallest change.')
    expect(ponytail.buttons).toEqual([['skills:ponytail:0:+ponytail', 'skills:ponytail:0:+ponytail-audit'], ['skills:home']])
  })

  test('a press installs the skill whole, without node_modules or caches; the panel shows ✓ and offers removal', async () => {
    // Arrange
    const { press, skillsDir } = await openPanel()

    // Act
    const after = await press('skills:ck:0:+chrome-devtools')

    // Assert
    expect(after.toast).toBe('✅ Đã cài chrome-devtools.')
    expect(readFileSync(join(skillsDir, 'chrome-devtools', 'SKILL.md'), 'utf8')).toContain('ck:chrome-devtools')
    expect(existsSync(join(skillsDir, 'chrome-devtools', 'scripts', 'run.js'))).toBe(true)
    expect(existsSync(join(skillsDir, 'chrome-devtools', 'scripts', 'node_modules'))).toBe(false)
    expect(existsSync(join(skillsDir, 'chrome-devtools', 'scripts', '__pycache__'))).toBe(false)
    expect(readdirSync(dirname(skillsDir))).toEqual(['skills']) // no temp folder left
    expect(readdirSync(skillsDir).sort()).toEqual(['_shared', 'chrome-devtools']) // the shared folder its scripts import
    expect(after.text).toContain('dự án có 1/20')
    expect(after.text).toContain('✓ chrome-devtools')
    expect(after.buttons.flat()).toContain('skills:ck:0:-chrome-devtools')
  })

  test('a double tap installs once; the ✓ button then removes it', async () => {
    // Arrange
    const { press, skillsDir } = await openPanel()

    // Act: both taps hit the same "+" button, before Telegram redrew it.
    const firstTap = await press('skills:ck:0:+cook')
    const secondTap = await press('skills:ck:0:+cook')
    const installedRefs = existsSync(join(skillsDir, 'cook', 'references', 'workflow.md'))
    const removed = await press('skills:ck:0:-cook')

    // Assert
    expect(firstTap.toast).toBe('✅ Đã cài cook.')
    expect(secondTap.toast).toBe('cook đã có trong dự án.')
    expect(installedRefs).toBe(true)
    expect(removed.toast).toBe('🗑️ Đã gỡ cook.')
    expect(existsSync(join(skillsDir, 'cook'))).toBe(false)
    expect(removed.buttons.flat()).toContain('skills:ck:0:+cook')
  })

  test('never removes or overwrites a skill the project wrote or changed', async () => {
    // Arrange: ponytail installed then edited; the project has its own "cook".
    const { press, skillsDir } = await openPanel()
    await press('skills:ponytail:0:+ponytail')
    writeFileSync(join(skillsDir, 'ponytail', 'SKILL.md'), '---\nname: ponytail\ndescription: my version\n---\n')
    mkdirSync(join(skillsDir, 'cook'))
    writeFileSync(join(skillsDir, 'cook', 'SKILL.md'), 'project cook')

    // Act
    const edited = await press('skills:ponytail:0:-ponytail')
    const own = await press('skills:ck:0:-cook')
    const overwrite = await press('skills:ck:0:+cook')

    // Assert
    expect(edited.toast).toStartWith('⛔ Không gỡ ponytail: có tệp đã bị sửa, thêm hoặc xoá sau khi cài.')
    expect(readFileSync(join(skillsDir, 'ponytail', 'SKILL.md'), 'utf8')).toContain('my version')
    expect(own.toast).toStartWith('⛔ Không gỡ cook: không phải bản bot cài (skill riêng của dự án).')
    expect(overwrite.toast).toBe('cook đã có trong dự án.')
    expect(readFileSync(join(skillsDir, 'cook', 'SKILL.md'), 'utf8')).toBe('project cook')
    expect(own.text).toContain('✓ cook')
  })

  test('forged button data never touches the disk outside the listed skills', async () => {
    // Arrange
    const { press, topic } = await openPanel()

    // Act
    const traversal = await press('skills:ck:0:+../../escape')
    const otherKit = await press('skills:ck:0:+bmad-prd')
    const badOp = await press('skills:ck:0:xcook')
    const badSource = await press('skills:nope:0')
    const farPage = await press('skills:ck:99')

    // Assert
    expect(traversal.toast).toBe('⛔ ClaudeKit không có skill "../../escape".')
    expect(otherKit.toast).toBe('⛔ ClaudeKit không có skill "bmad-prd".')
    expect(badOp.toast).toBe('⛔ Nút không hợp lệ.')
    expect(badSource.toast).toBe('⛔ Nút không hợp lệ.')
    expect(existsSync(join(topic.folder, '.claude'))).toBe(false)
    expect(existsSync(join(topic.folder, 'escape'))).toBe(false)
    expect(farPage.text).toContain('trang 2/2')
  })

  test('a panel drawn for the folder the topic was bound to before acts on nothing, and is redrawn', async () => {
    // Arrange
    const { press, topic, skillsDir } = await openPanel()
    const elsewhere = mkdtempSync(join(tmpdir(), 'rebound-'))
    await topic.send(`/bind ${elsewhere}`)

    // Act
    const stale = await press('skills:ck:0:+cook')
    const fresh = await press('skills:ck:0:+cook')

    // Assert
    expect(stale.toast).toBe('⌛ Bảng này của thư mục cũ: đã mở lại cho thư mục hiện tại của topic.')
    expect(stale.text).toContain(`📁 ${join(elsewhere, '.claude', 'skills')}`)
    expect(existsSync(skillsDir)).toBe(false)
    expect(fresh.toast).toBe('✅ Đã cài cook.')
    expect(existsSync(join(elsewhere, '.claude', 'skills', 'cook', 'SKILL.md'))).toBe(true)
    await topic.send('/unbind')
    rmSync(elsewhere, { recursive: true, force: true })
  })

  test('a topic without a project gets told to /bind', async () => {
    // Act
    await env.router.handle([topicMessage('/skills', { message_thread_id: 990 })])

    // Assert
    const answer = env.api.log.find(item => item.kind === 'send' && item.threadId === 990)
    expect(answer?.text).toBe('Topic này chưa gắn dự án. Gõ /bind trước.')
    expect(answer?.buttons).toBeUndefined()
  })
})

describe('/skills on a machine without the sources', () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-home-empty-'))
  const env = routerHarness({ claudeDir: home })
  afterAll(async () => {
    await env.cleanUp()
    rmSync(home, { recursive: true, force: true })
  })

  test('each source says it is missing and how to get it', async () => {
    // Arrange
    const topic = await env.boundTopic()
    await topic.send('/skills')
    const panel = env.api.log.find(item => item.kind === 'send' && item.threadId === topic.threadId && item.buttons)

    // Act
    await topic.press(panel?.messageId ?? -1, 'skills:ponytail:0')

    // Assert
    expect(panel?.text).toContain('🧩 Skill cho dự án')
    const toast = env.api.log.find(item => item.kind === 'answer')?.text
    expect(toast).toContain('Máy chưa có Ponytail: cài plugin ponytail cho Claude Code trước.')
  })
})
