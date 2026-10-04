import {
    createNativePairingResponse,
    decodeNativeMessage,
    encodeNativeMessage,
    nativeHostFailureResponse,
} from './browserNativeMessaging'

const NATIVE_MESSAGE_HEADER_BYTES = 4
const MAX_NATIVE_EXTENSION_MESSAGE_BYTES = 64 * 1024 * 1024

export async function runBrowserNativeMessagingHost({
    input,
    write,
    writeError,
    readToken,
    port,
    host,
    consumeSetup,
}: {
    input: AsyncIterable<Uint8Array>
    write: (chunk: Buffer) => void
    writeError: (message: string) => void
    readToken: () => Promise<string>
    port: number
    host: string
    consumeSetup?: (operationId: string) => Promise<unknown>
}): Promise<void> {
    try {
        const request = decodeNativeMessage(await readNativeMessageFrame(input))
        if (request && typeof request === 'object' && 'type' in request && request.type === 'setup-pair') {
            if (!('operationId' in request) || typeof request.operationId !== 'string'
                || !/^[A-Za-z0-9_-]{32}$/.test(request.operationId) || !consumeSetup) throw new Error('SETUP_UNAVAILABLE')
            write(encodeNativeMessage(await consumeSetup(request.operationId)))
            return
        }
        const token = await readToken()
        const response = createNativePairingResponse({ request, token, port, host })
        write(encodeNativeMessage(response))
    } catch (error) {
        writeError('Happy Browser Native Messaging host failed.\n')
        write(encodeNativeMessage(nativeHostFailureResponse(error)))
    }
}

async function readNativeMessageFrame(input: AsyncIterable<Uint8Array>): Promise<Buffer> {
    const iterator = input[Symbol.asyncIterator]()
    let buffered = Buffer.alloc(0)
    let frameLength: number | null = null

    try {
        while (frameLength === null || buffered.byteLength < frameLength) {
            const next = await iterator.next()
            if (next.done) throw new Error('Native message ended before its declared length')
            buffered = Buffer.concat([buffered, Buffer.from(next.value)])

            if (frameLength === null && buffered.byteLength >= NATIVE_MESSAGE_HEADER_BYTES) {
                const payloadLength = buffered.readUInt32LE(0)
                if (payloadLength > MAX_NATIVE_EXTENSION_MESSAGE_BYTES) {
                    throw new Error('Native message exceeds the 64 MiB extension request limit')
                }
                frameLength = NATIVE_MESSAGE_HEADER_BYTES + payloadLength
            }
        }
        return buffered.subarray(0, frameLength)
    } finally {
        await iterator.return?.()
    }
}
