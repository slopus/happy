"""App-only store preview, separate from the framed marketing video.

Usage: python3 app-preview.py iphone|ipad NATIVE.mp4 OUTPUT.mp4
"""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('device', choices=['iphone', 'ipad'])
parser.add_argument('native', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--seconds', type=float, default=17.5)
parser.add_argument('--trim', type=float, default=0)
args = parser.parse_args()
size = '886:1920' if args.device == 'iphone' else '1600:1200'
args.output.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-ss', str(args.trim), '-i', str(args.native), '-f', 'lavfi',
                '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-map', '0:v:0', '-map', '1:a:0',
                '-vf', f'colorspace=all=bt709:format=yuv444p:range=tv,fps=30,scale={size}:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p',
                '-t', str(args.seconds), '-c:v', 'libx264', '-threads', '2', '-profile:v', 'high', '-level:v', '4.0',
                '-b:v', '11M', '-minrate', '11M', '-maxrate', '11M', '-bufsize', '22M',
                '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-c:a', 'aac', '-b:a', '256k',
                '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
                '-movflags', '+faststart', str(args.output)], check=True)