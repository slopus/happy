/**
 * StepFun Realtime API Type Definitions
 * Based on: https://platform.stepfun.com/docs/zh/guide/realtime
 */

// ===== Tool Definition =====

export interface StepFunTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, {
                type: string;
                description?: string;
                enum?: string[];
            }>;
            required?: string[];
        };
    };
}

// ===== Session Objects =====

export interface SessionObject {
    id: string;
    model: string;
    modalities: string[];
    instructions: string;
    voice: string;
    input_audio_format: string;
    output_audio_format: string;
    tools: StepFunTool[];
}

export interface ResponseObject {
    id: string;
    status: 'in_progress' | 'completed' | 'cancelled' | 'failed';
    output: any[];
}

// ===== Client → Server Events =====

export interface SessionUpdateEvent {
    type: 'session.update';
    session: {
        modalities?: ('text' | 'audio')[];
        instructions?: string;
        voice?: string;
        input_audio_format?: 'pcm16';
        output_audio_format?: 'pcm16';
        input_audio_transcription?: {
            model: string;
        };
        turn_detection?: {
            type: 'server_vad';
            prefix_padding_ms?: number;
            silence_duration_ms?: number;
            energy_awakeness_threshold?: number; // Range 0-5000, default 2500
        } | null;
        tools?: StepFunTool[];
        tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string };
        temperature?: number;
        max_response_output_tokens?: number | 'inf';
    };
}

export interface InputAudioBufferAppendEvent {
    type: 'input_audio_buffer.append';
    audio: string; // base64 encoded PCM16
}

export interface InputAudioBufferCommitEvent {
    type: 'input_audio_buffer.commit';
}

export interface InputAudioBufferClearEvent {
    type: 'input_audio_buffer.clear';
}

export interface ConversationItemCreateEvent {
    type: 'conversation.item.create';
    item: {
        type: 'message' | 'function_call_output';
        role?: 'user' | 'assistant';  // StepFun only supports user/assistant, not system
        content?: Array<{
            type: 'input_text' | 'input_audio' | 'text';
            text?: string;
            audio?: string;
        }>;
        call_id?: string;
        output?: string;
    };
}

export interface ResponseCreateEvent {
    type: 'response.create';
    response?: {
        modalities?: ('text' | 'audio')[];
        instructions?: string;
        voice?: string;
        tools?: StepFunTool[];
        tool_choice?: 'auto' | 'none' | 'required';
        temperature?: number;
        max_output_tokens?: number | 'inf';
    };
}

export interface ResponseCancelEvent {
    type: 'response.cancel';
}

// ===== Server → Client Events =====

export interface SessionCreatedEvent {
    type: 'session.created';
    session: SessionObject;
}

export interface SessionUpdatedEvent {
    type: 'session.updated';
    session: SessionObject;
}

export interface InputAudioBufferSpeechStartedEvent {
    type: 'input_audio_buffer.speech_started';
    audio_start_ms: number;
    item_id: string;
}

export interface InputAudioBufferSpeechStoppedEvent {
    type: 'input_audio_buffer.speech_stopped';
    audio_end_ms: number;
    item_id: string;
}

export interface InputAudioBufferCommittedEvent {
    type: 'input_audio_buffer.committed';
    item_id: string;
}

export interface ResponseCreatedEvent {
    type: 'response.created';
    response: ResponseObject;
}

export interface ResponseDoneEvent {
    type: 'response.done';
    response: ResponseObject;
}

export interface ResponseAudioDeltaEvent {
    type: 'response.audio.delta';
    response_id: string;
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string; // base64 encoded PCM16 audio
}

export interface ResponseAudioDoneEvent {
    type: 'response.audio.done';
    response_id: string;
    item_id: string;
    output_index: number;
    content_index: number;
}

export interface ResponseTextDeltaEvent {
    type: 'response.text.delta';
    response_id: string;
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
}

export interface ResponseTextDoneEvent {
    type: 'response.text.done';
    response_id: string;
    item_id: string;
    output_index: number;
    content_index: number;
    text: string;
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
    type: 'response.function_call_arguments.delta';
    response_id: string;
    item_id: string;
    output_index: number;
    call_id: string;
    delta: string;
}

export interface ResponseFunctionCallArgumentsDoneEvent {
    type: 'response.function_call_arguments.done';
    response_id: string;
    item_id: string;
    output_index: number;
    call_id: string;
    name: string;
    arguments: string;
}

export interface ErrorEvent {
    type: 'error';
    error: {
        type: string;
        code: string;
        message: string;
        param?: string;
    };
}

// ===== Transcription Events =====

export interface ConversationItemInputAudioTranscriptionCompletedEvent {
    type: 'conversation.item.input_audio_transcription.completed';
    item_id: string;
    content_index: number;
    transcript: string;
}

export interface ConversationItemInputAudioTranscriptionFailedEvent {
    type: 'conversation.item.input_audio_transcription.failed';
    item_id: string;
    content_index: number;
    error: {
        type: string;
        code: string;
        message: string;
    };
}

export interface ResponseAudioTranscriptDeltaEvent {
    type: 'response.audio_transcript.delta';
    response_id: string;
    item_id: string;
    output_index: number;
    content_index: number;
    delta: string;
}

export interface ResponseAudioTranscriptDoneEvent {
    type: 'response.audio_transcript.done';
    response_id: string;
    item_id: string;
    output_index: number;
    content_index: number;
    transcript: string;
}

// ===== Union Types =====

export type StepFunClientEvent =
    | SessionUpdateEvent
    | InputAudioBufferAppendEvent
    | InputAudioBufferCommitEvent
    | InputAudioBufferClearEvent
    | ConversationItemCreateEvent
    | ResponseCreateEvent
    | ResponseCancelEvent;

export type StepFunServerEvent =
    | SessionCreatedEvent
    | SessionUpdatedEvent
    | InputAudioBufferSpeechStartedEvent
    | InputAudioBufferSpeechStoppedEvent
    | InputAudioBufferCommittedEvent
    | ResponseCreatedEvent
    | ResponseDoneEvent
    | ResponseAudioDeltaEvent
    | ResponseAudioDoneEvent
    | ResponseTextDeltaEvent
    | ResponseTextDoneEvent
    | ResponseFunctionCallArgumentsDeltaEvent
    | ResponseFunctionCallArgumentsDoneEvent
    | ConversationItemInputAudioTranscriptionCompletedEvent
    | ConversationItemInputAudioTranscriptionFailedEvent
    | ResponseAudioTranscriptDeltaEvent
    | ResponseAudioTranscriptDoneEvent
    | ErrorEvent;
