import {
  DIR_TYPE_ROOT,
  DIR_TYPE_STORAGE,
  ENDOFCHAIN,
  FREESECT,
  HEADER_DIFAT_ENTRIES,
  MINI_SECTOR_SIZE,
  MINI_STREAM_CUTOFF,
  NOSTREAM,
  PT_INT32,
  SECTOR_SIZE,
} from '../src/index'

type Header = {
  dirStart: number
  firstDifat: number
  miniFatStart: number
  nDifat: number
  nFat: number
  nMiniFat: number
}

type DirEntry = {
  childSid: number
  entryType: number
  leftSid: number
  name: string
  rightSid: number
  startSector: number
  streamSize: number
}

export class CFBReader {
  readonly children: Map<number, number[]>
  readonly difat: number[]
  readonly entries: DirEntry[]
  readonly fat: number[]
  readonly header: Header
  readonly miniFat: number[]
  readonly miniStream: Buffer
  readonly #data: Buffer

  constructor(data: Buffer) {
    this.#data = data
    this.header = this.#parseHeader()
    this.difat = this.#readDifat()
    this.fat = this.#readFat()
    this.entries = this.#readDirectoryEntries()
    this.children = this.#buildChildren()
    this.miniFat = this.#readMiniFat()
    const root = this.entries[0]
    this.miniStream =
      root === undefined
        ? Buffer.alloc(0)
        : this.#readRegularChain(root.startSector, root.streamSize)
  }

  #parseHeader(): Header {
    const header = this.#data.subarray(0, SECTOR_SIZE)
    return {
      dirStart: header.readUInt32LE(0x30),
      firstDifat: header.readUInt32LE(0x44),
      miniFatStart: header.readUInt32LE(0x3c),
      nDifat: header.readUInt32LE(0x48),
      nFat: header.readUInt32LE(0x2c),
      nMiniFat: header.readUInt32LE(0x40),
    }
  }

  #sectorBytes(sid: number) {
    const start = SECTOR_SIZE * (sid + 1)
    return this.#data.subarray(start, start + SECTOR_SIZE)
  }

  #readDifat() {
    const header = this.#data.subarray(0, SECTOR_SIZE)
    const difat: number[] = []
    for (let index = 0; index < HEADER_DIFAT_ENTRIES; index += 1) {
      const sid = header.readUInt32LE(0x4c + index * 4)
      if (sid !== FREESECT) {
        difat.push(sid)
      }
    }

    let nextSid = this.header.firstDifat
    for (let sectorIndex = 0; sectorIndex < this.header.nDifat; sectorIndex += 1) {
      const sector = this.#sectorBytes(nextSid)
      for (let index = 0; index < 127; index += 1) {
        const sid = sector.readUInt32LE(index * 4)
        if (sid !== FREESECT) {
          difat.push(sid)
        }
      }
      nextSid = sector.readUInt32LE(SECTOR_SIZE - 4)
    }

    return difat.slice(0, this.header.nFat)
  }

  #readFat() {
    const fat: number[] = []
    for (const sid of this.difat) {
      const sector = this.#sectorBytes(sid)
      for (let index = 0; index < 128; index += 1) {
        fat.push(sector.readUInt32LE(index * 4))
      }
    }
    return fat
  }

  #readRegularChain(startSid: number, streamSize?: number) {
    if (startSid === ENDOFCHAIN) {
      return Buffer.alloc(0)
    }

    const chunks: Buffer[] = []
    let sid = startSid
    const visited = new Set<number>()
    while (sid !== ENDOFCHAIN) {
      if (visited.has(sid)) {
        throw new Error(`Cycle detected in FAT chain at sector ${sid}`)
      }
      visited.add(sid)
      chunks.push(this.#sectorBytes(sid))
      sid = this.fat[sid] ?? ENDOFCHAIN
    }

    const output = Buffer.concat(chunks)
    return streamSize === undefined ? output : output.subarray(0, streamSize)
  }

  #readMiniFat() {
    if (this.header.miniFatStart === ENDOFCHAIN || this.header.nMiniFat === 0) {
      return []
    }

    const raw = this.#readRegularChain(this.header.miniFatStart, this.header.nMiniFat * SECTOR_SIZE)
    const values: number[] = []
    for (let index = 0; index < raw.length; index += 4) {
      values.push(raw.readUInt32LE(index))
    }
    return values
  }

  #readDirectoryEntries() {
    const directory = this.#readRegularChain(this.header.dirStart)
    const entries: DirEntry[] = []

    for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
      const chunk = directory.subarray(offset, offset + 128)
      const nameSize = chunk.readUInt16LE(0x40)
      const name = nameSize >= 2 ? chunk.subarray(0, nameSize - 2).toString('utf16le') : ''
      entries.push({
        childSid: chunk.readUInt32LE(0x4c),
        entryType: chunk[0x42] ?? 0,
        leftSid: chunk.readUInt32LE(0x44),
        name,
        rightSid: chunk.readUInt32LE(0x48),
        startSector: chunk.readUInt32LE(0x74),
        streamSize: chunk.readUInt32LE(0x78),
      })
    }

    return entries
  }

  #buildChildren() {
    const children = new Map<number, number[]>()

    const walkTree = (sid: number, acc: number[]) => {
      if (sid === NOSTREAM) {
        return
      }
      const entry = this.entries[sid]
      if (!entry) {
        return
      }
      walkTree(entry.leftSid, acc)
      acc.push(sid)
      walkTree(entry.rightSid, acc)
    }

    this.entries.forEach((entry, index) => {
      if (entry.entryType !== DIR_TYPE_ROOT && entry.entryType !== DIR_TYPE_STORAGE) {
        return
      }
      const acc: number[] = []
      walkTree(entry.childSid, acc)
      children.set(index, acc)
    })

    return children
  }

  #findEntry(path: readonly string[]) {
    let parentSid = 0
    let match: DirEntry | undefined

    for (const name of path) {
      match = undefined
      for (const childSid of this.children.get(parentSid) ?? []) {
        const child = this.entries[childSid]
        if (child?.name === name) {
          match = child
          parentSid = childSid
          break
        }
      }

      if (!match) {
        throw new Error(`Missing directory entry for ${path.join('/')}`)
      }
    }

    if (!match) {
      throw new Error(`Missing directory entry for ${path.join('/')}`)
    }

    return match
  }

  #readMiniChain(startSid: number, streamSize: number) {
    if (startSid === ENDOFCHAIN) {
      return Buffer.alloc(0)
    }

    const chunks: Buffer[] = []
    let sid = startSid
    const visited = new Set<number>()

    while (sid !== ENDOFCHAIN) {
      if (visited.has(sid)) {
        throw new Error(`Cycle detected in mini FAT chain at sector ${sid}`)
      }
      visited.add(sid)
      const start = sid * MINI_SECTOR_SIZE
      chunks.push(this.miniStream.subarray(start, start + MINI_SECTOR_SIZE))
      sid = this.miniFat[sid] ?? ENDOFCHAIN
    }

    return Buffer.concat(chunks).subarray(0, streamSize)
  }

  readStream(path: readonly string[]) {
    const entry = this.#findEntry(path)
    if (entry.streamSize < MINI_STREAM_CUTOFF) {
      return this.#readMiniChain(entry.startSector, entry.streamSize)
    }
    return this.#readRegularChain(entry.startSector, entry.streamSize)
  }
}

export const parseInt32Properties = (data: Buffer, options: { isTopLevel: boolean }) => {
  let offset = options.isTopLevel ? 32 : 8
  const properties: Record<number, number> = {}

  while (offset + 16 <= data.length) {
    const propType = data.readUInt16LE(offset)
    const propId = data.readUInt16LE(offset + 2)
    const value = data.readUInt32LE(offset + 8)
    if (propId === 0 && propType === 0) {
      offset += 16
      continue
    }
    if (propType === PT_INT32) {
      properties[propId] = value
    }
    offset += 16
  }

  return properties
}
