import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TelegramApiError, type FileOptions } from '../src/telegram-api'
import { sendOutgoingFiles, takeOutgoingFiles } from '../src/telegram-outgoing-files'
import type { TgMessage } from '../src/telegram-types'
import { FakeBotApi } from './helpers/fake-telegram'

const PROJECT = resolve('/projects/game')

describe('📎 lines in what Claude writes', () => {
  test('each 📎 line names a file: absolute, relative to the project, quoted, from home, with a caption', () => {
    // Arrange
    const text = [
      'Bản đồ bot đã đi:',
      `📎 ${join(PROJECT, 'out', 'map-33.png')} | Phụ bản 33: 19/56 điểm`,
      '- 📎 `captures/board.png`',
      '📎 "~/report.pdf"',
      '',
      'Xong.',
    ].join('\n')

    // Act
    const { text: rest, files } = takeOutgoingFiles(text, PROJECT)

    // Assert
    expect(files).toEqual([
      { path: join(PROJECT, 'out', 'map-33.png'), caption: 'Phụ bản 33: 19/56 điểm' },
      { path: join(PROJECT, 'captures', 'board.png') },
      { path: join(homedir(), 'report.pdf') },
    ])
    expect(rest).toBe('Bản đồ bot đã đi:\n\nXong.')
  })

  test.skipIf(process.platform !== 'win32')('a Git Bash path is read as the Windows path it stands for', () => {
    // Act
    const { files } = takeOutgoingFiles('📎 /d/nodejs/jxt3/out/a.png\n📎 /tmp/shot.png', PROJECT)

    // Assert
    expect(files).toEqual([{ path: 'D:\\nodejs\\jxt3\\out\\a.png' }, { path: join(tmpdir(), 'shot.png') }])
  })

  test('numbered and • list items count; a 📎 in a ``` block or a > quote is an example, not a file', () => {
    // Arrange
    const text = ['1. 📎 a.png', '• 📎 b.png', '📎\uFE0F **c.png**', '```', '📎 <path>', '```', '> 📎 quoted.png'].join('\n')

    // Act
    const { text: rest, files } = takeOutgoingFiles(text, PROJECT)

    // Assert
    expect(files.map(file => file.path)).toEqual(['a.png', 'b.png', 'c.png'].map(name => join(PROJECT, name)))
    expect(rest).toBe(['```', '📎 <path>', '```', '> 📎 quoted.png'].join('\n'))
  })

  test('text without 📎 lines stays exactly as it is; a 📎 inside a sentence names no file', () => {
    // Arrange
    const text = 'Gửi ảnh bằng dòng 📎 riêng.\n\n\n\nHết.'

    // Act
    const result = takeOutgoingFiles(text, PROJECT)

    // Assert
    expect(result).toEqual({ text, files: [] })
  })
})

describe('sending the files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'outgoing-files-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const place = { chatId: -100123, threadId: 7, replyTo: 42 }

  test('an image Telegram refuses as a photo goes again as a file', async () => {
    // Arrange: Telegram turns down photos whose size in pixels it does not take.
    const picture = join(dir, 'wide.png')
    writeFileSync(picture, new Uint8Array(64))
    const api = new FakeBotApi()
    const sendFile = api.sendFile.bind(api)
    api.sendFile = (chatId: number, path: string, opts: FileOptions = {}): Promise<TgMessage> => {
      if (opts.photo) return Promise.reject(new TelegramApiError('sendPhoto', 400, 'Bad Request: PHOTO_INVALID_DIMENSIONS'))
      return sendFile(chatId, path, opts)
    }

    // Act
    await sendOutgoingFiles(api, place, [{ path: picture, caption: 'toàn cảnh' }])

    // Assert
    expect(api.log.map(item => [item.kind, item.text, item.replyTo])).toEqual([['file', 'wide.png:document:toàn cảnh', 42]])
  })

  test('secrets are never uploaded, even when they exist and Claude names them', async () => {
    // Arrange: what a prompt injection would ask Claude to send.
    const envFile = join(dir, '.env')
    writeFileSync(envFile, 'TELEGRAM_BOT_TOKEN=x')
    const api = new FakeBotApi()

    // Act
    await sendOutgoingFiles(api, place, [{ path: envFile }, { path: join(homedir(), '.ssh', 'config') }])

    // Assert
    expect(api.log.filter(item => item.kind === 'file')).toEqual([])
    expect(api.log.map(item => item.text)).toEqual([
      '⚠️ Không gửi được tệp .env: tệp bí mật (token, khoá), bot không gửi',
      '⚠️ Không gửi được tệp config: tệp bí mật (token, khoá), bot không gửi',
    ])
  })

  test('a file that is not an image goes as a file; a missing one gets a note, and the next still goes', async () => {
    // Arrange
    const report = join(dir, 'report.txt')
    writeFileSync(report, 'ok')
    const api = new FakeBotApi()

    // Act
    await sendOutgoingFiles(api, place, [{ path: join(dir, 'gone.png') }, { path: report }])

    // Assert
    expect(api.log.map(item => [item.kind, item.text])).toEqual([
      ['send', `⚠️ Không gửi được tệp gone.png: không có tệp ${join(dir, 'gone.png')}`],
      ['file', 'report.txt:document:'],
    ])
  })
})
