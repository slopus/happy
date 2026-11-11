"""Copies the rendered tour assets into packages/store-assets/<platform>/<format>/ with a
manifest.json and SHA256SUMS per format.
Usage (from the repo root, after rsyncing ~/happy-store-v8/tour back): python3 scripts/mobile-captures/tour/build-store-assets.py TOURDIR
"""
import hashlib, json, shutil, sys
from pathlib import Path
T = Path(sys.argv[1]); out = Path('packages/store-assets')
BEATS = ['happy', 'computer-and-team-servers', 'build-together', 'use-all-your-subscriptions', 'call-your-agents', 'all-platforms']
VIDEO = {'duration_s': 29.3, 'fps': 30, 'frames': 879, 'poster_timecode': '00:00:00:00', 'source_take': 'iOS Simulator XCUITest tour, fictional fixtures'}
COMMON = 'Six-beat story: Happy, Your computer and team servers, Build together, Use all your subscriptions, Call your agents, All platforms. Fictional fixture data only.'

def stills(prefix, src_dir, size, first=1):
    return [(T / 'renderer' / src_dir / f'{prefix}-0{n}.png', f'0{n}-{BEATS[n - 1]}.png', size) for n in range(first, 7)]

FORMATS = {
  'ios/iphone-6.9': dict(display='APP_IPHONE_67 (6.9")', rule='video slot: preview video + screenshots 2-6 (screenshot 1 "Happy" unused; the video opens with it)',
      files=[(T / 'out/iphone-preview-tour-886x1920.mp4', '01-preview-video.mp4', '886x1920')] + stills('iphone', 'out', '1320x2868', 2),
      video=dict(VIDEO, audio='AAC stereo 48 kHz, pink-noise floor near -88 dBFS (inaudible), as on the accepted preview a9000019', codec='H.264 High@4.0, 11 Mb/s CBR, BT.709')),
  'ios/search-results': dict(display='Header and Search Results tab, 3:2 search video (spec a28b6440)', rule='single video asset; copy inside Apple art safe area',
      files=[(T / 'search-tour-v8-2880x1920.mp4', 'search-video-2880x1920.mp4', '2880x1920')],
      video=dict(VIDEO, audio='none', codec='H.264 High@5.1, ~20 Mb/s, BT.709')),
  'ios/ipad-13': dict(display='APP_IPAD_PRO_3GEN_129 (13")', rule='video slot: preview video + screenshots 2-6',
      files=[(T / 'out/ipad-preview-tour-1600x1200.mp4', '01-preview-video.mp4', '1600x1200')] + stills('ipad', 'out-formats/ipad', '2752x2064', 2),
      video=dict(VIDEO, audio='AAC stereo 48 kHz, pink-noise floor near -88 dBFS (inaudible)', codec='H.264 High@4.0, 11 Mb/s CBR, BT.709', source_take='iPad Simulator XCUITest tour (same cut, moved per beat), fictional fixtures')),
  'ios/iphone-duo-inner': dict(display='iPhone Duo, inner display (upload slot unconfirmed by Apple docs)', rule='no confirmed video slot: all six screenshots',
      files=stills('duo-inner', 'out-formats/duo-inner', '2853x2007')),
  'ios/iphone-duo-outer': dict(display='iPhone Duo, outer display (APP_IPHONE_DUO reported for outer)', rule='no confirmed video slot: all six screenshots',
      files=stills('duo-outer', 'out-formats/duo-outer', '1398x2034')),
  'android/phone': dict(display='Google Play phone screenshots', rule='Play has no gallery video slot: all six screenshots',
      files=stills('android', 'out-formats/android', '1080x1920')),
  'android/tablet-7': dict(display='Google Play 7-inch tablet screenshots', rule='Play has no gallery video slot: all six screenshots',
      files=stills('tablet-7', 'out-formats/tablet-7', '1200x1920')),
  'android/tablet-10': dict(display='Google Play 10-inch tablet screenshots', rule='Play has no gallery video slot: all six screenshots',
      files=stills('tablet-10', 'out-formats/tablet-10', '1600x2560')),
  'android/feature-graphic': dict(display='Google Play feature graphic', rule='single image',
      files=[(T / 'renderer/out-formats/feature/play-feature-1024x500.png', 'feature-graphic-1024x500.png', '1024x500')]),
}
if out.exists(): shutil.rmtree(out)
for fmt, d in FORMATS.items():
    dst = out / fmt; dst.mkdir(parents=True)
    entries, sums = [], []
    for slot, (src, name, size) in enumerate(d['files'], 1):
        shutil.copyfile(src, dst / name)
        h = hashlib.sha256((dst / name).read_bytes()).hexdigest()
        sums.append(f'{h}  {name}')
        e = {'slot': slot, 'file': name, 'size': size, 'bytes': (dst / name).stat().st_size}
        if name.endswith('.mp4'): e['duration_s'] = d['video']['duration_s']
        entries.append(e)
    m = {'format': fmt, 'display': d['display'], 'screenshot_rule': d['rule'], 'story': COMMON, 'slots': entries}
    if 'video' in d: m['video'] = d['video']
    m['status'] = 'prepared, not uploaded'
    (dst / 'manifest.json').write_text(json.dumps(m, indent=2) + '\n')
    (dst / 'SHA256SUMS').write_text('\n'.join(sums) + '\n')
promo = out / 'android/promo-video'; promo.mkdir(parents=True)
(promo / 'manifest.json').write_text(json.dumps({'format': 'android/promo-video', 'display': 'Google Play promo video (YouTube URL field)',
  'status': 'blocked: not rendered',
  'reason': 'Play takes a YouTube link, and needs a YouTube link before Play can use it. No Android tour recording exists yet; the only tour take is the iOS one, and an iPhone recording would misrepresent the Android app.',
  'next_step': 'Record the same six-beat tour on the Android emulator (androids VM) with the v8 fixture, then compose 1920x1080 with the same cut.',
  'slots': []}, indent=2) + '\n')
print('ok')
