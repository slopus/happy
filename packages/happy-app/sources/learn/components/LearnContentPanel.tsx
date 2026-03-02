import * as React from 'react';
import { Text, View, ScrollView, Pressable, ActivityIndicator, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { learnApi } from '../learnApi';
import { learnStorage, useLearnActiveLesson } from '../learnStorage';
import type { LessonContent } from '../learnTypes';

// Context for video seek from chat timestamps
export const VideoSeekContext = React.createContext<((seconds: number) => void) | null>(null);

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        gap: 8,
    },
    headerTitle: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    headerButton: {
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    content: {
        padding: 16,
        paddingBottom: 100,
    },
    breadcrumb: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 4,
        ...Typography.default(),
    },
    lessonTitle: {
        fontSize: 18,
        color: theme.colors.text,
        marginBottom: 12,
        ...Typography.default('bold'),
    },
    videoContainer: {
        marginBottom: 16,
        borderRadius: 10,
        overflow: 'hidden',
        backgroundColor: '#000',
    },
    objectivesContainer: {
        marginBottom: 16,
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.groupped.item,
    },
    objectivesTitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 6,
        ...Typography.default('semiBold'),
    },
    objectiveRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 6,
        paddingVertical: 2,
    },
    objectiveText: {
        fontSize: 13,
        color: theme.colors.text,
        flex: 1,
        ...Typography.default(),
    },
    navRow: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 20,
        paddingHorizontal: 4,
    },
    navButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        paddingVertical: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.groupped.item,
    },
    navButtonText: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    completeButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 12,
        borderRadius: 10,
        marginTop: 16,
    },
    completeButtonText: {
        fontSize: 14,
        color: '#fff',
        ...Typography.default('semiBold'),
    },
    completedBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 10,
        marginTop: 12,
    },
    completedText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
    },
    emptyText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 12,
        ...Typography.default(),
    },
}));

// Convert lesson content (string or { blocks: [...] }) to markdown string
function extractMarkdown(content: any): string {
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object' && Array.isArray(content.blocks)) {
        return content.blocks
            .filter((b: any) => b.type === 'text' && b.content)
            .map((b: any) => b.content)
            .join('\n\n');
    }
    return String(content || '');
}

// Format seconds to m:ss or h:mm:ss
function formatTime(sec: number): string {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// Extract structured blocks from lesson content
export function extractBlocks(content: any) {
    if (!content || typeof content !== 'object' || !Array.isArray(content.blocks)) return null;
    const blocks = content.blocks;
    const sections = blocks.filter((b: any) => b.type === 'section');
    const keyPoints = blocks.filter((b: any) => b.type === 'key_point');
    const terms = blocks.filter((b: any) => b.type === 'term');
    const quiz = blocks.filter((b: any) => b.type === 'quiz');
    const transcript = content.transcript;
    if (sections.length === 0 && keyPoints.length === 0 && terms.length === 0 && !transcript) return null;
    return { sections, keyPoints, terms, quiz, transcript };
}

// Section card
const SectionBlock = React.memo(({ section, theme, courseColor }: { section: any; theme: any; courseColor?: string }) => (
    <View style={{
        marginBottom: 10,
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.groupped.item,
    }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Ionicons name="time-outline" size={12} color={theme.colors.textSecondary} />
            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                {formatTime(section.startTime)} — {formatTime(section.endTime)}
            </Text>
        </View>
        <Text style={{ fontSize: 14, color: theme.colors.text, marginBottom: 4, ...Typography.default('semiBold') }}>
            {section.title}
        </Text>
        <Text style={{ fontSize: 13, color: theme.colors.textSecondary, lineHeight: 18, ...Typography.default() }}>
            {section.summary}
        </Text>
    </View>
));

// Key point pill
const KeyPointBlock = React.memo(({ point, theme, courseColor }: { point: any; theme: any; courseColor?: string }) => (
    <View style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingVertical: 4,
    }}>
        <Ionicons name="bulb-outline" size={14} color={theme.colors.textSecondary} style={{ marginTop: 2 }} />
        <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, color: theme.colors.text, lineHeight: 18, ...Typography.default() }}>
                {point.content}
            </Text>
            {point.timestamp != null && (
                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, marginTop: 2, ...Typography.default() }}>
                    {formatTime(point.timestamp)}
                </Text>
            )}
        </View>
    </View>
));

// Term card
const TermBlock = React.memo(({ term, theme, courseColor }: { term: any; theme: any; courseColor?: string }) => (
    <View style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingVertical: 4,
    }}>
        <Ionicons name="book-outline" size={13} color={theme.colors.textSecondary} style={{ marginTop: 2 }} />
        <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>
                {term.term}
            </Text>
            <Text style={{ fontSize: 12, color: theme.colors.textSecondary, lineHeight: 17, marginTop: 2, ...Typography.default() }}>
                {term.definition}
            </Text>
        </View>
    </View>
));

// Quiz question (collapsible answer)
const QuizBlock = React.memo(({ item, theme }: { item: any; theme: any }) => {
    const [open, setOpen] = React.useState(false);
    const diffColor = item.difficulty === 'easy' ? '#4caf50' : item.difficulty === 'medium' ? '#ff9800' : '#f44336';
    return (
        <Pressable
            onPress={() => setOpen((v) => !v)}
            style={{
                marginBottom: 8,
                padding: 12,
                borderRadius: 10,
                backgroundColor: theme.colors.groupped.item,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <Ionicons name="help-circle-outline" size={14} color={diffColor} />
                <Text style={{ fontSize: 11, color: diffColor, ...Typography.default('semiBold') }}>
                    {item.difficulty === 'easy' ? 'Легко' : item.difficulty === 'medium' ? 'Средне' : 'Сложно'}
                </Text>
                <View style={{ flex: 1 }} />
                <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={theme.colors.textSecondary} />
            </View>
            <Text style={{ fontSize: 13, color: theme.colors.text, lineHeight: 18, ...Typography.default('semiBold') }}>
                {item.question}
            </Text>
            {open && (
                <Text style={{
                    fontSize: 13, color: theme.colors.textSecondary, lineHeight: 18, marginTop: 8,
                    paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider,
                    ...Typography.default(),
                }}>
                    {item.answer}
                </Text>
            )}
        </Pressable>
    );
});

// Transcript viewer (collapsible)
const TranscriptBlock = React.memo(({ transcript, theme, onTimestampPress, courseColor }: { transcript: any; theme: any; onTimestampPress?: (seconds: number) => void; courseColor?: string }) => {
    const [expanded, setExpanded] = React.useState(false);
    if (!transcript?.segments?.length) return null;

    const fullText = transcript.segments.map((s: any) => s.text).join(' ');
    const previewText = fullText.substring(0, 200) + (fullText.length > 200 ? '...' : '');

    return (
        <View style={{
            marginBottom: 16,
            padding: 12,
            borderRadius: 10,
            backgroundColor: theme.colors.groupped.item,
        }}>
            <Pressable
                onPress={() => setExpanded((v) => !v)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}
            >
                <Ionicons name="document-text-outline" size={14} color={theme.colors.textSecondary} />
                <Text style={{ fontSize: 13, color: theme.colors.text, flex: 1, ...Typography.default('semiBold') }}>
                    Транскрипт
                </Text>
                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                    {transcript.language?.toUpperCase()}
                </Text>
                <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.colors.textSecondary} />
            </Pressable>
            {expanded ? (
                <View>
                    {transcript.segments.map((seg: any, i: number) => (
                        <View key={i} style={{ flexDirection: 'row', gap: 8, marginBottom: 6 }}>
                            <Text
                                onPress={onTimestampPress ? () => onTimestampPress(Math.floor(seg.start)) : undefined}
                                style={{
                                    fontSize: 11, color: theme.colors.textSecondary, width: 38,
                                    ...Typography.default('semiBold'),
                                }}
                            >
                                {formatTime(seg.start)}
                            </Text>
                            <Text style={{
                                fontSize: 13, color: theme.colors.text, flex: 1, lineHeight: 18,
                                ...Typography.default(),
                            }}>
                                {seg.text}
                            </Text>
                        </View>
                    ))}
                </View>
            ) : (
                <Text style={{ fontSize: 13, color: theme.colors.textSecondary, lineHeight: 18, ...Typography.default() }}>
                    {previewText}
                </Text>
            )}
        </View>
    );
});

// Content section header
const ContentSectionHeader = React.memo(({ icon, title, count, theme, courseColor }: {
    icon: string; title: string; count: number; theme: any; courseColor?: string;
}) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, marginTop: 16 }}>
        <Ionicons name={icon as any} size={15} color={theme.colors.textSecondary} />
        <Text style={{ fontSize: 14, color: theme.colors.text, flex: 1, ...Typography.default('semiBold') }}>
            {title}
        </Text>
        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
            {count}
        </Text>
    </View>
));

// Extract YouTube video ID from various URL formats
function getYouTubeId(url: string): string | null {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return null;
}

// Web video player — supports YouTube embeds and direct video URLs
// fill=true: stretch to fill parent container (for focus mode)
export type VideoPlayerHandle = {
    seekTo: (seconds: number) => void;
};

const PLAYBACK_RATES = [1, 1.25, 1.5, 2];

export const VideoPlayer = React.memo(React.forwardRef<VideoPlayerHandle, { url: string; fill?: boolean; courseColor?: string }>(({ url: rawUrl, fill, courseColor }, ref) => {
    if (Platform.OS !== 'web') return null;

    // Add /videos/ prefix for relative paths (served from nginx)
    const url = rawUrl.startsWith('http') || rawUrl.startsWith('/') ? rawUrl : `/videos/${rawUrl}`;
    const youtubeId = getYouTubeId(url);
    const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
    const videoRef = React.useRef<HTMLVideoElement | null>(null);
    const storageKey = `learn_video_pos_${youtubeId || url}`;
    const accentColor = '#fff';

    // Load saved position
    const savedTime = React.useMemo(() => {
        try {
            const v = localStorage.getItem(storageKey);
            return v ? Math.max(0, Math.floor(parseFloat(v)) - 2) : 0;
        } catch { return 0; }
    }, [storageKey]);

    // Custom player state (mp4 only)
    const [playing, setPlaying] = React.useState(false);
    const [currentTime, setCurrentTime] = React.useState(0);
    const [duration, setDuration] = React.useState(0);
    const [showControls, setShowControls] = React.useState(true);
    const [rateIdx, setRateIdx] = React.useState(0);
    const hideTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const progressBarRef = React.useRef<HTMLDivElement | null>(null);
    const seekOverrideRef = React.useRef(false); // suppress savedTime restore after seekTo

    // Auto-hide controls
    const scheduleHide = React.useCallback(() => {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => {
            if (videoRef.current && !videoRef.current.paused) setShowControls(false);
        }, 3000);
    }, []);

    const revealControls = React.useCallback(() => {
        setShowControls(true);
        scheduleHide();
    }, [scheduleHide]);

    // Expose seekTo method
    React.useImperativeHandle(ref, () => ({
        seekTo: (seconds: number) => {
            if (youtubeId && iframeRef.current) {
                iframeRef.current.contentWindow?.postMessage(JSON.stringify({
                    event: 'command',
                    func: 'seekTo',
                    args: [seconds, true],
                }), 'https://www.youtube.com');
            } else if (videoRef.current) {
                const video = videoRef.current;
                seekOverrideRef.current = true; // prevent savedTime from overriding
                if (video.readyState >= 1) {
                    video.currentTime = seconds;
                    revealControls();
                } else {
                    // Video not loaded yet — wait for metadata then seek
                    const onReady = () => {
                        video.currentTime = seconds;
                        revealControls();
                        video.removeEventListener('loadedmetadata', onReady);
                    };
                    video.addEventListener('loadedmetadata', onReady);
                }
            }
        },
    }), [youtubeId, revealControls]);

    // YouTube: periodically save position via postMessage API
    React.useEffect(() => {
        if (!youtubeId) return;
        const iframe = iframeRef.current;
        if (!iframe) return;
        const handleMessage = (e: MessageEvent) => {
            if (e.origin !== 'https://www.youtube.com') return;
            try {
                const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
                if (data.event === 'infoDelivery' && data.info?.currentTime != null) {
                    localStorage.setItem(storageKey, String(data.info.currentTime));
                }
            } catch {}
        };
        window.addEventListener('message', handleMessage);
        const interval = setInterval(() => {
            try {
                iframe.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1 }), 'https://www.youtube.com');
            } catch {}
        }, 3000);
        return () => { window.removeEventListener('message', handleMessage); clearInterval(interval); };
    }, [youtubeId, storageKey]);

    // HTML video: save position + update state on timeupdate
    React.useEffect(() => {
        if (youtubeId) return;
        const video = videoRef.current;
        if (!video) return;
        const handleTime = () => {
            setCurrentTime(video.currentTime);
            localStorage.setItem(storageKey, String(video.currentTime));
        };
        const handlePlay = () => { setPlaying(true); scheduleHide(); };
        const handlePause = () => { setPlaying(false); setShowControls(true); if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
        const handleMeta = () => { setDuration(video.duration); if (savedTime > 0 && !seekOverrideRef.current) video.currentTime = savedTime; };
        const handleEnded = () => { setPlaying(false); setShowControls(true); };
        video.addEventListener('timeupdate', handleTime);
        video.addEventListener('play', handlePlay);
        video.addEventListener('pause', handlePause);
        video.addEventListener('loadedmetadata', handleMeta);
        video.addEventListener('ended', handleEnded);
        return () => {
            video.removeEventListener('timeupdate', handleTime);
            video.removeEventListener('play', handlePlay);
            video.removeEventListener('pause', handlePause);
            video.removeEventListener('loadedmetadata', handleMeta);
            video.removeEventListener('ended', handleEnded);
        };
    }, [youtubeId, storageKey, savedTime, scheduleHide]);

    // Fullscreen toggle
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const [isFullscreen, setIsFullscreen] = React.useState(false);

    const toggleFullscreen = React.useCallback(() => {
        const el = containerRef.current;
        const v = videoRef.current as any;
        if (!el) return;
        if (!document.fullscreenElement) {
            // Try container fullscreen first (desktop), fallback to video element (iOS Safari)
            if (el.requestFullscreen) {
                el.requestFullscreen();
            } else if (v?.webkitEnterFullscreen) {
                v.webkitEnterFullscreen();
            } else if ((el as any).webkitRequestFullscreen) {
                (el as any).webkitRequestFullscreen();
            }
        } else {
            document.exitFullscreen?.();
        }
    }, []);

    React.useEffect(() => {
        const handler = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', handler);
        return () => document.removeEventListener('fullscreenchange', handler);
    }, []);

    // Keyboard shortcuts (space, arrows, Tab for ±10s, f for fullscreen)
    const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
        if (youtubeId) return;
        const v = videoRef.current;
        if (!v) return;

        if (e.key === ' ' || e.code === 'Space') {
            e.preventDefault();
            if (v.paused) v.play(); else v.pause();
            revealControls();
        } else if (e.key === 'Tab') {
            e.preventDefault();
            v.currentTime = Math.min(v.duration, Math.max(0, v.currentTime + (e.shiftKey ? -10 : 10)));
            revealControls();
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            v.currentTime = Math.min(v.duration, v.currentTime + 5);
            revealControls();
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            v.currentTime = Math.max(0, v.currentTime - 5);
            revealControls();
        } else if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            toggleFullscreen();
        }
    }, [youtubeId, revealControls, toggleFullscreen]);

    // Cleanup timer
    React.useEffect(() => () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); }, []);

    const togglePlay = React.useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) { v.play(); } else { v.pause(); }
    }, []);

    const cycleRate = React.useCallback(() => {
        const next = (rateIdx + 1) % PLAYBACK_RATES.length;
        setRateIdx(next);
        if (videoRef.current) videoRef.current.playbackRate = PLAYBACK_RATES[next];
        revealControls();
    }, [rateIdx, revealControls]);

    // Progress bar seek via touch/mouse
    const seekFromEvent = React.useCallback((clientX: number) => {
        const bar = progressBarRef.current;
        const v = videoRef.current;
        if (!bar || !v || !duration) return;
        const rect = bar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        v.currentTime = ratio * duration;
        setCurrentTime(ratio * duration);
    }, [duration]);

    const handleBarPointerDown = React.useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        seekFromEvent(e.clientX);
        const handleMove = (ev: PointerEvent) => seekFromEvent(ev.clientX);
        const handleUp = () => { window.removeEventListener('pointermove', handleMove); window.removeEventListener('pointerup', handleUp); };
        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleUp);
    }, [seekFromEvent]);

    const videoStyle = fill
        ? { width: '100%', height: '100%', border: 'none', display: 'block' }
        : { width: '100%', aspectRatio: '16/9', border: 'none', display: 'block' };

    const containerStyle = fill ? { flex: 1, backgroundColor: '#000' } : styles.videoContainer;

    if (youtubeId) {
        return (
            <View style={containerStyle}>
                {/* @ts-ignore */}
                <iframe
                    ref={iframeRef}
                    src={`https://www.youtube.com/embed/${youtubeId}?rel=0&enablejsapi=1${savedTime > 0 ? `&start=${savedTime}` : ''}`}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    frameBorder="0"
                    style={videoStyle}
                />
            </View>
        );
    }

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

    return (
        // @ts-ignore
        <div ref={containerRef} tabIndex={0} onKeyDown={handleKeyDown as any} style={{ position: 'relative', overflow: 'hidden', outline: 'none', ...(fill ? { flex: 1, backgroundColor: '#000' } : { marginBottom: 16, borderRadius: 10, backgroundColor: '#000' }), ...(isFullscreen ? { display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', width: '100%', height: '100%' } : {}) }}>
            {/* @ts-ignore - HTML video on web */}
            <video
                ref={videoRef}
                src={encodeURI(url)}
                playsInline
                onClick={revealControls}
                style={{ ...videoStyle, backgroundColor: '#000', objectFit: 'contain' as any, ...(isFullscreen ? { width: '100%', height: '100%' } : {}) }}
            />
            {/* Overlay controls */}
            {/* @ts-ignore */}
            <div
                onClick={(e: any) => { e.stopPropagation(); togglePlay(); revealControls(); }}
                style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: showControls ? 'rgba(0,0,0,0.25)' : 'transparent',
                    transition: 'background 0.2s',
                    cursor: 'pointer',
                }}
            >
                {/* Center controls: -10s, Play/Pause, +10s */}
                {showControls && (
                    // @ts-ignore
                    <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
                        {/* -10s */}
                        {/* @ts-ignore */}
                        <div
                            onClick={(e: any) => { e.stopPropagation(); const v = videoRef.current; if (v) { v.currentTime = Math.max(0, v.currentTime - 10); revealControls(); } }}
                            style={{
                                width: 44, height: 44, borderRadius: 22,
                                backgroundColor: 'rgba(0,0,0,0.5)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                cursor: 'pointer',
                            }}
                        >
                            <Ionicons name="play-back" size={20} color="#fff" />
                        </div>
                        {/* Play/Pause */}
                        {/* @ts-ignore */}
                        <div style={{
                            width: 52, height: 52, borderRadius: 26,
                            backgroundColor: 'rgba(0,0,0,0.5)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                            <Ionicons name={playing ? 'pause' : 'play'} size={28} color="#fff" style={playing ? {} : { marginLeft: 3 }} />
                        </div>
                        {/* +10s */}
                        {/* @ts-ignore */}
                        <div
                            onClick={(e: any) => { e.stopPropagation(); const v = videoRef.current; if (v) { v.currentTime = Math.min(v.duration, v.currentTime + 10); revealControls(); } }}
                            style={{
                                width: 44, height: 44, borderRadius: 22,
                                backgroundColor: 'rgba(0,0,0,0.5)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                cursor: 'pointer',
                            }}
                        >
                            <Ionicons name="play-forward" size={20} color="#fff" />
                        </div>
                    </div>
                )}
            </div>
            {/* Bottom bar: time + rate */}
            {showControls && (
                // @ts-ignore
                <div
                    onClick={(e: any) => e.stopPropagation()}
                    style={{
                        position: 'absolute', bottom: 8, left: 8, right: 8,
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        pointerEvents: 'auto',
                    }}
                >
                    {/* @ts-ignore */}
                    <span style={{ color: '#fff', fontSize: 11, fontFamily: 'monospace', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
                        {formatTime(currentTime)} / {formatTime(duration)}
                    </span>
                    {/* @ts-ignore */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {/* @ts-ignore */}
                        <span
                            onClick={(e: any) => { e.stopPropagation(); cycleRate(); }}
                            style={{
                                color: PLAYBACK_RATES[rateIdx] !== 1 ? accentColor : '#fff',
                                fontSize: 11, fontFamily: 'monospace', fontWeight: '600',
                                cursor: 'pointer', textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                padding: '2px 6px', borderRadius: 4,
                                backgroundColor: 'rgba(0,0,0,0.4)',
                            }}
                        >
                            {PLAYBACK_RATES[rateIdx]}x
                        </span>
                        {/* @ts-ignore */}
                        <span
                            onClick={(e: any) => { e.stopPropagation(); toggleFullscreen(); }}
                            style={{
                                cursor: 'pointer', textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                                padding: '4px 6px', borderRadius: 4,
                                backgroundColor: 'rgba(0,0,0,0.4)',
                                display: 'flex', alignItems: 'center',
                            }}
                        >
                            <Ionicons name={isFullscreen ? 'contract' : 'expand'} size={18} color="#fff" />
                        </span>
                    </div>
                </div>
            )}
            {/* Progress bar — always visible */}
            {/* @ts-ignore */}
            <div
                ref={progressBarRef}
                onPointerDown={handleBarPointerDown}
                style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0,
                    height: 12, cursor: 'pointer',
                    display: 'flex', alignItems: 'flex-end',
                }}
            >
                {/* @ts-ignore */}
                <div style={{ width: '100%', height: 3, backgroundColor: 'rgba(255,255,255,0.25)', position: 'relative' }}>
                    {/* @ts-ignore */}
                    <div style={{
                        height: '100%', width: `${progress}%`,
                        backgroundColor: accentColor,
                        borderRadius: '0 1.5px 1.5px 0',
                        transition: 'width 0.1s linear',
                    }} />
                </div>
            </div>
        </div>
    );
}));

// Render all structured blocks from lesson content
export const LessonBlocks = React.memo(({ content, theme, onTimestampPress, courseColor }: { content: any; theme: any; onTimestampPress?: (seconds: number) => void; courseColor?: string }) => {
    const data = extractBlocks(content);
    if (!data) return null;
    const { sections, keyPoints, terms, quiz, transcript } = data;

    return (
        <View>
            {/* Sections */}
            {sections.length > 0 && (
                <>
                    <ContentSectionHeader icon="list-outline" title="Разделы" count={sections.length} theme={theme} courseColor={courseColor} />
                    {sections.map((s: any, i: number) => <SectionBlock key={i} section={s} theme={theme} courseColor={courseColor} />)}
                </>
            )}

            {/* Key Points */}
            {keyPoints.length > 0 && (
                <View style={{
                    marginBottom: 12,
                    padding: 12,
                    borderRadius: 10,
                    backgroundColor: theme.colors.groupped.item,
                }}>
                    <ContentSectionHeader icon="bulb-outline" title="Ключевые моменты" count={keyPoints.length} theme={theme} courseColor={courseColor} />
                    {keyPoints.map((p: any, i: number) => <KeyPointBlock key={i} point={p} theme={theme} courseColor={courseColor} />)}
                </View>
            )}

            {/* Terms */}
            {terms.length > 0 && (
                <View style={{
                    marginBottom: 12,
                    padding: 12,
                    borderRadius: 10,
                    backgroundColor: theme.colors.groupped.item,
                }}>
                    <ContentSectionHeader icon="book-outline" title="Термины" count={terms.length} theme={theme} courseColor={courseColor} />
                    {terms.map((t: any, i: number) => <TermBlock key={i} term={t} theme={theme} courseColor={courseColor} />)}
                </View>
            )}

            {/* Quiz */}
            {quiz.length > 0 && (
                <>
                    <ContentSectionHeader icon="help-circle-outline" title="Вопросы" count={quiz.length} theme={theme} courseColor={courseColor} />
                    {quiz.map((q: any, i: number) => <QuizBlock key={i} item={q} theme={theme} />)}
                </>
            )}

            {/* Transcript */}
            {transcript && <TranscriptBlock transcript={transcript} theme={theme} onTimestampPress={onTimestampPress} courseColor={courseColor} />}
        </View>
    );
});

interface LearnContentPanelProps {
    onClose: () => void;
    hideVideo?: boolean;
    courseColor?: string;
}

export const LearnContentPanel = React.memo(({ onClose, hideVideo, courseColor }: LearnContentPanelProps) => {
    const { theme } = useUnistyles();
    const lesson = useLearnActiveLesson();
    const [completing, setCompleting] = React.useState(false);

    const isCompleted = lesson?.lessonState?.some((s) => s.status === 'COMPLETED') ?? false;

    const handleComplete = React.useCallback(async () => {
        if (completing || !lesson) return;
        setCompleting(true);
        try {
            await learnApi.completeLesson(lesson.id);
            learnStorage.getState().setActiveLesson({
                ...lesson,
                lessonState: [{ status: 'COMPLETED', completedAt: new Date().toISOString() }],
            });
            // Refresh courses
            const { courses } = await learnApi.getCourses();
            learnStorage.getState().setCourses(courses);
        } catch (e) {
            console.error(e);
        } finally {
            setCompleting(false);
        }
    }, [lesson, completing]);

    const navigateToLesson = React.useCallback(async (lessonId: string) => {
        try {
            const res = await learnApi.getLesson(lessonId);
            learnStorage.getState().setActiveLesson(res.lesson);
        } catch (e) {
            console.error(e);
        }
    }, []);

    if (!lesson) {
        return (
            <View style={styles.container}>
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>Урок</Text>
                    <Pressable style={styles.headerButton} onPress={onClose}>
                        <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
                <View style={styles.emptyContainer}>
                    <Ionicons name="book-outline" size={40} color={theme.colors.textSecondary} />
                    <Text style={styles.emptyText}>
                        Выберите урок из списка{'\n'}или спросите AI-тьютора
                    </Text>
                </View>
            </View>
        );
    }

    const siblings = lesson.module?.lessons || [];
    const currentIdx = siblings.findIndex((l) => l.id === lesson.id);
    const prevLesson = currentIdx > 0 ? siblings[currentIdx - 1] : null;
    const nextLesson = currentIdx < siblings.length - 1 ? siblings[currentIdx + 1] : null;

    return (
        <View style={styles.container}>
            {/* Header with close button */}
            <View style={styles.header}>
                <Text style={styles.headerTitle} numberOfLines={1}>
                    {lesson.title}
                </Text>
                <Pressable style={styles.headerButton} onPress={onClose}>
                    <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <ScrollView style={{ flex: 1 }}>
                <View style={styles.content}>
                    {/* Breadcrumb */}
                    {lesson.module?.course && (
                        <Text style={styles.breadcrumb}>
                            {lesson.module.course.title}
                        </Text>
                    )}
                    <Text style={styles.lessonTitle}>{lesson.title}</Text>

                    {/* Video */}
                    {lesson.videoUrl && !hideVideo && <VideoPlayer url={lesson.videoUrl} />}

                    {/* Objectives */}
                    {lesson.objectives && lesson.objectives.length > 0 && (
                        <View style={styles.objectivesContainer}>
                            <Text style={styles.objectivesTitle}>Цели урока</Text>
                            {lesson.objectives.map((obj, i) => (
                                <View key={i} style={styles.objectiveRow}>
                                    <Ionicons name="checkmark-circle-outline" size={14} color={theme.colors.textSecondary} style={{ marginTop: 1 }} />
                                    <Text style={styles.objectiveText}>{obj}</Text>
                                </View>
                            ))}
                        </View>
                    )}

                    {/* Structured content blocks */}
                    <LessonBlocks content={lesson.content} theme={theme} courseColor={courseColor} />

                    {/* Fallback: plain markdown content */}
                    {lesson.content && !extractBlocks(lesson.content) && (
                        <MarkdownView markdown={extractMarkdown(lesson.content)} />
                    )}

                    {/* Complete button */}
                    {isCompleted ? (
                        <View style={styles.completedBadge}>
                            <Ionicons name="checkmark-circle" size={18} color="#4CAF50" />
                            <Text style={styles.completedText}>Пройден</Text>
                        </View>
                    ) : (
                        <Pressable
                            style={[styles.completeButton, { backgroundColor: theme.colors.text }]}
                            onPress={handleComplete}
                            disabled={completing}
                        >
                            {completing ? (
                                <ActivityIndicator color={theme.colors.groupped.background} size="small" />
                            ) : (
                                <>
                                    <Ionicons name="checkmark-circle" size={18} color={theme.colors.groupped.background} />
                                    <Text style={[styles.completeButtonText, { color: theme.colors.groupped.background }]}>Завершить урок</Text>
                                </>
                            )}
                        </Pressable>
                    )}

                    {/* Navigation */}
                    <View style={styles.navRow}>
                        {prevLesson && (
                            <Pressable
                                style={styles.navButton}
                                onPress={() => navigateToLesson(prevLesson.id)}
                            >
                                <Ionicons name="chevron-back" size={14} color={theme.colors.text} />
                                <Text style={styles.navButtonText} numberOfLines={1}>Назад</Text>
                            </Pressable>
                        )}
                        {nextLesson && (
                            <Pressable
                                style={styles.navButton}
                                onPress={() => navigateToLesson(nextLesson.id)}
                            >
                                <Text style={styles.navButtonText} numberOfLines={1}>Далее</Text>
                                <Ionicons name="chevron-forward" size={14} color={theme.colors.text} />
                            </Pressable>
                        )}
                    </View>
                </View>
            </ScrollView>
        </View>
    );
});
