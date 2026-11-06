import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function createGoalDataset(home) {
    const projects = path.join(home, '.codex/skills/goal-first-ops/projects');
    const featurePath = path.join(projects, 'fixture-project/features/current');
    const otherFeaturePath = path.join(projects, 'fixture-project/features/other');
    const taskDirectories = new Map();
    const write = async (file, body) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body); };
    await write(path.join(projects, 'fixture-project/index.md'), '# 隔离验收项目\n');
    const links = [];
    const statuses = ['running', 'done', 'review', 'blocked', 'pending', 'unknown'];
    for (let i = 1; i <= 20; i++) {
        const code = `G${String(i).padStart(2, '0')}`;
        const directory = path.join(featurePath, 'tasks', `${code}-中文任务`);
        taskDirectories.set(code, directory);
        links.push(`| ${code} | [${code} 真实任务记录](tasks/${code}-中文任务/index.md) | [任务说明](tasks/${code}-中文任务/PROMPT.md) |`);
        const outputs = i === 1 ? '\n## 当前产物\n[验收报告](完整 中文报告.md)：Markdown 完整正文\n[示例代码](示例 code.ts)\n[示例图片](示例 图片.png)\n[音频记录](提示 音频.mp3)\n[视频记录](演示 视频.mp4)\n[PDF 原件](验收 文档.pdf)\n[文件缺失](missing.md)\n[超限文本](oversized.txt)\n[不支持格式](unsupported.zip)\n[越界链接](escape.md)\n## 相关参考\n[历史基线](baseline.md)\n[执行契约](PROMPT.md)\n' : '';
        await write(path.join(directory, 'index.md'), `---\nstatus: ${statuses[(i - 1) % statuses.length]}\nstage: 独立验收\n---\n# ${code} ${i === 1 ? '原始产物全类型验证' : '任务目标 ' + i}\n目标摘要：验证真实 Goal First 记录 ${code}\n## 要解决的问题\n通过完整 App 验证状态、原件读取与缓存\n## 当前进展\n使用临时文件，未执行真实 RSI 任务\n## 下一步\n用户手动验收\n${outputs}`);
        await write(path.join(directory, 'PROMPT.md'), `# ${code} 任务说明\n## 要解决的问题\n真实文件与加密会话集成验收\n## 预期交付物\n- 验收报告\n- 验收证据\n`);
    }
    await write(path.join(featurePath, 'index.md'), '# Goal Board 隔离验收\n[任务地图](总任务地图.md)\n');
    await write(path.join(featurePath, '总任务地图.md'), '# 真实任务导航\n' + links.join('\n'));
    await write(path.join(otherFeaturePath, 'index.md'), '# 第二个目标\n[另一个任务](tasks/G21/index.md)\n');
    await write(path.join(otherFeaturePath, 'tasks/G21/index.md'), '---\nstatus: pending\n---\n# G21 独立候选目标\n目标摘要：验证目标切换隔离\n');
    const task = taskDirectories.get('G01');
    const markdown = '# 完整验收报告\n\n这是实际读取的中文原件，包含空格文件名。\n\n## 证据表\n\n| 检查 | 结果 |\n| --- | --- |\n| 中文路径 | 原文保留 |\n| 完整阅读 | 到末尾标记 |\n\n```ts\nexport const original = true;\n```\n\n' + Array.from({ length: 80 }, (_, i) => `段落 ${i + 1}：保留真实原文，不生成摘要。\n\n`).join('') + '\n**GOAL_ARTIFACT_FULL_CONTENT_END**\n';
    await write(path.join(task, '完整 中文报告.md'), markdown);
    await write(path.join(task, '示例 code.ts'), '// 中文路径与完整代码\nexport const goalBoardFixture = { isolated: true, original: true };\n// GOAL_CODE_END\n');
    await write(path.join(task, 'baseline.md'), '# 历史基线\n参考资料，不是本轮产出。\n');
    await write(path.join(task, 'oversized.txt'), '');
    await fs.truncate(path.join(task, 'oversized.txt'), 2 * 1024 * 1024 + 1);
    await write(path.join(task, 'unsupported.zip'), 'fixture unsupported data');
    await write(path.join(home, 'outside-goal.md'), 'This file must not be read through the Goal catalog');
    await fs.symlink(path.join(home, 'outside-goal.md'), path.join(task, 'escape.md'));
    const ffmpeg = args => {
        const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`ffmpeg fixture generation failed: ${result.stderr || result.error}`);
    };
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=royalblue:s=480x270', '-vf', 'drawbox=x=60:y=50:w=180:h=150:color=gold:t=fill', '-frames:v', '1', path.join(task, '示例 图片.png')]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', path.join(task, '提示 音频.mp3')]);
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(task, '演示 视频.mp4')]);
    const stream = 'BT /F1 18 Tf 42 750 Td (Goal Board original PDF fixture) Tj 0 -30 Td (No real RSI task was executed.) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    await write(path.join(task, '验收 文档.pdf'), pdf);
    return { home, featurePath, otherFeaturePath, taskDirectories, markdown };
}
