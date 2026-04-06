import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('uses deterministic defaults', () => {
    const config = loadConfig({
      cwd: '/workspace/hoppy/app',
      env: {},
    })

    expect(config.outputRoot).toBe('/workspace/hoppy/app/projects/video-runs')
    expect(config.seedance.tasksPath).toBe('/api/v1/contents/generations/tasks')
    expect(config.promptModel.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3')
    expect(config.tools.ffmpegPath).toBe('ffmpeg')
  })
})
