import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { convertEmltplBuffer, toOftFilename } from '@tsforge/converter'

export type CliIo = {
  writeLine(message: string): void
}

const defaultIo: CliIo = {
  writeLine(message) {
    console.log(message)
  },
}

const usage = 'Usage: tsforge <input.emltpl|directory> [output_dir]'

const isEmltplFile = (filename: string) => extname(filename).toLowerCase() === '.emltpl'

const sizeLabel = (byteLength: number) => `${(byteLength / 1024).toFixed(1)} KB`

export async function main(argv: string[], io: CliIo = defaultIo) {
  const [inputPath, outputDir] = argv

  if (!inputPath) {
    io.writeLine(usage)
    return 1
  }

  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(inputPath)
  } catch {
    io.writeLine(`Not found: ${inputPath}`)
    return 1
  }

  const emltplFiles = stats.isDirectory()
    ? (await readdir(inputPath))
        .filter(isEmltplFile)
        .sort()
        .map((entry) => join(inputPath, entry))
    : [inputPath]

  if (stats.isDirectory() && emltplFiles.length === 0) {
    io.writeLine(`No .emltpl files found in ${inputPath}`)
    return 1
  }

  if (outputDir) {
    await mkdir(outputDir, { recursive: true })
  }

  let succeeded = 0
  let failed = 0

  for (const emltplPath of emltplFiles) {
    const sourceName = basename(emltplPath)
    const destinationDirectory =
      outputDir ?? (stats.isDirectory() ? inputPath : dirname(emltplPath))
    const outputFilename = toOftFilename(sourceName)
    const outputPath = join(destinationDirectory, outputFilename)

    try {
      const raw = await readFile(emltplPath)
      const result = await convertEmltplBuffer(raw, sourceName)
      await writeFile(outputPath, result.oft)
      io.writeLine(`  OK  ${sourceName}  ->  ${outputFilename} (${sizeLabel(result.oft.length)})`)
      succeeded += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      io.writeLine(`  FAIL  ${sourceName}: ${message}`)
      failed += 1
    }
  }

  io.writeLine('')
  io.writeLine(`Done: ${succeeded} converted, ${failed} failed`)
  return failed === 0 ? 0 : 1
}
