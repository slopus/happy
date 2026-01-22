import { useCameraPermissions } from "expo-camera";
import { Platform } from "react-native";

export function useCheckScannerPermissions(): () => Promise<boolean> {
    const [cameraPermission, requestCameraPermission] = useCameraPermissions();

    return async () => {
        if (Platform.OS === 'android') {
            // adroid uses google code scanner which doesn't need permissions
            return true;
        }

        if (!cameraPermission) {
            // camera permissions are loading
            return false;
        }

        if (!cameraPermission.granted) {
            const reqRes = await requestCameraPermission();
            return reqRes.granted;
        }

        return true;
    }
}