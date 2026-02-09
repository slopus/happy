import { loadAppConfig } from "./sync/appConfig";
import { initVoiceConfig } from "./sync/voiceConfig";

export const config = loadAppConfig();
initVoiceConfig(config);