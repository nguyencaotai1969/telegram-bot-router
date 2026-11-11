import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installSkill, projectSkillsDir, removeSkill } from '../src/project-skill-install'
import type { SourceSkill } from '../src/skill-sources'

const root = mkdtempSync(join(tmpdir(), 'skill-install-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let nextId = 1

/** A source folder with one skill "cook" (and a shared folder), and an empty project. */
function setUp() {
  const base = join(root, `case-${nextId++}`)
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(base, path)), { recursive: true })
    writeFileSync(join(base, path), text)
  }
  write('source/cook/SKILL.md', '---\nname: ck:cook\n---\n')
  write('source/cook/references/workflow.md', 'steps')
  write('source/_shared/lib/parser.cjs', 'shared')
  mkdirSync(join(base, 'project'))
  const skill: SourceSkill = { name: 'cook', description: '', dir: join(base, 'source', 'cook'), shared: [join(base, 'source', '_shared')] }
  const copy = join(projectSkillsDir(join(base, 'project')), 'cook')
  return { base, write, skill, project: join(base, 'project'), copy }
}

describe('installing and removing a project skill', () => {
  test('removal keeps a copy whose files were edited, added or deleted after the install', () => {
    // Arrange: three installs, each changed in a different way outside SKILL.md.
    const edited = setUp()
    const added = setUp()
    const deleted = setUp()
    for (const c of [edited, added, deleted]) installSkill(c.project, c.skill)
    writeFileSync(join(edited.copy, 'references', 'workflow.md'), 'my steps')
    writeFileSync(join(added.copy, '.env'), 'GEMINI_API_KEY=mine')
    rmSync(join(deleted.copy, 'references', 'workflow.md'))

    // Act
    const results = [edited, added, deleted].map(c => removeSkill(c.project, c.skill))

    // Assert
    expect(results).toEqual(['changed', 'changed', 'changed'])
    expect(existsSync(join(edited.copy, 'references', 'workflow.md'))).toBe(true)
    expect(existsSync(join(added.copy, '.env'))).toBe(true)
  })

  test('a skill folder the router did not install is never removed, not even the source itself', () => {
    // Arrange: a project whose .claude/skills IS the source folder (a topic bound to the home folder).
    const c = setUp()
    const home = join(c.base, 'home')
    c.write('home/.claude/skills/cook/SKILL.md', '---\nname: ck:cook\n---\n')
    const globalSkill: SourceSkill = { name: 'cook', description: '', dir: join(home, '.claude', 'skills', 'cook'), shared: [] }

    // Act
    const result = removeSkill(home, globalSkill)

    // Assert
    expect(result).toBe('foreign')
    expect(existsSync(join(globalSkill.dir, 'SKILL.md'))).toBe(true)
  })

  test('an unchanged copy is still removable after the source was updated', () => {
    // Arrange
    const c = setUp()
    installSkill(c.project, c.skill)
    c.write('source/cook/SKILL.md', '---\nname: ck:cook\ndescription: v2\n---\n')

    // Act
    const result = removeSkill(c.project, c.skill)

    // Assert
    expect(result).toBe('removed')
    expect(existsSync(c.copy)).toBe(false)
    expect(readdirSync(join(c.project, '.claude'))).toEqual(['skills']) // no trash folder left
  })

  test('install leaves out secrets and links, and brings the shared folders the skill imports', () => {
    // Arrange
    const c = setUp()
    c.write('source/cook/.env', 'GEMINI_API_KEY=secret')
    c.write('source/cook/certs/server.pem', 'key')
    c.write('elsewhere/big.bin', 'outside the skill')
    symlinkSync(join(c.base, 'elsewhere'), join(c.skill.dir, 'linked'), 'junction')

    // Act
    const result = installSkill(c.project, c.skill)

    // Assert
    expect(result).toBe('installed')
    expect(existsSync(join(c.copy, '.env'))).toBe(false)
    expect(existsSync(join(c.copy, 'certs', 'server.pem'))).toBe(false)
    expect(existsSync(join(c.copy, 'linked'))).toBe(false)
    expect(existsSync(join(c.copy, 'references', 'workflow.md'))).toBe(true)
    expect(existsSync(join(projectSkillsDir(c.project), '_shared', 'lib', 'parser.cjs'))).toBe(true)
  })

  test('a temp folder left by a crash does not block the next install', () => {
    // Arrange
    const c = setUp()
    c.write('project/.claude/.skill-installing-cook/half.md', 'half a copy')

    // Act
    const result = installSkill(c.project, c.skill)

    // Assert
    expect(result).toBe('installed')
    expect(existsSync(join(c.copy, 'half.md'))).toBe(false)
    expect(readdirSync(join(c.project, '.claude'))).toEqual(['skills'])
  })
})
