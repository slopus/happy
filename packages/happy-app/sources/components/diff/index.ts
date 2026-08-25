export { DiffChunk } from './DiffChunk';
export { DiffFileView } from './DiffFileView';
export { DiffFileHeader } from './DiffFileHeader';
export { DiffFilesList } from './DiffFilesList';
export { useDiffDocument, type DiffSource } from './useDiffDocument';
export { buildDiffFromContents, buildDiffFromPatch, clearDiffCache, type BuildOptions } from './engine/buildDiff';
export { countContentStats, countPatchStats } from './engine/stats';
export type { DiffDocument, DiffFile, DiffRow, DiffSpan } from './engine/types';
