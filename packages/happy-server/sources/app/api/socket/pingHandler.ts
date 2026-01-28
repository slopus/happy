import { log } from "@/utils/log";
import { Socket } from "socket.io";

export function pingHandler(socket: Socket) {
    socket.on('ping', async (callback: (response: any) => void) => {
        try {
            callback({});
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in ping: ${error}`);
        }
    });
}