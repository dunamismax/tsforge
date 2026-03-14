import { describe, expect, it } from 'vitest'
import { buildCompressionPlan, chooseAudioBitrate, resolveUserPathCandidates } from '../src/index'

describe('signal-fit helpers', () => {
  it('normalizes drag-and-drop paths with shell escaping', () => {
    expect(resolveUserPathCandidates('/Users/sawyer/Videos/My\\ Clip.mov')).toContain(
      '/Users/sawyer/Videos/My Clip.mov',
    )
    expect(resolveUserPathCandidates('"/Users/sawyer/Videos/My Clip.mov"')).toContain(
      '/Users/sawyer/Videos/My Clip.mov',
    )
  })

  it('caps audio bitrate when the total budget is tight', () => {
    expect(chooseAudioBitrate(512_000, 2, 300_000)).toBe(56_000)
    expect(chooseAudioBitrate(0, 1, 200_000)).toBe(48_000)
  })

  it('builds a plan that stays below the signal limit with headroom', () => {
    const plan = buildCompressionPlan(
      {
        durationSeconds: 120,
        sizeBytes: 450_000_000,
        audio: {
          bitRate: 256_000,
          channels: 2,
        },
        video: {
          bitRate: 20_000_000,
          height: 2160,
          width: 3840,
        },
      },
      {
        headroomBytes: 1_000_000,
        limitBytes: 100_000_000,
        support: {
          aac: true,
          aacAt: true,
          libx264: true,
          libx265: true,
        },
      },
    )

    expect(plan.targetSizeBytes).toBe(99_000_000)
    expect(plan.targetTotalBitrate).toBe(6_600_000)
    expect(plan.targetAudioBitrate).toBe(128_000)
    expect(plan.targetVideoBitrate).toBe(6_472_000)
    expect(plan.audioCodec).toBe('aac_at')
    expect(plan.videoCodec).toBe('libx265')
  })
})
