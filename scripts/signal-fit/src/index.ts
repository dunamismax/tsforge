import { closeSync, constants, createReadStream, createWriteStream, openSync } from 'node:fs'
import { access, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

export type CliIo = {
  writeLine(message: string): void
}

export type EncoderSupport = {
  aac: boolean
  aacAt: boolean
  libx264: boolean
  libx265: boolean
}

export type MediaProbe = {
  durationSeconds: number
  sizeBytes: number
  audio?: {
    bitRate: number
    channels: number
    codecName?: string
  }
  video: {
    bitRate: number
    codecName?: string
    height: number
    pixFmt?: string
    width: number
  }
}

export type CompressionPlan = {
  audioCodec: 'aac' | 'aac_at' | null
  targetAudioBitrate: number
  targetSizeBytes: number
  targetTotalBitrate: number
  targetVideoBitrate: number
  videoCodec: 'libx264' | 'libx265'
}

type FfprobeDisposition = {
  attached_pic?: number
}

type FfprobeStream = {
  bit_rate?: string
  channels?: number
  codec_name?: string
  codec_type?: string
  disposition?: FfprobeDisposition
  height?: number
  pix_fmt?: string
  width?: number
}

type FfprobeFormat = {
  duration?: string
  format_name?: string
  size?: string
}

type FfprobeData = {
  format?: FfprobeFormat
  streams?: FfprobeStream[]
}

type MainOptions = {
  dryRun: boolean
  headroomBytes: number
  inputFile?: string
  limitBytes: number
  overwrite: boolean
}

type PromptTerminal = {
  close(): void
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
}

const defaultIo: CliIo = {
  writeLine(message) {
    console.log(message)
  },
}

const signalLimitBytes = 100_000_000
const defaultHeadroomBytes = 1_000_000
const helpText = `Usage: bun run script:signal-fit -- [options] [video-file]

Fits a single video file under Signal's 100 MB attachment limit.

Behavior:
  - If the source file is already under the target size, the script remuxes it
    into a sibling file with a _signal suffix.
  - If the file is too large, the script re-encodes it into MP4 using ffmpeg,
    preferring HEVC (libx265) for the best quality per byte.
  - When you run it without a file path in an interactive terminal, it prompts
    you to drag and drop a video file into the window.

Options:
      --dry-run          Print the ffmpeg command(s) without running them
  -h, --help             Show this help message
      --input <file>     Input video file
      --limit-mb <mb>    File size limit in decimal megabytes (default: 100)
  -y, --overwrite        Replace an existing _signal output instead of creating
                         a numbered sibling file
`

let encoderSupportCache: EncoderSupport | null = null

export function parsePositiveNumber(rawValue: string | undefined, fallback: number) {
  const parsed = Number(rawValue)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function sanitizePath(rawPath: string) {
  const trimmed = rawPath.trim()

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

function expandHome(rawPath: string) {
  if (rawPath === '~') {
    return process.env.HOME ?? rawPath
  }

  if (rawPath.startsWith('~/')) {
    return path.join(process.env.HOME ?? '~', rawPath.slice(2))
  }

  return rawPath
}

function unescapeDraggedPath(rawPath: string) {
  return rawPath.replace(/\\(.)/g, '$1')
}

export function resolveUserPathCandidates(rawPath: string) {
  const sanitized = sanitizePath(rawPath)
  const candidates = new Set<string>()

  for (const variant of [sanitized, unescapeDraggedPath(sanitized)]) {
    candidates.add(path.resolve(expandHome(variant)))
  }

  return [...candidates]
}

function parseBitrate(rawBitrate: string | undefined) {
  const parsed = Number(rawBitrate)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
}

function parseByteCount(rawValue: string | undefined) {
  const parsed = Number(rawValue)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
}

async function pathExists(targetPath: string) {
  try {
    await access(targetPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function isFile(targetPath: string) {
  try {
    return (await stat(targetPath)).isFile()
  } catch {
    return false
  }
}

async function commandExists(commandName: string) {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)

  for (const entry of pathEntries) {
    const candidate = path.join(entry, commandName)

    try {
      await access(candidate, constants.X_OK)
      return true
    } catch {}
  }

  return false
}

function formatBytes(byteCount: number) {
  return `${(byteCount / 1_000_000).toFixed(1)} MB`
}

function formatBitrate(bitRate: number) {
  if (bitRate >= 1_000_000) {
    return `${(bitRate / 1_000_000).toFixed(2)} Mbps`
  }

  return `${Math.round(bitRate / 1_000)} kbps`
}

function formatDuration(durationSeconds: number) {
  const totalSeconds = Math.max(0, Math.round(durationSeconds))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function outputLabelForCodec(codec: CompressionPlan['videoCodec']) {
  return codec === 'libx265' ? 'HEVC (libx265)' : 'H.264 (libx264)'
}

function audioLabelForCodec(codec: CompressionPlan['audioCodec']) {
  if (codec === 'aac_at') {
    return 'AAC (AudioToolbox)'
  }

  if (codec === 'aac') {
    return 'AAC'
  }

  return 'None'
}

function getEncoderSupport() {
  if (encoderSupportCache) {
    return encoderSupportCache
  }

  const result = Bun.spawnSync({
    cmd: ['ffmpeg', '-hide_banner', '-encoders'],
    stderr: 'pipe',
    stdout: 'pipe',
  })

  const stdoutText = result.exitCode === 0 ? new TextDecoder().decode(result.stdout) : ''
  const encoderNames = new Set(
    stdoutText
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((value): value is string => Boolean(value)),
  )

  encoderSupportCache = {
    aac: encoderNames.has('aac'),
    aacAt: encoderNames.has('aac_at'),
    libx264: encoderNames.has('libx264'),
    libx265: encoderNames.has('libx265'),
  }

  return encoderSupportCache
}

function preferredAudioCodec(support: EncoderSupport) {
  if (support.aacAt) {
    return 'aac_at' as const
  }

  if (support.aac) {
    return 'aac' as const
  }

  return null
}

function terminalDevicePath(kind: 'input' | 'output') {
  if (process.platform === 'win32') {
    return kind === 'input' ? 'CONIN$' : 'CONOUT$'
  }

  return '/dev/tty'
}

function openPromptTerminal(): PromptTerminal {
  if (input.isTTY && output.isTTY) {
    return {
      close() {},
      input,
      output,
    }
  }

  let inputFd: number | null = null
  let outputFd: number | null = null

  try {
    inputFd = openSync(terminalDevicePath('input'), 'r')
    outputFd = openSync(terminalDevicePath('output'), 'w')

    const terminalInput = createReadStream(terminalDevicePath('input'), {
      autoClose: false,
      fd: inputFd,
    })
    const terminalOutput = createWriteStream(terminalDevicePath('output'), {
      autoClose: false,
      fd: outputFd,
    })

    return {
      close() {
        terminalInput.destroy()
        terminalOutput.destroy()

        if (inputFd !== null) {
          closeSync(inputFd)
          inputFd = null
        }

        if (outputFd !== null) {
          closeSync(outputFd)
          outputFd = null
        }
      },
      input: terminalInput,
      output: terminalOutput,
    }
  } catch {
    if (inputFd !== null) {
      closeSync(inputFd)
    }

    if (outputFd !== null) {
      closeSync(outputFd)
    }

    throw new Error('A video file path is required when no interactive terminal is available.')
  }
}

function writeTerminalLine(terminal: PromptTerminal, message: string) {
  terminal.output.write(`${message}\n`)
}

function probeMedia(sourceFile: string, sizeBytes: number): MediaProbe {
  const result = Bun.spawnSync({
    cmd: [
      'ffprobe',
      '-v',
      'error',
      '-show_entries',
      'format=duration,size,format_name:stream=index,codec_type,codec_name,bit_rate,width,height,pix_fmt,channels,disposition',
      '-of',
      'json',
      sourceFile,
    ],
    stderr: 'pipe',
    stdout: 'pipe',
  })

  if (result.exitCode !== 0) {
    const stderrText = new TextDecoder().decode(result.stderr).trim()
    throw new Error(
      stderrText
        ? `ffprobe failed for ${sourceFile}: ${stderrText}`
        : `ffprobe failed for ${sourceFile}`,
    )
  }

  const stdoutText = new TextDecoder().decode(result.stdout)
  const parsed = JSON.parse(stdoutText) as FfprobeData
  const streams = parsed.streams ?? []
  const mainVideo =
    streams.find(
      (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
    ) ?? streams.find((stream) => stream.codec_type === 'video')
  const firstAudio = streams.find((stream) => stream.codec_type === 'audio')

  if (!mainVideo) {
    throw new Error(`No video stream found in ${sourceFile}`)
  }

  const durationSeconds = Number(parsed.format?.duration)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Could not read the video duration for ${sourceFile}`)
  }

  return {
    durationSeconds,
    sizeBytes: parseByteCount(parsed.format?.size) || sizeBytes,
    audio: firstAudio
      ? {
          bitRate: parseBitrate(firstAudio.bit_rate),
          channels: Math.max(1, firstAudio.channels ?? 2),
          codecName: firstAudio.codec_name,
        }
      : undefined,
    video: {
      bitRate: parseBitrate(mainVideo.bit_rate),
      codecName: mainVideo.codec_name,
      height: mainVideo.height ?? 0,
      pixFmt: mainVideo.pix_fmt,
      width: mainVideo.width ?? 0,
    },
  }
}

export function chooseAudioBitrate(
  sourceAudioBitrate: number,
  channels: number,
  targetTotalBitrate: number,
) {
  const channelCeiling = channels >= 6 ? 192_000 : channels === 1 ? 96_000 : 128_000
  const sourceAware =
    sourceAudioBitrate > 0 ? Math.min(sourceAudioBitrate, channelCeiling) : channelCeiling
  const budgetCap = Math.max(48_000, Math.floor(targetTotalBitrate * 0.2))
  const rounded = Math.floor(Math.min(sourceAware, budgetCap) / 8_000) * 8_000

  return Math.max(48_000, rounded)
}

export function buildCompressionPlan(
  probe: MediaProbe,
  options: {
    headroomBytes?: number
    limitBytes?: number
    support: EncoderSupport
  },
): CompressionPlan {
  const limitBytes = options.limitBytes ?? signalLimitBytes
  const headroomBytes = options.headroomBytes ?? defaultHeadroomBytes

  if (limitBytes <= headroomBytes) {
    throw new Error('The size limit must be larger than the reserved headroom.')
  }

  const videoCodec = options.support.libx265
    ? 'libx265'
    : options.support.libx264
      ? 'libx264'
      : null
  if (!videoCodec) {
    throw new Error('No supported video encoder was found. Install ffmpeg with libx265 or libx264.')
  }

  const audioCodec = probe.audio ? preferredAudioCodec(options.support) : null
  if (probe.audio && !audioCodec) {
    throw new Error('No AAC audio encoder was found in ffmpeg.')
  }

  const targetSizeBytes = Math.floor(limitBytes - headroomBytes)
  const targetTotalBitrate = Math.max(1, Math.floor((targetSizeBytes * 8) / probe.durationSeconds))
  const targetAudioBitrate = probe.audio
    ? chooseAudioBitrate(probe.audio.bitRate, probe.audio.channels, targetTotalBitrate)
    : 0
  const targetVideoBitrate = Math.max(32_000, targetTotalBitrate - targetAudioBitrate)

  return {
    audioCodec,
    targetAudioBitrate,
    targetSizeBytes,
    targetTotalBitrate,
    targetVideoBitrate,
    videoCodec,
  }
}

async function findExistingInput(rawPath: string) {
  for (const candidate of resolveUserPathCandidates(rawPath)) {
    if (await isFile(candidate)) {
      return candidate
    }
  }

  return path.resolve(expandHome(unescapeDraggedPath(sanitizePath(rawPath))))
}

async function promptForInputFile() {
  const terminal = openPromptTerminal()
  const rl = createInterface({
    input: terminal.input,
    output: terminal.output,
  })

  try {
    writeTerminalLine(terminal, 'Signal Video Fit')
    writeTerminalLine(terminal, '')
    writeTerminalLine(terminal, 'Drag a video file into this window and press Enter.')
    writeTerminalLine(terminal, '')

    while (true) {
      const answer = await rl.question('Video file: ')
      const candidate = await findExistingInput(answer)

      if (await isFile(candidate)) {
        return candidate
      }

      writeTerminalLine(terminal, `File not found: ${candidate}`)
    }
  } finally {
    rl.close()
    terminal.close()
  }
}

async function makeOutputPath(sourceFile: string, extension: string, overwrite: boolean) {
  const parsed = path.parse(sourceFile)
  const desiredPath = path.join(parsed.dir, `${parsed.name}_signal${extension}`)

  if (overwrite || !(await pathExists(desiredPath))) {
    return desiredPath
  }

  for (let index = 2; ; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}_signal-${index}${extension}`)

    if (!(await pathExists(candidate))) {
      return candidate
    }
  }
}

function buildStreamCopyCommand(sourceFile: string, outputFile: string) {
  return [
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-i',
    sourceFile,
    '-map',
    '0',
    '-c',
    'copy',
    outputFile,
  ]
}

function buildFirstPassCommand(sourceFile: string, plan: CompressionPlan, passLogFile: string) {
  if (plan.videoCodec === 'libx265') {
    return [
      'ffmpeg',
      '-hide_banner',
      '-loglevel',
      'warning',
      '-y',
      '-i',
      sourceFile,
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-c:v:0',
      'libx265',
      '-preset',
      process.env.TSFORGE_SIGNAL_FIT_PRESET ?? 'medium',
      '-tag:v:0',
      'hvc1',
      '-pix_fmt:v:0',
      'yuv420p',
      '-b:v:0',
      String(plan.targetVideoBitrate),
      '-x265-params',
      `pass=1:stats=${passLogFile}:repeat-headers=1`,
      '-f',
      'mp4',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
    ]
  }

  return [
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-i',
    sourceFile,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-c:v:0',
    'libx264',
    '-preset',
    process.env.TSFORGE_SIGNAL_FIT_PRESET ?? 'medium',
    '-pix_fmt:v:0',
    'yuv420p',
    '-b:v:0',
    String(plan.targetVideoBitrate),
    '-pass:v:0',
    '1',
    '-passlogfile:v:0',
    passLogFile,
    '-f',
    'mp4',
    process.platform === 'win32' ? 'NUL' : '/dev/null',
  ]
}

function buildSecondPassCommand(
  sourceFile: string,
  outputFile: string,
  plan: CompressionPlan,
  passLogFile: string,
) {
  const command = [
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-i',
    sourceFile,
    '-map',
    '0:v:0',
  ]

  if (plan.targetAudioBitrate > 0 && plan.audioCodec) {
    command.push('-map', '0:a:0?')
  }

  command.push('-map_metadata', '0', '-sn', '-dn')

  if (plan.videoCodec === 'libx265') {
    command.push(
      '-c:v:0',
      'libx265',
      '-preset',
      process.env.TSFORGE_SIGNAL_FIT_PRESET ?? 'medium',
      '-tag:v:0',
      'hvc1',
      '-pix_fmt:v:0',
      'yuv420p',
      '-b:v:0',
      String(plan.targetVideoBitrate),
      '-x265-params',
      `pass=2:stats=${passLogFile}:repeat-headers=1`,
    )
  } else {
    command.push(
      '-c:v:0',
      'libx264',
      '-preset',
      process.env.TSFORGE_SIGNAL_FIT_PRESET ?? 'medium',
      '-pix_fmt:v:0',
      'yuv420p',
      '-b:v:0',
      String(plan.targetVideoBitrate),
      '-pass:v:0',
      '2',
      '-passlogfile:v:0',
      passLogFile,
    )
  }

  if (plan.targetAudioBitrate > 0 && plan.audioCodec) {
    command.push('-c:a', plan.audioCodec, '-b:a', String(plan.targetAudioBitrate))
  } else {
    command.push('-an')
  }

  command.push('-movflags', '+faststart', outputFile)
  return command
}

async function runCommand(command: string[]) {
  const processHandle = Bun.spawn({
    cmd: command,
    stderr: 'inherit',
    stdout: 'inherit',
  })

  return processHandle.exited
}

function printCommand(io: CliIo, command: string[]) {
  io.writeLine(command.join(' '))
}

function printSummary(
  io: CliIo,
  sourceFile: string,
  probe: MediaProbe,
  outputFile: string,
  options: {
    limitBytes: number
    mode: 'copy' | 'encode'
    plan?: CompressionPlan
  },
) {
  io.writeLine('')
  io.writeLine('Signal Video Fit')
  io.writeLine(`Input:      ${sourceFile}`)
  io.writeLine(`Output:     ${outputFile}`)
  io.writeLine(`Duration:   ${formatDuration(probe.durationSeconds)}`)
  io.writeLine(`Source:     ${formatBytes(probe.sizeBytes)}`)

  if (options.mode === 'copy') {
    io.writeLine(`Mode:       Stream copy (already under ${formatBytes(options.limitBytes)})`)
    return
  }

  const plan = options.plan
  if (!plan) {
    return
  }

  io.writeLine(`Limit:      ${formatBytes(options.limitBytes)}`)
  io.writeLine(`Target:     ${formatBytes(plan.targetSizeBytes)}`)
  io.writeLine(`Mode:       Re-encode`)
  io.writeLine(
    `Video:      ${outputLabelForCodec(plan.videoCodec)} @ ${formatBitrate(plan.targetVideoBitrate)}`,
  )
  io.writeLine(
    `Audio:      ${audioLabelForCodec(plan.audioCodec)}${plan.targetAudioBitrate > 0 ? ` @ ${formatBitrate(plan.targetAudioBitrate)}` : ''}`,
  )
}

async function runWithOptions(options: MainOptions, io: CliIo) {
  if (!(await commandExists('ffmpeg'))) {
    throw new Error('ffmpeg is not installed or not on PATH.')
  }

  if (!(await commandExists('ffprobe'))) {
    throw new Error('ffprobe is not installed or not on PATH.')
  }

  const sourceFile = options.inputFile
    ? await findExistingInput(options.inputFile)
    : await promptForInputFile()

  if (!(await isFile(sourceFile))) {
    throw new Error(`Video file not found: ${sourceFile}`)
  }

  const sourceStats = await stat(sourceFile)
  const probe = probeMedia(sourceFile, sourceStats.size)

  if (sourceStats.size <= options.limitBytes - options.headroomBytes) {
    const outputFile = await makeOutputPath(
      sourceFile,
      path.extname(sourceFile) || '.mp4',
      options.overwrite,
    )
    const command = buildStreamCopyCommand(sourceFile, outputFile)

    printSummary(io, sourceFile, probe, outputFile, {
      limitBytes: options.limitBytes,
      mode: 'copy',
    })

    if (options.dryRun) {
      io.writeLine('')
      printCommand(io, command)
      return 0
    }

    const exitCode = await runCommand(command)
    if (exitCode !== 0) {
      throw new Error('ffmpeg could not remux the source file.')
    }

    const outputStats = await stat(outputFile)
    io.writeLine('')
    io.writeLine(`Done: ${path.basename(outputFile)} (${formatBytes(outputStats.size)})`)
    return 0
  }

  const plan = buildCompressionPlan(probe, {
    headroomBytes: options.headroomBytes,
    limitBytes: options.limitBytes,
    support: getEncoderSupport(),
  })
  const outputFile = await makeOutputPath(sourceFile, '.mp4', options.overwrite)
  const tempDir = await mkdtemp(path.join(tmpdir(), 'tsforge-signal-fit-'))
  const passLogFile = path.join(tempDir, 'passlog')
  const firstPassCommand = buildFirstPassCommand(sourceFile, plan, passLogFile)
  const secondPassCommand = buildSecondPassCommand(sourceFile, outputFile, plan, passLogFile)

  printSummary(io, sourceFile, probe, outputFile, {
    limitBytes: options.limitBytes,
    mode: 'encode',
    plan,
  })

  if (options.dryRun) {
    io.writeLine('')
    io.writeLine('First pass:')
    printCommand(io, firstPassCommand)
    io.writeLine('')
    io.writeLine('Second pass:')
    printCommand(io, secondPassCommand)
    await rm(tempDir, { force: true, recursive: true })
    return 0
  }

  try {
    io.writeLine('')
    io.writeLine('Pass 1/2')
    const firstPassExitCode = await runCommand(firstPassCommand)
    if (firstPassExitCode !== 0) {
      throw new Error('ffmpeg failed during pass 1.')
    }

    io.writeLine('')
    io.writeLine('Pass 2/2')
    const secondPassExitCode = await runCommand(secondPassCommand)
    if (secondPassExitCode !== 0) {
      throw new Error('ffmpeg failed during pass 2.')
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true })
  }

  const outputStats = await stat(outputFile)
  if (outputStats.size > options.limitBytes) {
    throw new Error(
      `The output file is still too large (${formatBytes(outputStats.size)}). Try TSFORGE_SIGNAL_FIT_PRESET=slow for more compression.`,
    )
  }

  io.writeLine('')
  io.writeLine(`Done: ${path.basename(outputFile)} (${formatBytes(outputStats.size)})`)
  return 0
}

export async function main(argv: string[], io: CliIo = defaultIo) {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean' },
        help: { short: 'h', type: 'boolean' },
        input: { type: 'string' },
        'limit-mb': { type: 'string' },
        overwrite: { short: 'y', type: 'boolean' },
      },
      strict: true,
    })

    if (values.help) {
      io.writeLine(helpText)
      return 0
    }

    const options: MainOptions = {
      dryRun: values['dry-run'] ?? false,
      headroomBytes: defaultHeadroomBytes,
      inputFile: values.input ?? positionals[0],
      limitBytes: Math.round(
        parsePositiveNumber(values['limit-mb'], signalLimitBytes / 1_000_000) * 1_000_000,
      ),
      overwrite: values.overwrite ?? false,
    }

    return await runWithOptions(options, io)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.writeLine(`Error: ${message}`)
    return 1
  }
}
