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

  it('honors environment overrides', () => {
    const config = loadConfig({
      cwd: '/workspace/hoppy/app',
      env: {
        SEEDANCE_API_KEY: 'seedance-api-key',
        SEEDANCE_BASE_URL: 'https://seedance.example.test',
        SEEDANCE_TASKS_PATH: '/custom/tasks',
        SEEDANCE_MODEL: 'custom-seedance-model',
        PROMPT_MODEL_API_KEY: 'prompt-api-key',
        PROMPT_MODEL_BASE_URL: 'https://prompt.example.test',
        PROMPT_MODEL_ID: 'custom-prompt-model',
        FFMPEG_PATH: '/opt/bin/ffmpeg',
        FFPROBE_PATH: '/opt/bin/ffprobe',
        SAY_PATH: '/opt/bin/say',
      },
    })

    expect(config.seedance.apiKey).toBe('seedance-api-key')
    expect(config.seedance.baseUrl).toBe('https://seedance.example.test')
    expect(config.seedance.tasksPath).toBe('/custom/tasks')
    expect(config.seedance.model).toBe('custom-seedance-model')
    expect(config.promptModel.apiKey).toBe('prompt-api-key')
    expect(config.promptModel.baseUrl).toBe('https://prompt.example.test')
    expect(config.promptModel.model).toBe('custom-prompt-model')
    expect(config.tools.ffmpegPath).toBe('/opt/bin/ffmpeg')
    expect(config.tools.ffprobePath).toBe('/opt/bin/ffprobe')
    expect(config.tools.sayPath).toBe('/opt/bin/say')
  })
})
