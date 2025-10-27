# Task 001: 架构纠正 - 使用 ElevenLabs ASR

## 🔴 问题：不应该使用 OpenAI Whisper

### 当前实现的问题
1. **引入额外依赖**：需要 OpenAI API Key
2. **供应商分散**：ElevenLabs（实时对话）+ OpenAI（ASR）
3. **重复功能**：ElevenLabs 本身就有 ASR 能力
4. **配置复杂**：需要管理两套 API Key

### ElevenLabs 已有的能力

**Conversational AI SDK 内置 ASR**：
- 已集成在项目中（`@elevenlabs/react-native`）
- 支持 99+ 语言
- 自动语言检测
- 说话人识别
- 定价：$0.40/小时

**可用的方案**：
1. **方案 A（推荐）**：使用 ElevenLabs Scribe API（独立 STT）
2. **方案 B**：复用现有 Conversational AI 的 ASR 能力

## ✅ 正确方案：使用 ElevenLabs ASR

### 修改 `sources/services/asr.ts`

```typescript
import * as FileSystem from 'expo-file-system';

export interface ASRResult {
    text: string;
    confidence?: number;
}

export interface ASRConfig {
    apiKey?: string;
    language?: string;
}

/**
 * ASR Service using ElevenLabs Scribe API
 *
 * 使用 ElevenLabs 的独立 STT 服务，与项目已有的 ElevenLabs 集成保持一致
 */
export async function transcribeAudio(
    audioUri: string,
    config: ASRConfig = {}
): Promise<ASRResult> {
    try {
        // Read audio file
        const audioInfo = await FileSystem.getInfoAsync(audioUri);
        if (!audioInfo.exists) {
            throw new Error('Audio file does not exist');
        }

        // 使用 ElevenLabs API Key（与实时对话共用）
        const apiKey = config.apiKey || process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY;
        if (!apiKey) {
            throw new Error('ElevenLabs API key not configured');
        }

        // Create form data
        const formData = new FormData();

        // Read file as blob
        const response = await fetch(audioUri);
        const blob = await response.blob();

        formData.append('audio', blob, 'recording.m4a');

        if (config.language) {
            formData.append('language', config.language);
        }

        // Call ElevenLabs Scribe API
        const apiResponse = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
            },
            body: formData,
        });

        if (!apiResponse.ok) {
            const errorData = await apiResponse.json().catch(() => ({}));
            throw new Error(
                `ElevenLabs ASR error: ${apiResponse.status} - ${errorData.detail || 'Unknown error'}`
            );
        }

        const data = await apiResponse.json();

        return {
            text: data.text || '',
            confidence: data.confidence
        };
    } catch (error) {
        console.error('ASR transcription failed:', error);
        throw error;
    }
}

// cleanupAudioFile 保持不变
```

### 修改环境变量配置

**之前（错误）**：
```bash
EXPO_PUBLIC_OPENAI_API_KEY=sk-xxx  # ❌ 不需要
```

**之后（正确）**：
```bash
EXPO_PUBLIC_ELEVENLABS_API_KEY=xxx  # ✅ 与现有配置统一
```

### 修改测试文件

`sources/services/asr.test.ts` 需要更新：
- 替换 Whisper API 相关的 mock
- 使用 ElevenLabs API 端点
- 更新错误消息断言

## 📊 对比分析

### 成本对比
| 服务 | 定价 | 计算 |
|------|------|------|
| OpenAI Whisper | $0.006/分钟 | $0.36/小时 |
| ElevenLabs Scribe | $0.40/小时 | $0.40/小时 |

**结论**：价格几乎相同（ElevenLabs 略贵 11%）

### 架构对比
```
❌ 当前方案（分散）:
[App] → ElevenLabs (实时对话)
      → OpenAI Whisper (ASR)
      → 两套 API Key 管理

✅ 正确方案（统一）:
[App] → ElevenLabs (实时对话 + ASR)
      → 单一 API Key 管理
```

## 🔧 需要修改的文件

1. **`sources/services/asr.ts`** - 替换 Whisper API 为 ElevenLabs Scribe
2. **`sources/services/asr.test.ts`** - 更新单元测试
3. **`tasks/001-SUMMARY.md`** - 更新文档说明
4. **环境变量配置** - 删除 `EXPO_PUBLIC_OPENAI_API_KEY`

## ⚖️ 决策建议

### 推荐：使用 ElevenLabs ASR

**理由**：
1. ✅ **架构统一**：单一供应商，降低复杂度
2. ✅ **已有集成**：SDK 已在项目中
3. ✅ **成本相近**：价格差异可忽略
4. ✅ **功能更强**：说话人识别、自动语言切换
5. ✅ **维护简单**：一套 API Key

### 仅在以下情况使用 Whisper：
- ❌ 需要严格控制成本（差异仅 11%）
- ❌ 需要本地部署（Whisper.cpp）
- ❌ 已有 OpenAI 企业协议

## 📝 行动计划

### 立即修改（推荐）
1. 替换 `asr.ts` 中的 API 端点
2. 更新测试文件
3. 更新文档
4. 删除 OpenAI API Key 配置

### 或保持现状（不推荐）
理由：
- 如果已经配置好 OpenAI API Key
- 如果不想再次修改代码
- 如果未来考虑本地 Whisper

## 🎯 最终建议

**强烈建议切换到 ElevenLabs ASR**，理由：
1. 架构更清晰
2. 维护更简单
3. 功能更强大
4. 与现有集成一致

你觉得呢？我可以立即帮你重构为 ElevenLabs ASR 方案。
