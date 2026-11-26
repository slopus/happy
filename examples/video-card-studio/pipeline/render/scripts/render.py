"""按已选字幕叠加原画面；Pillow只负责字体测量与图片合成。"""
import argparse
import json
import os
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

WIDTH, MARGIN = 1080, 86
CONTENT = WIDTH - MARGIN * 2


def find_font(explicit):
    for item in [explicit, os.environ.get('VIDEO_CARDS_FONT'),
                 '/System/Library/Fonts/PingFang.ttc',
                 '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
                 'C:/Windows/Fonts/msyh.ttc']:
        if item and Path(item).is_file():
            return str(item)
    raise ValueError('请通过 --font 指定中文字体')


def lines(text, font, width):
    result = []
    for paragraph in text.split('\n'):
        parts = []
        tokens = re.findall(r'[A-Za-z0-9]+(?:[.,−+\-/＝=÷—][A-Za-z0-9]+)*(?:%|％)?|[^A-Za-z0-9]', paragraph)
        for token in tokens:
            if parts and font.getlength(''.join(parts) + token) > width:
                if len(parts) > 1 and (token in '，。！？；：、）】》”’' or parts[-1] in '（【《“‘'):
                    carried = parts.pop()
                    result.append(''.join(parts))
                    parts = [carried, token]
                else:
                    result.append(''.join(parts))
                    parts = [token]
            else:
                parts.append(token)
        result.append(''.join(parts))
    return result


def subtitle_lines(block, by_id, font):
    # 文字只来自指定的原字幕，不接受标题、摘要或自由改写正文。
    excerpts = block.get('excerpts', {})
    if not isinstance(excerpts, dict):
        raise ValueError('摘选必须按字幕ID提供原句连续子串')
    for ident, text in excerpts.items():
        if (ident not in block['evidence'] or not isinstance(text, str)
                or not text.strip() or text not in by_id[ident]['text']):
            raise ValueError('摘选必须是已引用字幕的非空连续原文，不能改写')
    return [line for ident in block['evidence']
            for line in lines(excerpts.get(ident, by_id[ident]['text']), font, CONTENT)]


def render(out, plan, font_path, max_height):
    by_id = {s['id']: s for s in json.loads((out / 'transcript.json').read_text())['segments']}
    frames = {row['key']: row for row in json.loads((out / 'frames.json').read_text())}
    font = ImageFont.truetype(font_path, 46)
    leading = 70
    directory = out / 'cards'
    directory.mkdir(exist_ok=True)
    outputs = []
    for card in plan['cards']:
        panels = []
        for i, block in enumerate(card['blocks']):
            key = f"{card['id']}-{i + 1}" if block.get('visual') else f"{card['id']}-hero"
            selected = frames[key]['selected']
            if selected not in [c['file'] for c in frames[key]['candidates']]:
                raise ValueError('selected必须指向实际提取的候选帧')
            path = (out / selected).resolve()
            if not path.is_relative_to(out.resolve()):
                raise ValueError('画面路径不得离开输出目录')
            picture = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
            picture = picture.resize((WIDTH, round(WIDTH * picture.height / picture.width)), Image.Resampling.LANCZOS)
            visual = block.get('visual') or card['visual']
            if visual['role'] == 'speaker':
                # 人物画面下沿淡入黑底，避免原画面底部小字幕与叠加字幕重叠。
                start, end = round(picture.height * .70), round(picture.height * .92)
                mask = Image.new('L', picture.size, 0)
                draw = ImageDraw.Draw(mask)
                for y in range(start, picture.height):
                    alpha = min(255, round(255 * (y - start) / max(1, end - start)))
                    draw.line((0, y, WIDTH, y), fill=alpha)
                picture = Image.composite(Image.new('RGB', picture.size, '#080808'), picture, mask)
            text = subtitle_lines(block, by_id, font)
            height = max(1440, picture.height + 100 + len(text) * leading + 86)
            panel = Image.new('RGB', (WIDTH, height), '#080808')
            panel.paste(picture, (0, 0))
            draw = ImageDraw.Draw(panel)
            y = picture.height + max(54, (height - picture.height - len(text) * leading) // 2)
            for line in text:
                draw.text((WIDTH / 2, y), line, font=font, fill='white', anchor='mt', stroke_width=1)
                y += leading
            panels.append(panel)
        height = sum(panel.height for panel in panels)
        if height > max_height:
            raise ValueError('长图超过高度限制，请按原视频的完整观点拆组，不能改写字幕压缩篇幅')
        image = Image.new('RGB', (WIDTH, height), '#080808')
        y = 0
        for panel in panels:
            image.paste(panel, (0, y))
            y += panel.height
        file = directory / f"{card['id']}.png"
        image.save(file)
        outputs.append({'card': card['id'], 'file': str(file.relative_to(out)), 'width': WIDTH, 'height': height})
    (out / 'cards.json').write_text(json.dumps(outputs, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'images': outputs}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='原画面叠加原字幕，同一观点拼成长图')
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--font')
    parser.add_argument('--max-height', type=int, default=12000)
    args = parser.parse_args()
    render(args.out.resolve(), json.loads(args.plan.read_text()), find_font(args.font), args.max_height)
