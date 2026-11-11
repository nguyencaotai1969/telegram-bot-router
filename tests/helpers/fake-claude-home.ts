import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A Claude Code folder like the user's, in a new temp folder: the ponytail plugin (2 skills), and
 * ~/.claude/skills mixing 20 ClaudeKit skills with another kit's skill and ClaudeKit's shared folder.
 */
export function fakeClaudeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'claude-home-'))
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(home, path)), { recursive: true })
    writeFileSync(join(home, path), text)
  }
  const ponytail = join(home, 'plugins', 'cache', 'ponytail', 'ponytail', '9.9.9')
  write('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'ponytail@ponytail': [{ scope: 'user', installPath: ponytail }] } }))
  write('plugins/cache/ponytail/ponytail/9.9.9/skills/ponytail/SKILL.md', '---\nname: ponytail\ndescription: >\n  Lazy senior dev mode:\n  the smallest change.\nlicense: MIT\n---\n# Ponytail\n')
  write('plugins/cache/ponytail/ponytail/9.9.9/skills/ponytail-audit/SKILL.md', '---\nname: ponytail-audit\ndescription: Quality audit of a whole repo.\n---\n')
  write('skills/cook/SKILL.md', '---\nname: ck:cook\ndescription: "ALWAYS activate this skill before implementing EVERY feature, plan, or fix."\nmetadata:\n  author: claudekit\n---\n')
  write('skills/cook/references/workflow.md', 'steps')
  write('skills/chrome-devtools/SKILL.md', '---\nname: ck:chrome-devtools\ndescription: Automate browsers.\n---\n')
  write('skills/chrome-devtools/scripts/run.js', 'run()')
  write('skills/chrome-devtools/scripts/node_modules/puppeteer/index.js', 'huge')
  write('skills/chrome-devtools/scripts/__pycache__/x.pyc', 'cache')
  write('skills/bmad-prd/SKILL.md', '---\nname: bmad-prd\ndescription: Not ClaudeKit.\n---\n')
  write('skills/_shared/lib/helper.py', 'shared')
  for (let i = 1; i <= 18; i++) {
    write(`skills/extra-${String(i).padStart(2, '0')}/SKILL.md`, `---\nname: ck:extra-${i}\ndescription: Extra skill ${i}.\nmetadata:\n  author: claudekit\n---\n`)
  }
  return home
}
