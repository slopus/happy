import subprocess, numpy as np

def frames(path, scale=2):
    pts = [float(x) for x in subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', path], capture_output=True, text=True).stdout.split()]
    W, H = 1968 // scale, 2184 // scale
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-fps_mode', 'passthrough', '-vf', f'scale={W}:{H},format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
    arr = np.frombuffer(raw, dtype=np.uint8).reshape(-1, H, W).astype(np.float32)
    return np.array(pts[:len(arr)]), arr
