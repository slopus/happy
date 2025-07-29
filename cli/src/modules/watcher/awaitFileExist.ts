import { access } from "fs/promises";
import { delay } from "@/utils/time";

export async function awaitFileExist(file: string, timeout: number = 10000) {
    while (true) {
        try {
            await access(file);
            return true;
        } catch (e) {
            await delay(1000);
        }
    }
    return false;
}