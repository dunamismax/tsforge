import { writeFile } from 'node:fs/promises'

export const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
export const SECTOR_SIZE = 512
export const MINI_SECTOR_SIZE = 64
export const MINI_STREAM_CUTOFF = 4096

export const FREESECT = 0xffffffff
export const ENDOFCHAIN = 0xfffffffe
export const FATSECT = 0xfffffffd
export const DIFSECT = 0xfffffffc
export const NOSTREAM = 0xffffffff

export const FAT_ENTRIES_PER_SECTOR = SECTOR_SIZE / 4
export const HEADER_DIFAT_ENTRIES = 109
export const DIFAT_ENTRIES_PER_SECTOR = FAT_ENTRIES_PER_SECTOR - 1

export const DIR_TYPE_STORAGE = 1
export const DIR_TYPE_STREAM = 2
export const DIR_TYPE_ROOT = 5

const COLOR_BLACK = 1
const CLSID_SUFFIX = Buffer.from([0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46])

export const CLSID_NULL = Buffer.alloc(16)
export const CLSID_OFT = Buffer.concat([
  Buffer.from([0x46, 0xf0, 0x06, 0x00]),
  Buffer.from([0x00, 0x00]),
  Buffer.from([0x00, 0x00]),
  CLSID_SUFFIX,
])

type BufferLike = ArrayBuffer | Uint8Array | Buffer
type ByteBuffer = Buffer<ArrayBufferLike>

class DirEntry {
  childSid = NOSTREAM
  readonly children: number[] = []
  readonly clsid: ByteBuffer
  readonly data: ByteBuffer
  readonly entryType: number
  leftSid = NOSTREAM
  readonly name: string
  rightSid = NOSTREAM
  startSector = ENDOFCHAIN
  streamSize = 0

  constructor(
    name: string,
    entryType: number,
    clsid: ByteBuffer = CLSID_NULL,
    data: BufferLike = new Uint8Array(),
  ) {
    this.name = name
    this.entryType = entryType
    this.clsid = Buffer.from(clsid)
    this.data = toBuffer(data)
  }
}

class StreamSector {
  readonly data: ByteBuffer

  constructor(data: ByteBuffer) {
    this.data = data
  }
}

const epochDiffMilliseconds = 11644473600000n

export const unixMillisecondsToFiletime = (timestampMs: bigint | number) =>
  (BigInt(timestampMs) + epochDiffMilliseconds) * 10000n

const toBuffer = (value: BufferLike): ByteBuffer =>
  Buffer.isBuffer(value)
    ? value
    : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value)

const padBuffer = (data: BufferLike, boundary: number): ByteBuffer => {
  const raw = toBuffer(data)
  const remainder = raw.length % boundary
  return remainder === 0 ? raw : Buffer.concat([raw, Buffer.alloc(boundary - remainder)])
}

const packUint32 = (value: number): ByteBuffer => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

export class CFBWriter {
  readonly #entries: DirEntry[] = []

  addRoot(clsid: Buffer = CLSID_NULL) {
    const index = this.#entries.length
    this.#entries.push(new DirEntry('Root Entry', DIR_TYPE_ROOT, clsid))
    return index
  }

  addStorage(parent: number, name: string, clsid: Buffer = CLSID_NULL) {
    const index = this.#entries.length
    this.#entries.push(new DirEntry(name, DIR_TYPE_STORAGE, clsid))
    this.#entries[parent]?.children.push(index)
    return index
  }

  addStream(parent: number, name: string, data: BufferLike) {
    const index = this.#entries.length
    this.#entries.push(new DirEntry(name, DIR_TYPE_STREAM, CLSID_NULL, data))
    this.#entries[parent]?.children.push(index)
    return index
  }

  toBuffer() {
    const sectors: Array<Buffer | StreamSector> = []
    const fat: number[] = []

    const allocChain = (data: BufferLike) => {
      const raw = toBuffer(data)
      if (raw.length === 0) {
        return ENDOFCHAIN
      }

      const start = sectors.length
      const sectorCount = Math.ceil(raw.length / SECTOR_SIZE)
      for (let index = 0; index < sectorCount; index += 1) {
        const chunk = raw.subarray(index * SECTOR_SIZE, (index + 1) * SECTOR_SIZE)
        sectors.push(new StreamSector(chunk))
        fat.push(index < sectorCount - 1 ? start + index + 1 : ENDOFCHAIN)
      }
      return start
    }

    const miniEntries: number[] = []
    const regularEntries: number[] = []

    this.#entries.forEach((entry, index) => {
      if (entry.entryType !== DIR_TYPE_STREAM || entry.data.length === 0) {
        return
      }
      if (entry.data.length < MINI_STREAM_CUTOFF) {
        miniEntries.push(index)
        return
      }
      regularEntries.push(index)
    })

    let miniStream: ByteBuffer = Buffer.alloc(0)
    const miniFat: number[] = []

    for (const entryIndex of miniEntries) {
      const entry = this.#entries[entryIndex]
      if (!entry) {
        continue
      }
      const startMiniSector = miniStream.length / MINI_SECTOR_SIZE
      const padded = padBuffer(entry.data, MINI_SECTOR_SIZE)
      const miniSectorCount = padded.length / MINI_SECTOR_SIZE
      entry.startSector = startMiniSector
      entry.streamSize = entry.data.length

      for (let index = 0; index < miniSectorCount; index += 1) {
        miniFat.push(index < miniSectorCount - 1 ? startMiniSector + index + 1 : ENDOFCHAIN)
      }

      miniStream = Buffer.concat([miniStream, padded])
    }

    if (miniStream.length > 0) {
      miniStream = padBuffer(miniStream, SECTOR_SIZE)
    }

    const dirBytesNeeded = Math.ceil(Math.max(this.#entries.length, 1) / 4) * SECTOR_SIZE
    const dirStart = allocChain(Buffer.alloc(dirBytesNeeded))
    const dirSectorCount = dirBytesNeeded / SECTOR_SIZE

    let miniFatStart = ENDOFCHAIN
    let miniFatSectorCount = 0
    if (miniFat.length > 0) {
      const miniFatData = padBuffer(
        Buffer.concat(miniFat.map((value) => packUint32(value))),
        SECTOR_SIZE,
      )
      miniFatStart = allocChain(miniFatData)
      miniFatSectorCount = miniFatData.length / SECTOR_SIZE
    }

    const miniStreamStart = miniStream.length > 0 ? allocChain(miniStream) : ENDOFCHAIN

    for (const entryIndex of regularEntries) {
      const entry = this.#entries[entryIndex]
      if (!entry) {
        continue
      }
      entry.startSector = allocChain(entry.data)
      entry.streamSize = entry.data.length
    }

    const root = this.#entries[0]
    if (root) {
      root.startSector = miniStreamStart
      root.streamSize = miniStream.length
    }

    for (const entry of this.#entries) {
      if (entry.entryType === DIR_TYPE_STORAGE || entry.entryType === DIR_TYPE_ROOT) {
        if (entry !== root) {
          entry.startSector = 0
          entry.streamSize = 0
        }
      }
    }

    const [fatSectorCount, difatSectorCount] = this.#calculateFatLayout(sectors.length)
    const fatSids: number[] = []
    for (let index = 0; index < fatSectorCount; index += 1) {
      const sid = sectors.length
      sectors.push(Buffer.alloc(SECTOR_SIZE))
      fat.push(FATSECT)
      fatSids.push(sid)
    }

    const difatSids: number[] = []
    for (let index = 0; index < difatSectorCount; index += 1) {
      const sid = sectors.length
      sectors.push(Buffer.alloc(SECTOR_SIZE))
      fat.push(DIFSECT)
      difatSids.push(sid)
    }

    const totalSlots = fatSectorCount * FAT_ENTRIES_PER_SECTOR
    while (fat.length < totalSlots) {
      fat.push(FREESECT)
    }

    const fatRaw = Buffer.concat(fat.slice(0, totalSlots).map((value) => packUint32(value)))
    fatSids.forEach((sid, index) => {
      sectors[sid] = fatRaw.subarray(index * SECTOR_SIZE, (index + 1) * SECTOR_SIZE)
    })

    difatSids.forEach((sid, index) => {
      const difatSector = Buffer.alloc(SECTOR_SIZE)
      const start = HEADER_DIFAT_ENTRIES + index * DIFAT_ENTRIES_PER_SECTOR
      const entries = fatSids.slice(start, start + DIFAT_ENTRIES_PER_SECTOR)
      for (let slot = 0; slot < DIFAT_ENTRIES_PER_SECTOR; slot += 1) {
        difatSector.writeUInt32LE((entries[slot] ?? FREESECT) >>> 0, slot * 4)
      }
      const nextSid = difatSids[index + 1] ?? ENDOFCHAIN
      difatSector.writeUInt32LE(nextSid >>> 0, SECTOR_SIZE - 4)
      sectors[sid] = difatSector
    })

    this.#buildDirTrees()

    const directory = Buffer.alloc(dirBytesNeeded)
    this.#entries.forEach((entry, index) => {
      this.#serializeDirEntry(entry).copy(directory, index * 128)
    })
    for (let index = 0; index < dirSectorCount; index += 1) {
      sectors[dirStart + index] = directory.subarray(index * SECTOR_SIZE, (index + 1) * SECTOR_SIZE)
    }

    const header = this.#buildHeader({
      dirStart,
      difatSids,
      fatSectorCount,
      fatSids,
      miniFatSectorCount,
      miniFatStart,
    })

    const output: ByteBuffer[] = [header]
    for (const sector of sectors) {
      if (sector instanceof StreamSector) {
        output.push(sector.data)
        if (sector.data.length < SECTOR_SIZE) {
          output.push(Buffer.alloc(SECTOR_SIZE - sector.data.length))
        }
        continue
      }
      output.push(sector)
    }

    return Buffer.concat(output)
  }

  async save(path: string) {
    await writeFile(path, this.toBuffer())
  }

  #dirSortKey(name: string) {
    return [name.length, name.toUpperCase()] as const
  }

  #buildDirTrees() {
    for (const entry of this.#entries) {
      if (entry.entryType !== DIR_TYPE_ROOT && entry.entryType !== DIR_TYPE_STORAGE) {
        continue
      }

      if (entry.children.length === 0) {
        entry.childSid = NOSTREAM
        continue
      }

      const sortedChildren = [...entry.children].sort((left, right) => {
        const leftKey = this.#dirSortKey(this.#entries[left]?.name ?? '')
        const rightKey = this.#dirSortKey(this.#entries[right]?.name ?? '')
        if (leftKey[0] !== rightKey[0]) {
          return leftKey[0] - rightKey[0]
        }
        return leftKey[1].localeCompare(rightKey[1])
      })

      entry.childSid = this.#makeBst(sortedChildren, 0, sortedChildren.length - 1)
    }
  }

  #calculateFatLayout(nonFatSectorCount: number): [number, number] {
    let fatSectorCount = 0
    let difatSectorCount = 0

    while (true) {
      const totalSectors = nonFatSectorCount + fatSectorCount + difatSectorCount
      const nextFatSectorCount = Math.ceil(totalSectors / FAT_ENTRIES_PER_SECTOR)
      const overflow = Math.max(0, nextFatSectorCount - HEADER_DIFAT_ENTRIES)
      const nextDifatSectorCount = overflow > 0 ? Math.ceil(overflow / DIFAT_ENTRIES_PER_SECTOR) : 0

      if (nextFatSectorCount === fatSectorCount && nextDifatSectorCount === difatSectorCount) {
        return [nextFatSectorCount, nextDifatSectorCount]
      }

      fatSectorCount = nextFatSectorCount
      difatSectorCount = nextDifatSectorCount
    }
  }

  #makeBst(children: number[], low: number, high: number): number {
    if (low > high) {
      return NOSTREAM
    }

    const middle = Math.floor((low + high) / 2)
    const entryIndex = children[middle] ?? NOSTREAM
    const entry = this.#entries[entryIndex]
    if (!entry) {
      return NOSTREAM
    }
    entry.leftSid = this.#makeBst(children, low, middle - 1)
    entry.rightSid = this.#makeBst(children, middle + 1, high)
    return entryIndex
  }

  #serializeDirEntry(entry: DirEntry) {
    const nameUtf16 = Buffer.from(`${entry.name}\u0000`, 'utf16le')
    const nameBytes = Buffer.concat([
      nameUtf16.subarray(0, 64),
      Buffer.alloc(Math.max(0, 64 - nameUtf16.length)),
    ])
    const nameSize = Math.min(nameUtf16.length, 64)
    const buffer = Buffer.alloc(128)

    nameBytes.copy(buffer, 0)
    buffer.writeUInt16LE(nameSize, 0x40)
    buffer[0x42] = entry.entryType
    buffer[0x43] = COLOR_BLACK
    buffer.writeUInt32LE(entry.leftSid >>> 0, 0x44)
    buffer.writeUInt32LE(entry.rightSid >>> 0, 0x48)
    buffer.writeUInt32LE(entry.childSid >>> 0, 0x4c)
    entry.clsid.copy(buffer, 0x50)

    const filetime = unixMillisecondsToFiletime(Date.now())
    buffer.writeBigUInt64LE(filetime, 0x64)
    buffer.writeBigUInt64LE(filetime, 0x6c)
    buffer.writeUInt32LE(entry.startSector >>> 0, 0x74)
    buffer.writeUInt32LE(entry.streamSize >>> 0, 0x78)
    buffer.writeUInt32LE(0, 0x7c)

    return buffer
  }

  #buildHeader(input: {
    dirStart: number
    difatSids: number[]
    fatSectorCount: number
    fatSids: number[]
    miniFatSectorCount: number
    miniFatStart: number
  }) {
    const buffer = Buffer.alloc(SECTOR_SIZE)
    CFB_MAGIC.copy(buffer, 0)
    CLSID_NULL.copy(buffer, 8)
    buffer.writeUInt16LE(0x003e, 0x18)
    buffer.writeUInt16LE(0x0003, 0x1a)
    buffer.writeUInt16LE(0xfffe, 0x1c)
    buffer.writeUInt16LE(9, 0x1e)
    buffer.writeUInt16LE(6, 0x20)
    buffer.writeUInt32LE(0, 0x28)
    buffer.writeUInt32LE(input.fatSectorCount >>> 0, 0x2c)
    buffer.writeUInt32LE(input.dirStart >>> 0, 0x30)
    buffer.writeUInt32LE(0, 0x34)
    buffer.writeUInt32LE(MINI_STREAM_CUTOFF, 0x38)
    buffer.writeUInt32LE(input.miniFatStart >>> 0, 0x3c)
    buffer.writeUInt32LE(input.miniFatSectorCount >>> 0, 0x40)
    buffer.writeUInt32LE((input.difatSids[0] ?? ENDOFCHAIN) >>> 0, 0x44)
    buffer.writeUInt32LE(input.difatSids.length >>> 0, 0x48)

    for (let index = 0; index < HEADER_DIFAT_ENTRIES; index += 1) {
      buffer.writeUInt32LE((input.fatSids[index] ?? FREESECT) >>> 0, 0x4c + index * 4)
    }

    return buffer
  }
}
