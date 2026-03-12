import { basename, extname } from 'node:path'
import { CFBWriter, CLSID_OFT, unixMillisecondsToFiletime } from './cfb'

export const PT_INT32 = 0x0003
const PT_BOOLEAN = 0x000b
const PT_STRING = 0x001f
const PT_BINARY = 0x0102
const PT_SYSTIME = 0x0040

const PROP_RW = 0x00000006

const MSGFLAG_UNSENT = 0x00000008
const MSGFLAG_HASATTACH = 0x00000010

export const DEFAULT_INTERNET_CODEPAGE = 65001

type ByteBuffer = Buffer<ArrayBufferLike>

type AttachmentInput = {
  contentId: string | null
  data: ByteBuffer
  disposition: 'attachment' | 'inline' | null
  filename: string
  mimeType: string
}

const utf16le = (text: string) => Buffer.from(text, 'utf16le')

const streamName = (propId: number, propType: number) =>
  `__substg1.0_${propId.toString(16).toUpperCase().padStart(4, '0')}${propType
    .toString(16)
    .toUpperCase()
    .padStart(4, '0')}`

const shortFilename = (name: string) => {
  const extension = extname(name).slice(0, 4)
  const stem = basename(name, extension).slice(0, 8)
  return `${stem}${extension}`
}

class PropertyStreamBuilder {
  readonly #fixed: Buffer[] = []
  readonly #streams = new Map<string, Buffer>()
  #attachmentCount = 0
  readonly #isTopLevel: boolean
  #recipientCount = 0

  constructor(isTopLevel = false) {
    this.#isTopLevel = isTopLevel
  }

  setCounts(recipients: number, attachments: number) {
    this.#recipientCount = recipients
    this.#attachmentCount = attachments
  }

  addInt32(propId: number, value: number) {
    const entry = Buffer.alloc(16)
    entry.writeUInt16LE(PT_INT32, 0)
    entry.writeUInt16LE(propId, 2)
    entry.writeUInt32LE(PROP_RW, 4)
    entry.writeUInt32LE(value >>> 0, 8)
    this.#fixed.push(entry)
  }

  addBool(propId: number, value: boolean) {
    const entry = Buffer.alloc(16)
    entry.writeUInt16LE(PT_BOOLEAN, 0)
    entry.writeUInt16LE(propId, 2)
    entry.writeUInt32LE(PROP_RW, 4)
    entry.writeUInt32LE(value ? 1 : 0, 8)
    this.#fixed.push(entry)
  }

  addTime(propId: number, filetime: bigint) {
    const entry = Buffer.alloc(16)
    entry.writeUInt16LE(PT_SYSTIME, 0)
    entry.writeUInt16LE(propId, 2)
    entry.writeUInt32LE(PROP_RW, 4)
    entry.writeBigUInt64LE(filetime, 8)
    this.#fixed.push(entry)
  }

  addString(propId: number, value: string) {
    const data = utf16le(value)
    this.#streams.set(streamName(propId, PT_STRING), data)

    const entry = Buffer.alloc(16)
    entry.writeUInt16LE(PT_STRING, 0)
    entry.writeUInt16LE(propId, 2)
    entry.writeUInt32LE(PROP_RW, 4)
    entry.writeUInt32LE(data.length, 8)
    this.#fixed.push(entry)
  }

  addBinary(propId: number, value: Buffer) {
    this.#streams.set(streamName(propId, PT_BINARY), Buffer.from(value))

    const entry = Buffer.alloc(16)
    entry.writeUInt16LE(PT_BINARY, 0)
    entry.writeUInt16LE(propId, 2)
    entry.writeUInt32LE(PROP_RW, 4)
    entry.writeUInt32LE(value.length, 8)
    this.#fixed.push(entry)
  }

  buildPropsStream() {
    if (this.#isTopLevel) {
      const header = Buffer.alloc(32)
      header.writeBigUInt64LE(0n, 0)
      header.writeUInt32LE(this.#recipientCount >>> 0, 8)
      header.writeUInt32LE(this.#attachmentCount >>> 0, 12)
      header.writeUInt32LE(this.#recipientCount >>> 0, 16)
      header.writeUInt32LE(this.#attachmentCount >>> 0, 20)
      return Buffer.concat([header, ...this.#fixed])
    }

    return Buffer.concat([Buffer.alloc(8), ...this.#fixed])
  }

  get valueStreams() {
    return new Map(this.#streams)
  }
}

export class OFTBuilder {
  attachments: AttachmentInput[] = []
  bodyHtml: ByteBuffer = Buffer.alloc(0)
  bodyText = ''
  internetCodepage = DEFAULT_INTERNET_CODEPAGE
  subject = ''

  toBuffer() {
    const cfb = new CFBWriter()
    const root = cfb.addRoot(CLSID_OFT)

    const nameId = cfb.addStorage(root, '__nameid_version1.0')
    cfb.addStream(nameId, '__substg1.0_00020102', Buffer.alloc(0))
    cfb.addStream(nameId, '__substg1.0_00030102', Buffer.alloc(0))
    cfb.addStream(nameId, '__substg1.0_00040102', Buffer.alloc(0))

    const topLevelProps = new PropertyStreamBuilder(true)
    topLevelProps.setCounts(0, this.attachments.length)

    const now = unixMillisecondsToFiletime(Date.now())
    const messageFlags = MSGFLAG_UNSENT | (this.attachments.length > 0 ? MSGFLAG_HASATTACH : 0)

    topLevelProps.addString(0x001a, 'IPM.Note')
    topLevelProps.addString(0x0037, this.subject)
    topLevelProps.addString(0x003d, '')
    topLevelProps.addString(0x0070, this.subject)
    topLevelProps.addString(0x0e1d, this.subject)
    topLevelProps.addInt32(0x0e07, messageFlags)
    topLevelProps.addInt32(0x340d, 0x00040e79)
    topLevelProps.addInt32(0x3fde, this.internetCodepage)
    topLevelProps.addInt32(0x3ff1, 0x0409)
    topLevelProps.addTime(0x3007, now)
    topLevelProps.addTime(0x3008, now)

    if (this.bodyText.length > 0) {
      topLevelProps.addString(0x1000, this.bodyText)
    }

    if (this.bodyHtml.length > 0) {
      topLevelProps.addBinary(0x1013, this.bodyHtml)
    }

    cfb.addStream(root, '__properties_version1.0', topLevelProps.buildPropsStream())
    for (const [name, value] of topLevelProps.valueStreams) {
      cfb.addStream(root, name, value)
    }

    this.attachments.forEach((attachment, index) => {
      const attachmentStorage = cfb.addStorage(
        root,
        `__attach_version1.0_#${index.toString(16).toUpperCase().padStart(8, '0')}`,
      )

      const props = new PropertyStreamBuilder(false)
      props.addInt32(0x3705, 0x00000001)
      props.addInt32(0x370b, 0xffffffff)
      props.addInt32(0x0e20, attachment.data.length)
      props.addInt32(0x0ffe, 0x00000007)
      props.addString(0x3707, attachment.filename)
      props.addString(0x3704, shortFilename(attachment.filename))
      props.addString(0x3001, attachment.filename)
      props.addString(0x370e, attachment.mimeType)

      const extension = extname(attachment.filename)
      if (extension.length > 0) {
        props.addString(0x3703, extension)
      }

      if (attachment.contentId) {
        props.addString(0x3712, attachment.contentId)
      }

      props.addBinary(0x3701, attachment.data)
      props.addBinary(0x3702, Buffer.alloc(0))

      cfb.addStream(attachmentStorage, '__properties_version1.0', props.buildPropsStream())
      for (const [name, value] of props.valueStreams) {
        cfb.addStream(attachmentStorage, name, value)
      }
    })

    return cfb.toBuffer()
  }
}
