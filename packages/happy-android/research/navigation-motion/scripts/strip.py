"""Frame strip: crop, times relative to t0, labelled.
usage: strip.py video.mp4 t0 out.jpg x y w h t1 t2 ..."""
import subprocess, sys, os, tempfile
video, t0, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
x, y, w, h = map(int, sys.argv[4:8])
times = [float(t) for t in sys.argv[8:]]
tmp = os.path.abspath('_strip')
os.makedirs(tmp, exist_ok=True)
tiles = []
for i, t in enumerate(times):
    f = os.path.join(tmp, '%02d.png' % i)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '%.4f' % (t0 + t / 1000), '-i', video, '-frames:v', '1',
                    '-vf', 'crop=%d:%d:%d:%d,scale=%d:-1%s' % (w, h, x, y, w // 4, ',scale=iw/14:-1,scale=iw*14:-1:flags=neighbor' if os.environ.get('PIXELATE') else ''), f], check=True)
    g = os.path.join(tmp, 'l%02d.png' % i)
    subprocess.run(['magick', f, '-gravity', 'south', '-background', '#222', '-fill', 'white', '-font', '/System/Library/Fonts/Helvetica.ttc', '-pointsize', '22',
                    '-splice', '0x30', '-annotate', '+0+2', '%d ms' % t, g], check=True)
    tiles.append(g)
subprocess.run(['magick'] + tiles + ['-bordercolor', '#555', '-border', '2', '+append', '-quality', '80', out], check=True)
