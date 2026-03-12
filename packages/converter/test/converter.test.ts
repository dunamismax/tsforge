import { describe, expect, it } from 'vitest'
import {
  CFBWriter,
  CLSID_OFT,
  convertEmltplBuffer,
  ENDOFCHAIN,
  HEADER_DIFAT_ENTRIES,
} from '../src/index'
import { CFBReader, parseInt32Properties } from './cfb-reader'

describe('emltpl to oft conversion', () => {
  it('emits a DIFAT chain for large FAT tables', () => {
    const writer = new CFBWriter()
    const root = writer.addRoot(CLSID_OFT)
    writer.addStream(root, 'large.bin', Buffer.alloc(8 * 1024 * 1024, 0x78))

    const cfb = new CFBReader(writer.toBuffer())

    expect(cfb.header.nFat).toBeGreaterThan(HEADER_DIFAT_ENTRIES)
    expect(cfb.header.firstDifat).not.toBe(ENDOFCHAIN)
    expect(cfb.header.nDifat).toBeGreaterThan(0)
    expect(cfb.difat).toHaveLength(cfb.header.nFat)
  })

  it('preserves iso-8859-1 bodies and internet codepages', async () => {
    const message = Buffer.from(
      [
        'Subject: Charset check',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=iso-8859-1',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Ol=E1',
        '',
      ].join('\n'),
      'latin1',
    )

    const result = await convertEmltplBuffer(message, 'sample.emltpl')
    const cfb = new CFBReader(result.oft)
    const body = cfb.readStream(['__substg1.0_1000001F']).toString('utf16le')
    const props = parseInt32Properties(cfb.readStream(['__properties_version1.0']), {
      isTopLevel: true,
    })

    expect(body).toBe('Olá\n')
    expect(props[0x3fde]).toBe(28591)
  })

  it('round-trips attachment payloads', async () => {
    const message = Buffer.from(
      [
        'Subject: Attachment check',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary=BOUNDARY',
        '',
        '--BOUNDARY',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'hello',
        '--BOUNDARY',
        'Content-Type: application/octet-stream',
        'Content-Disposition: attachment; filename=test.bin',
        'Content-Transfer-Encoding: base64',
        '',
        'AAECAwQF',
        '--BOUNDARY--',
        '',
      ].join('\n'),
    )

    const result = await convertEmltplBuffer(message, 'sample.emltpl')
    const cfb = new CFBReader(result.oft)
    const attachment = cfb.readStream(['__attach_version1.0_#00000000', '__substg1.0_37010102'])

    expect(Buffer.from(attachment)).toEqual(Buffer.from([0, 1, 2, 3, 4, 5]))
  })
})
