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
  const seedanceBaseUrl = readEnvValue(input.env.SEEDANCE_BASE_URL) ?? defaults.seedance.baseUrl
  const seedanceTasksPath = readEnvValue(input.env.SEEDANCE_TASKS_PATH) ?? defaults.seedance.tasksPath
  const seedanceModel = readEnvValue(input.env.SEEDANCE_MODEL) ?? defaults.seedance.model
  const promptModelBaseUrl = readEnvValue(input.env.PROMPT_MODEL_BASE_URL) ?? defaults.promptModel.baseUrl
  const promptModelModel = readEnvValue(input.env.PROMPT_MODEL_ID) ?? defaults.promptModel.model
  const ffmpegPath = readEnvValue(input.env.FFMPEG_PATH) ?? defaults.tools.ffmpegPath
  const ffprobePath = readEnvValue(input.env.FFPROBE_PATH) ?? defaults.tools.ffprobePath
  const sayPath = readEnvValue(input.env.SAY_PATH) ?? defaults.tools.sayPath

  return {
    outputRoot: `${input.cwd}/projects/video-runs`,
    seedance: {
      apiKey: readEnvValue(input.env.SEEDANCE_API_KEY),
      baseUrl: seedanceBaseUrl,
      tasksPath: seedanceTasksPath,
      model: seedanceModel,
    },
    promptModel: {
      apiKey: readEnvValue(input.env.PROMPT_MODEL_API_KEY),
      baseUrl: promptModelBaseUrl,
      model: promptModelModel,
    },
    tools: {
      ffmpegPath,
      ffprobePath,
      sayPath,
    },
  }
}
