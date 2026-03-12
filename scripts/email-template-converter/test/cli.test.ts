import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../src/index'

const createTempDirectory = async () => {
  const path = join(tmpdir(), `tsforge-cli-${crypto.randomUUID()}`)
  await mkdir(path, { recursive: true })
  return path
}

describe('tsforge CLI', () => {
  it('returns zero for a single file conversion', async () => {
    const message = Buffer.from(
      [
        'Subject: CLI check',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'hello',
        '',
      ].join('\n'),
    )

    const tempdir = await createTempDirectory()
    const inputPath = join(tempdir, 'sample.emltpl')
    const outputDir = join(tempdir, 'out')
    await writeFile(inputPath, message)

    const output: string[] = []
    const exitCode = await main([inputPath, outputDir], {
      writeLine(message) {
        output.push(message)
      },
    })

    expect(exitCode).toBe(0)
    expect(await readFile(join(outputDir, 'sample.oft'))).toBeTruthy()
    expect(output.join('\n')).toContain('Done: 1 converted, 0 failed')
  })

  it('writes alongside the source file when no output directory is provided', async () => {
    const message = Buffer.from(
      [
        'Subject: Inline output check',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'hello',
        '',
      ].join('\n'),
    )

    const tempdir = await createTempDirectory()
    const inputPath = join(tempdir, 'sample.emltpl')
    await writeFile(inputPath, message)

    const exitCode = await main([inputPath], {
      writeLine() {},
    })

    expect(exitCode).toBe(0)
    expect(await readFile(join(tempdir, 'sample.oft'))).toBeTruthy()
  })

  it('returns one for missing input', async () => {
    const tempdir = await createTempDirectory()
    const missingPath = join(tempdir, 'missing.emltpl')
    const output: string[] = []

    const exitCode = await main([missingPath], {
      writeLine(message) {
        output.push(message)
      },
    })

    expect(exitCode).toBe(1)
    expect(output.join('\n')).toContain('Not found:')
  })
})
