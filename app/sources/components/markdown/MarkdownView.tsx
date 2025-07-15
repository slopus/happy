import { MarkdownSpan, parseMarkdown } from './parseMarkdown';
import { Link } from 'expo-router';
import * as React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

export const MarkdownView = React.memo((props: { markdown: string }) => {
    const blocks = React.useMemo(() => parseMarkdown(props.markdown), [props.markdown]);
    return (
        <View className="list-none">
            {blocks.map((block, index) => {
                if (block.type === 'text') {
                    return <RenderTextBlock spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} />;
                } else if (block.type === 'header') {
                    return <RenderHeaderBlock level={block.level} spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} />;
                } else if (block.type === 'horizontal-rule') {
                    return <View style={{ height: 1, backgroundColor: 'rgb(236, 236, 236)', marginTop: 8, marginBottom: 8 }} key={index} />;
                } else if (block.type === 'list') {
                    return <RenderListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} />;
                } else if (block.type === 'numbered-list') {
                    return <RenderNumberedListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} />;
                } else if (block.type === 'code-block') {
                    return <RenderCodeBlock content={block.content} language={block.language} key={index} first={index === 0} last={index === blocks.length - 1} />;
                } else {
                    return null;
                }
            })}
        </View>
    );
});

function RenderTextBlock(props: { spans: MarkdownSpan[], first: boolean, last: boolean }) {
    return <Text style={[style.text, props.first && style.first, props.last && style.last]}><RenderSpans spans={props.spans} /></Text>;
}

function RenderHeaderBlock(props: { level: 1 | 2 | 3 | 4 | 5 | 6, spans: MarkdownSpan[], first: boolean, last: boolean }) {
    const s = (style as any)[`header${props.level}`];
    return <Text style={[style.header, s, props.first && style.first, props.last && style.last]}><RenderSpans spans={props.spans} /></Text>;
}

function RenderListBlock(props: { items: MarkdownSpan[][], first: boolean, last: boolean }) {
    return (
        <View className="list-none" style={{ flexDirection: 'column', marginBottom: 8, gap: 1 }}>
            {props.items.map((item, index) => (
                <Text className="list-none" style={[style.text, style.list]} key={index}>• <RenderSpans spans={item} /></Text>
            ))}
        </View>
    );
}

function RenderNumberedListBlock(props: { items: { number: number, spans: MarkdownSpan[] }[], first: boolean, last: boolean }) {
    return (
        <View style={{ flexDirection: 'column', marginBottom: 8, gap: 1 }}>
            {props.items.map((item, index) => (
                <Text style={[style.text, style.list]} key={index}>{item.number.toString()}. <RenderSpans spans={item.spans} /></Text>
            ))}
        </View>
    );
}

function RenderCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean }) {
    return (
        <View style={[style.codeBlock, props.first && style.first, props.last && style.last]}>
            {props.language && <Text style={style.codeLanguage}>{props.language}</Text>}
            <ScrollView
                style={{ flexGrow: 0, flexShrink: 0 }}
                horizontal={true}
                contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16 }}
                showsHorizontalScrollIndicator={false}
            >
                <Text style={style.codeText}>{props.content}</Text>
            </ScrollView>
        </View>
    );
}

function RenderSpans(props: { spans: MarkdownSpan[] }) {
    return (<>
        {props.spans.map((span, index) => {
            if (span.url) {
                return <Link key={index} href={span.url as any} target="_blank" style={[style.link, span.styles.map(s => style[s])]}>{span.text}</Link>
            } else {
                return <Text key={index} style={span.styles.map(s => style[s])}>{span.text}</Text>
            }
        })}
    </>)
}


const style = StyleSheet.create({

    // Plain text

    text: {
        fontSize: 16,
        lineHeight: 28,
        marginTop: 8,
        marginBottom: 8,
        // color: 'rgb(236, 236, 236)',
        color: 'rgb(0, 0, 0)',
        fontWeight: '400',
    },

    italic: {
        fontStyle: 'italic',
    },
    bold: {
        fontWeight: 'bold',
    },
    code: {
        fontSize: 14,
        lineHeight: 24,
        fontFamily: 'monospace',
        // backgroundColor: 'rgb(66, 66, 66)',
        backgroundColor: 'rgb(236, 236, 236)',
        paddingHorizontal: 4,
        paddingVertical: 2,
        borderRadius: 4,
    },
    link: {
        // color: 'rgb(122, 183, 255)',
        color: 'rgb(0, 0, 0)',
        fontWeight: '400',
    },

    // Headers

    header: {
        // color: 'rgb(236, 236, 236)',
        color: 'rgb(0, 0, 0)',
    },
    header1: {
        fontSize: 24,
        lineHeight: 36,
        fontWeight: '700',
        marginTop: 16,
        marginBottom: 8
    },
    header2: {
        fontSize: 24,
        lineHeight: 36,
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8
    },
    header3: {
        fontSize: 20,
        lineHeight: 32,
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8,
    },
    header4: {
        fontSize: 16,
        lineHeight: 24,
        fontWeight: '600',
        marginTop: 8,
        marginBottom: 8,
    },
    header5: {
        fontSize: 16,
        lineHeight: 28,
        fontWeight: '600'
    },
    header6: {
        fontSize: 16,
        lineHeight: 28,
        fontWeight: '600'
    },

    //
    // List
    //

    list: {
        // color: 'rgb(236, 236, 236)',
        color: 'rgb(0, 0, 0)',
        marginTop: 0,
        marginBottom: 0,
    },

    //
    // Common
    //

    first: {
        // marginTop: 0
    },
    last: {
        // marginBottom: 0
    },

    //
    // Code Block
    //

    codeBlock: {
        // backgroundColor: 'rgb(66, 66, 66)',
        backgroundColor: 'rgb(236, 236, 236)',
        borderRadius: 8,
        marginVertical: 8,
    },
    codeLanguage: {
        // color: 'rgb(122, 183, 255)',
        color: 'rgb(0, 0, 0)',
        fontSize: 12,
        fontFamily: 'SpaceMono',
        marginTop: 8,
        paddingHorizontal: 16,
        marginBottom: 0,
    },
    codeText: {
        // color: 'rgb(236, 236, 236)',
        color: 'rgb(0, 0, 0)',
        fontSize: 14,
        lineHeight: 20,
        fontFamily: 'SpaceMono',
    },
});