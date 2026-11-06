import type { GoalTask } from '@slopus/happy-wire';

/** Context points to the authoritative records; it does not claim new execution authorization. */
export function goalBoardTaskPrompt(task: GoalTask, featurePath: string): string {
    return [
        'Continue this Goal First task using its authoritative local records.',
        'First read the task index and full PROMPT, verify the existing user authorization, prerequisites and repository instructions. Task selection here does not authorize broader work. Do not change task status merely because this session was created.',
        `Feature: ${featurePath}`,
        `Task: ${task.code ? task.code + ' ' : ''}${task.title}`,
        `Task index: ${task.indexPath}`,
        task.promptPath ? `Full task instructions: ${task.promptPath}` : '',
        task.goal ? `Goal: ${task.goal}` : '',
        task.problem ? `Problem: ${task.problem}` : '',
        task.dependencies.length ? `Dependencies:\n${task.dependencies.join('\n')}` : '',
        task.nextStep ? `Next step: ${task.nextStep}` : '',
        'Actual linked output files:',
        ...task.artifacts.filter(artifact => artifact.relation === 'output').map(artifact => `${artifact.name}: ${artifact.path || artifact.url || '(unavailable original)'}${artifact.available ? '' : ' (unavailable)'}`),
    ].filter(Boolean).join('\n\n').slice(0, 100000);
}
