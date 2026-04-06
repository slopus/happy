export interface VideoDirectorConfig {
  outputRoot: string
  seedance: {
    apiKey: string | null
    baseUrl: string
    model: string
    tasksPath: string
  }
  promptModel: {
    apiKey: string | null
    baseUrl: string
    model: string
  }
  tools: {
    ffmpegPath: string
    ffprobePath: string
    sayPath: string
  }
}

const defaults = {
  seedance: {
    baseUrl: 'https://operator.las.cn-beijing.volces.com',
    tasksPath: '/api/v1/contents/generations/tasks',
    model: 'doubao-seedance-1-5-pro-251215',
  },
  promptModel: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-1-6-flash-250715',
  },
  tools: {
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    sayPath: 'say',
  },
} as const

function readEnvValue(value: string | undefined): string | null {
  if (!value) {
    return null
  }

  const trimmedValue = value.trim()
  return trimmedValue.length > 0 ? trimmedValue : null
}

export function loadConfig(input: { env: NodeJS.ProcessEnv; cwd: string }): VideoDirectorConfig {
  return {
    outputRoot: `${input.cwd}/projects/video-runs`,
    seedance: {
      apiKey: readEnvValue(input.env.SEEDANCE_API_KEY),
      baseUrl: defaults.seedance.baseUrl,
      tasksPath: defaults.seedance.tasksPath,
      model: defaults.seedance.model,
    },
    promptModel: {
      apiKey: readEnvValue(input.env.PROMPT_MODEL_API_KEY),
      baseUrl: defaults.promptModel.baseUrl,
      model: defaults.promptModel.model,
    },
    tools: {
      ffmpegPath: defaults.tools.ffmpegPath,
      ffprobePath: defaults.tools.ffprobePath,
      sayPath: defaults.tools.sayPath,
    },
  }
}
