"""Combine independently generated shader, device layers and native motion.

Usage: python3 compose-video.py LAYERS BACKGROUND.mp4 NATIVE.mp4 OUTPUT.mp4 [--seconds 17.5] [--trim N]
FFmpeg honors the native recording's rotation metadata before scaling.
"""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('layers', type=Path)
parser.add_argument('background', type=Path)
parser.add_argument('native', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--seconds', type=float, default=17.5)
parser.add_argument('--trim', type=float)
args = parser.parse_args()
config = json.loads((args.layers / 'geometry.json').read_text())
background_stream = json.loads(subprocess.check_output([
    'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', str(args.background)
]))['streams'][0]
if [background_stream['width'], background_stream['height']] != config['backgroundSize']:
    parser.error(f'background must be {config["backgroundSize"]}; regenerate it with background.mjs for this device')
if any(background_stream.get(key) != 'bt709' for key in ('color_space', 'color_transfer', 'color_primaries')):
    parser.error('background must be tagged BT.709; regenerate it with background.mjs')
rw, rh = config['renderSize']
ow, oh = config['outputSize']
screen = {key: round(value) for key, value in config['screen'].items()}
trim = config['trim'] if args.trim is None else args.trim
graph = (
    f'[0:v]scale={rw}:{rh}:flags=lanczos:in_color_matrix=bt709:out_color_matrix=bt709,'
    'noise=c0s=7:c0f=t+u:all_seed=42,'
    'scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=gbrp,setsar=1[bg];'
    '[1:v]colorspace=all=bt709:format=yuv444p:range=tv,fps=30,'
    f'scale={screen["width"]}:{screen["height"]}:flags=lanczos:in_color_matrix=bt709:in_range=tv:out_range=pc,'
    f'format=gbrp,pad={rw}:{rh}:{screen["x"]}:{screen["y"]}:color=black,setsar=1[native];'
    '[2:v]format=gray[mask];[native][mask]alphamerge[cut];'
    '[bg][cut]overlay=0:0:format=rgb[body];'
    f'[body][3:v]overlay=0:0:format=rgb,crop={ow}:{oh}:0:0,'
    'scale=in_range=pc:out_color_matrix=bt709:out_range=tv,format=yuv420p[out]'
)
command = ['ffmpeg', '-y', '-v', 'error', '-filter_complex_threads', '1',
           '-i', str(args.background), '-ss', str(trim), '-i', str(args.native),
           '-loop', '1', '-framerate', '30', '-i', str(args.layers / 'mask.png'),
           '-loop', '1', '-framerate', '30', '-i', str(args.layers / 'overlay.png'),
           '-filter_complex', graph, '-map', '[out]', '-an', '-t', str(args.seconds),
           '-r', '30', '-c:v', 'libx264', '-threads', '2', '-preset', 'medium', '-crf', '18',
           '-profile:v', 'high', '-level:v', config['level'], '-colorspace', 'bt709',
           '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', str(args.output)]
args.output.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(command, check=True)
args.output.with_suffix('.recipe.json').write_text(json.dumps({
    'command': command, 'config': config, 'backgroundStream': background_stream
}, indent=2) + '\n')