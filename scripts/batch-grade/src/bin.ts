#!/usr/bin/env bun

import { constants } from 'node:fs'
import { access, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

type OutputProfile = 'source-match' | 'source-match-software' | 'edit' | 'edit-hq'

type Settings = {
  dryRun: boolean
  inputDir: string
  interp: string
  lutFile: string
  outputDir: string
  overwrite: boolean
  profile: OutputProfile
  recursive: boolean
}

type EncoderSupport = {
  hevcVideotoolbox: boolean
  libx265: boolean
  proresKs: boolean
  proresVideotoolbox: boolean
}

type FfprobeDisposition = {
  attached_pic?: number
}

type FfprobeStream = {
  bit_rate?: string
  codec_name?: string
  codec_type?: string
  color_primaries?: string
  color_space?: string
  color_transfer?: string
  disposition?: FfprobeDisposition
  index?: number
  pix_fmt?: string
  profile?: string
}

type FfprobeFormat = {
  bit_rate?: string
  format_name?: string
}

type FfprobeData = {
  format?: FfprobeFormat
  streams?: FfprobeStream[]
}

type SourceProbe = {
  colorPrimaries?: string
  colorSpace?: string
  colorTransfer?: string
  overallBitrate: number
}

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = path.dirname(scriptPath)
const repoRoot = path.resolve(scriptDir, '../../..')
const defaultInterp = 'tetrahedral'
const defaultLut = path.join(repoRoot, 'luts', 'dji-official', 'DJI_Mini5Pro_DLogM_to_Rec709.cube')
const envVars = {
  encoder: ['TSFORGE_BATCH_GRADE_ENCODER', 'SVM_ENCODER'],
  interp: ['TSFORGE_BATCH_GRADE_INTERP', 'SVM_INTERP'],
  overwrite: ['TSFORGE_BATCH_GRADE_OVERWRITE', 'SVM_OVERWRITE'],
  preset: ['TSFORGE_BATCH_GRADE_PRESET', 'SVM_PRESET'],
  profile: ['TSFORGE_BATCH_GRADE_PROFILE', 'SVM_PROFILE'],
  recursive: ['TSFORGE_BATCH_GRADE_RECURSIVE', 'SVM_RECURSIVE'],
  vtMatchMultiplier: ['TSFORGE_BATCH_GRADE_VT_MATCH_MULTIPLIER', 'SVM_VT_MATCH_MULTIPLIER'],
} as const

let encoderSupportCache: EncoderSupport | null = null

const helpText = `Usage: bun ${path.relative(process.cwd(), scriptPath)} [options] [inputDir] [outputDir] [lutFile]

If you run this without all three core arguments in an interactive terminal, it
starts a guided setup flow and prompts for the input folder, output folder, LUT,
output profile, and overwrite behavior.

Profiles:
  source-match           MP4 + HEVC 10-bit, targets the original file bitrate
  source-match-software  Same goal via libx265, slower than the default
  edit                   ProRes 422 MOV
  edit-hq                ProRes 422 HQ MOV

Options:
  -i, --interactive       Force the setup wizard
  -r, --recursive         Scan subfolders too
  -y, --overwrite         Replace existing outputs
      --dry-run           Print what would run without encoding files
      --profile <name>    source-match, source-match-software, edit, or edit-hq
      --encoder <name>    Backward-compatible alias for --profile
      --input <dir>       Input folder
      --output <dir>      Output folder
      --lut <file>        LUT file path
      --interp <mode>     lut3d interpolation mode (default: ${defaultInterp})
  -h, --help              Show this help message

Environment overrides:
  TSFORGE_BATCH_GRADE_PROFILE
  TSFORGE_BATCH_GRADE_ENCODER
  TSFORGE_BATCH_GRADE_INTERP
  TSFORGE_BATCH_GRADE_OVERWRITE
  TSFORGE_BATCH_GRADE_RECURSIVE
  TSFORGE_BATCH_GRADE_VT_MATCH_MULTIPLIER
  TSFORGE_BATCH_GRADE_PRESET

Legacy SVM_* names are still accepted.
`

function parseEnvBoolean(value: string | undefined, fallback = false) {
  if (!value) {
    return fallback
  }

  return /^(1|true|yes|y)$/i.test(value)
}

function parsePositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }

  return fallback
}

function readEnvValue(names: readonly string[]) {
  for (const name of names) {
    const value = process.env[name]

    if (value) {
      return value
    }
  }

  return undefined
}

function sanitizePath(raw: string) {
  const trimmed = raw.trim()

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

function normalizeUserPath(rawPath: string) {
  return path.resolve(expandHome(sanitizePath(rawPath)))
}

function parseBitrate(rawBitrate: string | undefined) {
  const parsed = Number(rawBitrate)
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

async function isDirectory(targetPath: string) {
  try {
    return (await stat(targetPath)).isDirectory()
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

function isSubpath(childPath: string, parentPath: string) {
  const relative = path.relative(parentPath, childPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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

function escapeFilterPath(filePath: string) {
  return filePath.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'")
}

function isEditProfile(profile: OutputProfile) {
  return profile === 'edit' || profile === 'edit-hq'
}

function profileLabel(profile: OutputProfile) {
  switch (profile) {
    case 'source-match':
      return 'Source-matched HEVC MP4 (recommended)'
    case 'source-match-software':
      return 'Source-matched HEVC MP4 via libx265'
    case 'edit':
      return 'Editing master (ProRes 422 MOV)'
    case 'edit-hq':
      return 'Editing master HQ (ProRes 422 HQ MOV)'
  }
}

function normalizeProfileName(rawProfile: string) {
  return rawProfile.trim().toLowerCase().replaceAll('_', '-')
}

function validateOutputProfile(rawProfile: string | undefined): OutputProfile | undefined {
  if (!rawProfile) {
    return undefined
  }

  switch (normalizeProfileName(rawProfile)) {
    case 'source-match':
    case 'source':
    case 'match':
    case 'original':
    case 'hevc':
    case 'hevc-videotoolbox':
    case 'source-match-fast':
    case 'delivery':
      return 'source-match'
    case 'source-match-software':
    case 'match-software':
    case 'software':
    case 'libx265':
    case 'delivery-software':
      return 'source-match-software'
    case 'edit':
    case 'editing':
    case 'prores':
    case 'prores-422':
      return 'edit'
    case 'edit-hq':
    case 'editing-hq':
    case 'prores-422-hq':
      return 'edit-hq'
    default:
      throw new Error(
        `Unsupported profile "${rawProfile}". Use "source-match", "source-match-software", "edit", or "edit-hq".`,
      )
  }
}

function getEncoderSupport(): EncoderSupport {
  if (encoderSupportCache) {
    return encoderSupportCache
  }

  const result = Bun.spawnSync({
    cmd: ['ffmpeg', '-hide_banner', '-encoders'],
    stderr: 'pipe',
    stdout: 'pipe',
  })

  const stdoutText = result.exitCode === 0 ? new TextDecoder().decode(result.stdout) : ''

  encoderSupportCache = {
    hevcVideotoolbox: stdoutText.includes('hevc_videotoolbox'),
    libx265: stdoutText.includes('libx265'),
    proresKs: stdoutText.includes('prores_ks'),
    proresVideotoolbox: stdoutText.includes('prores_videotoolbox'),
  }

  return encoderSupportCache
}

function detectDefaultProfile(): OutputProfile {
  const support = getEncoderSupport()

  if (support.hevcVideotoolbox) {
    return 'source-match'
  }

  if (support.libx265) {
    return 'source-match-software'
  }

  if (support.proresVideotoolbox || support.proresKs) {
    return 'edit'
  }

  return 'edit-hq'
}

function sourceMatchRequestBitrate(source: SourceProbe) {
  const multiplier = parsePositiveNumber(readEnvValue(envVars.vtMatchMultiplier), 1.5)
  return Math.max(1, Math.round(source.overallBitrate * multiplier))
}

function buildEncodeArgs(profile: OutputProfile, source: SourceProbe) {
  const support = getEncoderSupport()

  switch (profile) {
    case 'source-match':
      if (support.hevcVideotoolbox) {
        const requestBitrate = sourceMatchRequestBitrate(source)

        return [
          '-c:v:0',
          'hevc_videotoolbox',
          '-profile:v:0',
          'main10',
          '-tag:v:0',
          'hvc1',
          '-pix_fmt:v:0',
          'p010le',
          '-b:v:0',
          String(requestBitrate),
          '-maxrate:v:0',
          String(requestBitrate),
          '-bufsize:v:0',
          String(requestBitrate * 2),
          '-constant_bit_rate:v:0',
          'true',
        ]
      }

      return buildEncodeArgs('source-match-software', source)
    case 'source-match-software': {
      if (!support.libx265) {
        throw new Error('libx265 is not available in ffmpeg.')
      }

      const bitrate = Math.max(1, source.overallBitrate)
      const bitrateKbps = Math.max(1, Math.round(bitrate / 1000))
      const bufferKbps = bitrateKbps * 2

      return [
        '-c:v:0',
        'libx265',
        '-profile:v:0',
        'main10',
        '-tag:v:0',
        'hvc1',
        '-pix_fmt:v:0',
        'yuv420p10le',
        '-preset',
        readEnvValue(envVars.preset) ?? 'medium',
        '-b:v:0',
        String(bitrate),
        '-maxrate:v:0',
        String(bitrate),
        '-bufsize:v:0',
        String(bitrate * 2),
        '-x265-params',
        `repeat-headers=1:hrd=1:vbv-maxrate=${bitrateKbps}:vbv-bufsize=${bufferKbps}`,
      ]
    }
    case 'edit':
      if (support.proresVideotoolbox) {
        return [
          '-c:v:0',
          'prores_videotoolbox',
          '-profile:v:0',
          'standard',
          '-pix_fmt:v:0',
          'p210le',
        ]
      }

      if (support.proresKs) {
        return [
          '-c:v:0',
          'prores_ks',
          '-profile:v:0',
          '2',
          '-pix_fmt:v:0',
          'yuv422p10le',
          '-vendor',
          'apl0',
        ]
      }

      throw new Error('No ProRes encoder was found in ffmpeg.')
    case 'edit-hq':
      if (support.proresVideotoolbox) {
        return ['-c:v:0', 'prores_videotoolbox', '-profile:v:0', 'hq', '-pix_fmt:v:0', 'p210le']
      }

      if (support.proresKs) {
        return [
          '-c:v:0',
          'prores_ks',
          '-profile:v:0',
          '3',
          '-pix_fmt:v:0',
          'yuv422p10le',
          '-vendor',
          'apl0',
        ]
      }

      throw new Error('No ProRes encoder was found in ffmpeg.')
  }
}

function buildMuxArgs(profile: OutputProfile) {
  if (isEditProfile(profile)) {
    return [] as string[]
  }

  return ['-movflags', '+faststart']
}

async function collectFiles(
  startDir: string,
  predicate: (fullPath: string) => boolean,
  options: {
    excludeDir?: string
    recursive: boolean
  },
): Promise<string[]> {
  const files: string[] = []

  const walk = async (currentDir: string) => {
    const entries = await readdir(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        if (options.excludeDir && fullPath === options.excludeDir) {
          continue
        }

        if (options.recursive) {
          await walk(fullPath)
        }

        continue
      }

      if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath)
      }
    }
  }

  await walk(startDir)

  return files.sort((left, right) => left.localeCompare(right))
}

async function discoverLutFiles() {
  const lutRoot = path.join(repoRoot, 'luts')

  if (!(await isDirectory(lutRoot))) {
    return [] as string[]
  }

  return collectFiles(lutRoot, (fullPath) => /\.(cube|3dl|lut)$/i.test(fullPath), {
    recursive: true,
  })
}

async function collectVideoFiles(settings: Pick<Settings, 'inputDir' | 'outputDir' | 'recursive'>) {
  const excludeDir = isSubpath(settings.outputDir, settings.inputDir)
    ? settings.outputDir
    : undefined

  return collectFiles(
    settings.inputDir,
    (fullPath) => {
      const normalized = fullPath.toLowerCase()
      return /\.(mp4|mov|m4v)$/i.test(normalized) && !/_graded\.(mp4|mov|m4v)$/i.test(normalized)
    },
    {
      excludeDir,
      recursive: settings.recursive,
    },
  )
}

function outputExtensionForFile(profile: OutputProfile, sourceFile: string) {
  if (isEditProfile(profile)) {
    return '.mov'
  }

  const extension = path.extname(sourceFile).toLowerCase()
  return extension || '.mp4'
}

function outputPathFor(
  sourceFile: string,
  settings: Pick<Settings, 'inputDir' | 'outputDir' | 'profile'>,
) {
  const relativePath = path.relative(settings.inputDir, sourceFile)
  const stem = relativePath.replace(/\.[^.]+$/, '')
  const extension = outputExtensionForFile(settings.profile, sourceFile)

  return path.join(settings.outputDir, `${stem}_graded${extension}`)
}

function probeSourceFile(sourceFile: string): SourceProbe {
  const result = Bun.spawnSync({
    cmd: [
      'ffprobe',
      '-v',
      'error',
      '-show_entries',
      'format=bit_rate,format_name:stream=index,codec_type,codec_name,profile,pix_fmt,bit_rate,color_space,color_transfer,color_primaries,disposition',
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

  if (!mainVideo) {
    throw new Error(`No video stream found in ${sourceFile}`)
  }

  const videoBitrate = parseBitrate(mainVideo.bit_rate)
  const formatBitrate = parseBitrate(parsed.format?.bit_rate)
  const overallBitrate = Math.max(formatBitrate, videoBitrate, 1)

  return {
    colorPrimaries: mainVideo.color_primaries,
    colorSpace: mainVideo.color_space,
    colorTransfer: mainVideo.color_transfer,
    overallBitrate,
  }
}

async function promptText(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue?: string,
) {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    const answer = sanitizePath(await rl.question(`${label}${suffix}: `))
    const value = answer || defaultValue

    if (value) {
      return value
    }

    console.log('Please enter a value.')
  }
}

async function promptYesNo(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: boolean,
) {
  const suffix = defaultValue ? '[Y/n]' : '[y/N]'

  while (true) {
    const answer = (await rl.question(`${label} ${suffix}: `)).trim().toLowerCase()

    if (!answer) {
      return defaultValue
    }

    if (['y', 'yes'].includes(answer)) {
      return true
    }

    if (['n', 'no'].includes(answer)) {
      return false
    }

    console.log('Please answer y or n.')
  }
}

async function promptExistingDirectory(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue?: string,
) {
  while (true) {
    const answer = await promptText(rl, label, defaultValue)
    const normalized = normalizeUserPath(answer)

    if (await isDirectory(normalized)) {
      return normalized
    }

    console.log(`Folder not found: ${normalized}`)
  }
}

async function promptOutputDirectory(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: string,
) {
  while (true) {
    const answer = await promptText(rl, label, defaultValue)
    const normalized = normalizeUserPath(answer)
    const parentDir = path.dirname(normalized)

    if ((await pathExists(normalized)) && !(await isDirectory(normalized))) {
      console.log(`A file already exists at: ${normalized}`)
      continue
    }

    if (await isDirectory(parentDir)) {
      return normalized
    }

    console.log(`Parent folder not found: ${parentDir}`)
  }
}

async function promptLutFile(rl: ReturnType<typeof createInterface>, providedDefault?: string) {
  const luts = await discoverLutFiles()
  const defaultPath = providedDefault ? normalizeUserPath(providedDefault) : defaultLut
  const defaultIndex = luts.indexOf(defaultPath)

  console.log('\nAvailable LUTs:')
  if (luts.length === 0) {
    console.log(`  No LUTs found under ${path.join(repoRoot, 'luts')}`)
  } else {
    luts.forEach((lut, index) => {
      console.log(`  ${index + 1}) ${path.relative(repoRoot, lut)}`)
    })
  }
  console.log('  0) Enter a custom LUT path\n')

  const defaultChoice = defaultIndex >= 0 ? String(defaultIndex + 1) : luts.length > 0 ? '1' : '0'

  while (true) {
    const answer = sanitizePath(await rl.question(`Choose LUT [${defaultChoice}]: `))
    const choice = answer || defaultChoice

    if (choice === '0' || choice.toLowerCase() === 'custom') {
      const customPath = normalizeUserPath(await promptText(rl, 'Custom LUT file', defaultPath))

      if (await isFile(customPath)) {
        return customPath
      }

      console.log(`LUT file not found: ${customPath}`)
      continue
    }

    const selectedIndex = Number(choice)
    if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= luts.length) {
      const selectedLut = luts[selectedIndex - 1]

      if (selectedLut) {
        return selectedLut
      }
    }

    const directPath = normalizeUserPath(choice)
    if (await isFile(directPath)) {
      return directPath
    }

    console.log('Enter a menu number or paste a LUT file path.')
  }
}

async function promptProfile(
  rl: ReturnType<typeof createInterface>,
  defaultProfile: OutputProfile,
) {
  console.log('\nOutput profiles:')
  console.log('  1) Source-matched HEVC MP4 (recommended)')
  console.log('  2) Source-matched HEVC MP4 via libx265 (slower)')
  console.log('  3) ProRes 422 MOV')
  console.log('  4) ProRes 422 HQ MOV')
  console.log('')

  const defaultChoice = (() => {
    switch (defaultProfile) {
      case 'source-match':
        return '1'
      case 'source-match-software':
        return '2'
      case 'edit':
        return '3'
      case 'edit-hq':
        return '4'
    }
  })()

  while (true) {
    const answer = (await rl.question(`Choose output profile [${defaultChoice}]: `))
      .trim()
      .toLowerCase()
    const choice = answer || defaultChoice

    switch (choice) {
      case '1':
      case 'source-match':
      case 'match':
      case 'original':
        return 'source-match' as const
      case '2':
      case 'source-match-software':
      case 'libx265':
      case 'software':
        return 'source-match-software' as const
      case '3':
      case 'edit':
      case 'prores':
        return 'edit' as const
      case '4':
      case 'edit-hq':
      case 'prores-422-hq':
        return 'edit-hq' as const
      default:
        console.log('Please enter 1, 2, 3, or 4.')
    }
  }
}

function printSummary(settings: Settings, fileCount: number) {
  console.log('\nReady to grade:')
  console.log(`  Input:      ${settings.inputDir}`)
  console.log(`  Output:     ${settings.outputDir}`)
  console.log(`  LUT:        ${settings.lutFile}`)
  console.log(`  Files:      ${fileCount}`)
  console.log(`  Profile:    ${profileLabel(settings.profile)}`)
  console.log(`  Overwrite:  ${settings.overwrite ? 'yes' : 'no'}`)
  console.log(`  Recursive:  ${settings.recursive ? 'yes' : 'no'}`)
  console.log(`  Dry run:    ${settings.dryRun ? 'yes' : 'no'}`)

  if (settings.profile === 'source-match') {
    console.log('  Note:       Matches original MP4/HEVC bitrate as closely as ffmpeg allows.')
  }
}

async function buildInteractiveSettings(defaults: Partial<Settings>) {
  const rl = createInterface({ input, output })

  try {
    console.log('Batch LUT Grading')
    console.log('')
    console.log('Press Enter to accept defaults.')
    console.log('You can drag folders or LUT files into Terminal.')
    console.log('')

    const inputDir = await promptExistingDirectory(rl, 'Input folder', defaults.inputDir)
    const outputDir = await promptOutputDirectory(
      rl,
      'Output folder',
      defaults.outputDir ?? path.join(inputDir, 'graded'),
    )

    if (inputDir === outputDir) {
      throw new Error('Output folder must be different from the input folder.')
    }

    const lutFile = await promptLutFile(rl, defaults.lutFile)
    const profile = defaults.profile ?? (await promptProfile(rl, detectDefaultProfile()))
    const overwrite =
      defaults.overwrite ?? (await promptYesNo(rl, 'Overwrite existing graded files?', false))
    const recursive = defaults.recursive ?? (await promptYesNo(rl, 'Scan subfolders too?', false))
    const dryRun = defaults.dryRun ?? false

    const settings: Settings = {
      dryRun,
      inputDir,
      interp: defaults.interp ?? readEnvValue(envVars.interp) ?? defaultInterp,
      lutFile,
      outputDir,
      overwrite,
      profile,
      recursive,
    }

    const files = await collectVideoFiles(settings)
    printSummary(settings, files.length)

    const startNow = await promptYesNo(rl, 'Start grading now?', true)
    if (!startNow) {
      throw new Error('Cancelled before grading started.')
    }

    return settings
  } finally {
    rl.close()
  }
}

async function run() {
  process.on('SIGINT', () => {
    console.log('\nCancelled.')
    process.exit(130)
  })

  if (!(await commandExists('ffmpeg'))) {
    throw new Error('ffmpeg is not installed or not on PATH.')
  }

  if (!(await commandExists('ffprobe'))) {
    throw new Error('ffprobe is not installed or not on PATH.')
  }

  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      encoder: { type: 'string' },
      help: { short: 'h', type: 'boolean' },
      input: { type: 'string' },
      interactive: { short: 'i', type: 'boolean' },
      interp: { type: 'string' },
      lut: { type: 'string' },
      output: { type: 'string' },
      overwrite: { short: 'y', type: 'boolean' },
      profile: { type: 'string' },
      recursive: { short: 'r', type: 'boolean' },
    },
    strict: true,
  })

  if (values.help) {
    console.log(helpText)
    return
  }

  const inputDirArg = values.input ?? positionals[0]
  const outputDirArg = values.output ?? positionals[1]
  const lutFileArg = values.lut ?? positionals[2]
  const dryRun = values['dry-run'] ?? false

  const explicitProfile = validateOutputProfile(
    values.profile ??
      values.encoder ??
      readEnvValue(envVars.profile) ??
      readEnvValue(envVars.encoder),
  )
  const recursiveFromEnv = parseEnvBoolean(readEnvValue(envVars.recursive))
  const overwriteFromEnv = parseEnvBoolean(readEnvValue(envVars.overwrite))

  const shouldUseInteractive =
    Boolean(values.interactive) ||
    (Boolean(input.isTTY && output.isTTY) && (!inputDirArg || !outputDirArg || !lutFileArg))

  const defaults: Partial<Settings> = {
    dryRun,
    inputDir: inputDirArg ? normalizeUserPath(inputDirArg) : undefined,
    interp: values.interp ?? readEnvValue(envVars.interp) ?? defaultInterp,
    lutFile: lutFileArg ? normalizeUserPath(lutFileArg) : defaultLut,
    outputDir: outputDirArg ? normalizeUserPath(outputDirArg) : undefined,
    overwrite: values.overwrite ? true : overwriteFromEnv ? true : undefined,
    profile: explicitProfile,
    recursive: values.recursive ? true : recursiveFromEnv ? true : undefined,
  }

  const settings: Settings = shouldUseInteractive
    ? await buildInteractiveSettings(defaults)
    : {
        dryRun,
        inputDir: inputDirArg ? normalizeUserPath(inputDirArg) : '',
        interp: values.interp ?? readEnvValue(envVars.interp) ?? defaultInterp,
        lutFile: lutFileArg ? normalizeUserPath(lutFileArg) : defaultLut,
        outputDir: outputDirArg
          ? normalizeUserPath(outputDirArg)
          : inputDirArg
            ? path.join(normalizeUserPath(inputDirArg), 'graded')
            : '',
        overwrite: values.overwrite ? true : overwriteFromEnv,
        profile: explicitProfile ?? detectDefaultProfile(),
        recursive: values.recursive ? true : recursiveFromEnv,
      }

  if (!settings.inputDir) {
    throw new Error('Input folder is required.')
  }

  if (!(await isDirectory(settings.inputDir))) {
    throw new Error(`Input folder not found: ${settings.inputDir}`)
  }

  if (!settings.outputDir) {
    settings.outputDir = path.join(settings.inputDir, 'graded')
  }

  settings.outputDir = path.resolve(settings.outputDir)

  if (settings.inputDir === settings.outputDir) {
    throw new Error('Output folder must be different from the input folder.')
  }

  const outputExists = await pathExists(settings.outputDir)
  if (outputExists && !(await isDirectory(settings.outputDir))) {
    throw new Error(`A file already exists at the output path: ${settings.outputDir}`)
  }

  if (!(await isDirectory(path.dirname(settings.outputDir)))) {
    throw new Error(`Output parent folder not found: ${path.dirname(settings.outputDir)}`)
  }

  if (!(await isFile(settings.lutFile))) {
    throw new Error(`LUT file not found: ${settings.lutFile}`)
  }

  const videoFiles = await collectVideoFiles(settings)
  if (videoFiles.length === 0) {
    console.log(`No video files found in ${settings.inputDir}`)
    return
  }

  if (!settings.dryRun) {
    await mkdir(settings.outputDir, { recursive: true })
  }

  const filterExpression = `lut3d=file='${escapeFilterPath(settings.lutFile)}':interp=${settings.interp}`

  console.log('')
  console.log('Batch LUT grading')
  console.log(`Input:     ${settings.inputDir}`)
  console.log(`Output:    ${settings.outputDir}`)
  console.log(`LUT:       ${path.basename(settings.lutFile)}`)
  console.log(`Files:     ${videoFiles.length}`)
  console.log(`Profile:   ${profileLabel(settings.profile)}`)
  console.log(`Recursive: ${settings.recursive ? 'yes' : 'no'}`)
  console.log(`Overwrite: ${settings.overwrite ? 'yes' : 'no'}`)
  console.log(`Dry run:   ${settings.dryRun ? 'yes' : 'no'}`)
  console.log('')

  let graded = 0
  let skipped = 0
  let failed = 0
  let planned = 0

  for (const [index, sourceFile] of videoFiles.entries()) {
    const sourceProbe = probeSourceFile(sourceFile)
    const outputFile = outputPathFor(sourceFile, settings)
    const label = `[${index + 1}/${videoFiles.length}]`

    if ((await pathExists(outputFile)) && !settings.overwrite) {
      console.log(`${label} Skip:  ${path.basename(sourceFile)} (output already exists)`)
      skipped += 1
      continue
    }

    const encodeArgs = buildEncodeArgs(settings.profile, sourceProbe)
    const muxArgs = buildMuxArgs(settings.profile)
    const ffmpegArgs = [
      'ffmpeg',
      '-hide_banner',
      '-loglevel',
      'warning',
      settings.overwrite ? '-y' : '-n',
      '-i',
      sourceFile,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-map',
      '0:s?',
      '-map_metadata',
      '0',
      '-vf:v:0',
      filterExpression,
      ...encodeArgs,
      '-c:a',
      'copy',
      '-c:s',
      'copy',
    ]

    if (sourceProbe.colorSpace) {
      ffmpegArgs.push('-colorspace:v:0', sourceProbe.colorSpace)
    }

    if (sourceProbe.colorPrimaries) {
      ffmpegArgs.push('-color_primaries:v:0', sourceProbe.colorPrimaries)
    }

    if (sourceProbe.colorTransfer) {
      ffmpegArgs.push('-color_trc:v:0', sourceProbe.colorTransfer)
    }

    ffmpegArgs.push(...muxArgs, outputFile)

    if (settings.dryRun) {
      console.log(
        `${label} Dry run: target ${(sourceProbe.overallBitrate / 1_000_000).toFixed(2)} Mbps -> ${ffmpegArgs.join(' ')}`,
      )
      planned += 1
      continue
    }

    await mkdir(path.dirname(outputFile), { recursive: true })

    console.log(
      `${label} Grade: ${path.basename(sourceFile)} (${(sourceProbe.overallBitrate / 1_000_000).toFixed(2)} Mbps target)`,
    )

    const processHandle = Bun.spawn({
      cmd: ffmpegArgs,
      stderr: 'inherit',
      stdout: 'inherit',
    })

    const exitCode = await processHandle.exited

    if (exitCode === 0) {
      console.log(`${label} Done:  ${path.basename(outputFile)}`)
      graded += 1
    } else {
      console.log(`${label} Fail:  ${path.basename(sourceFile)}`)
      failed += 1
    }
  }

  console.log('')
  if (settings.dryRun) {
    console.log(
      `Dry run finished: ${planned} planned, ${skipped} skipped, ${videoFiles.length} total`,
    )
    return
  }

  console.log(
    `Finished: ${graded} graded, ${skipped} skipped, ${failed} failed, ${videoFiles.length} total`,
  )
}

run().catch((error: unknown) => {
  if (error instanceof Error) {
    if (error.message === 'Cancelled before grading started.') {
      console.log('Nothing was changed.')
      process.exit(0)
    }

    console.error(`Error: ${error.message}`)
  } else {
    console.error('Error: Unknown failure')
  }

  process.exit(1)
})
