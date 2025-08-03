import { MarkdownSpan, parseMarkdown } from './parseMarkdown';
import { Link } from 'expo-router';
import * as React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../StyledText';
import { Typography } from '@/constants/Typography';
import { SimpleSyntaxHighlighter } from '../SimpleSyntaxHighlighter';

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
    return <Text selectable style={[style.text, props.first && style.first, props.last && style.last]}><RenderSpans spans={props.spans} baseStyle={style.text} /></Text>;
}

function RenderHeaderBlock(props: { level: 1 | 2 | 3 | 4 | 5 | 6, spans: MarkdownSpan[], first: boolean, last: boolean }) {
    const s = (style as any)[`header${props.level}`];
    const headerStyle = [style.header, s, props.first && style.first, props.last && style.last];
    return <Text selectable style={headerStyle}><RenderSpans spans={props.spans} baseStyle={headerStyle} /></Text>;
}

function RenderListBlock(props: { items: MarkdownSpan[][], first: boolean, last: boolean }) {
    const listStyle = [style.text, style.list];
    return (
        <View className="list-none" style={{ flexDirection: 'column', marginBottom: 8, gap: 1 }}>
            {props.items.map((item, index) => (
                <Text selectable className="list-none" style={listStyle} key={index}>- <RenderSpans spans={item} baseStyle={listStyle} /></Text>
            ))}
        </View>
    );
}

function RenderNumberedListBlock(props: { items: { number: number, spans: MarkdownSpan[] }[], first: boolean, last: boolean }) {
    const listStyle = [style.text, style.list];
    return (
        <View style={{ flexDirection: 'column', marginBottom: 8, gap: 1 }}>
            {props.items.map((item, index) => (
                <Text selectable style={listStyle} key={index}>{item.number.toString()}. <RenderSpans spans={item.spans} baseStyle={listStyle} /></Text>
            ))}
        </View>
    );
}

function RenderCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean }) {
    return (
        <View style={[style.codeBlock, props.first && style.first, props.last && style.last]}>
            {props.language && <Text selectable style={style.codeLanguage}>{props.language}</Text>}
            <ScrollView
                style={{ flexGrow: 0, flexShrink: 0 }}
                horizontal={true}
                contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16 }}
                showsHorizontalScrollIndicator={false}
            >
                <SimpleSyntaxHighlighter 
                    code={props.content} 
                    language={props.language} 
                />
            </ScrollView>
        </View>
    );
}

function RenderSpans(props: { spans: MarkdownSpan[], baseStyle?: any }) {
    return (<>
        {props.spans.map((span, index) => {
            if (span.url) {
                return <Link key={index} href={span.url as any} target="_blank" style={[style.link, { color: '#2BACCC' }, span.styles.map(s => style[s])]}>{span.text}</Link>
            } else {
                return <Text key={index} style={[props.baseStyle, span.styles.map(s => style[s])]}>{span.text}</Text>
            }
        })}
    </>)
}


const style = StyleSheet.create({

    // Plain text

    text: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24, // Reduced from 28 to 24
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
    semibold: {
        fontWeight: '600',
    },
    code: {
        ...Typography.mono(),
        fontSize: 16,
        lineHeight: 21,  // Reduced from 24 to 21
        // backgroundColor: 'rgb(66, 66, 66)',
        // backgroundColor: 'rgb(244, 244, 244)',
        // color: 'rgb(78, 78, 78)',
        color: '#737373',
    },
    link: {
        ...Typography.default(),
        // color: 'rgb(122, 183, 255)',
        color: 'rgb(0, 0, 0)',
        fontWeight: '400',
    },

    // Headers

    header: {
        ...Typography.default('semiBold'),
        // color: 'rgb(236, 236, 236)',
        color: 'rgb(0, 0, 0)',
    },
    header1: {
        fontSize: 16,
        lineHeight: 24,  // Reduced from 36 to 24
        fontWeight: '900',
        marginTop: 16,
        marginBottom: 8
    },
    header2: {
        fontSize: 20,
        lineHeight: 24,  // Reduced from 36 to 32
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8
    },
    header3: {
        fontSize: 16,
        lineHeight: 28,  // Reduced from 32 to 28
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
        lineHeight: 24,  // Reduced from 28 to 24
        fontWeight: '600'
    },
    header6: {
        fontSize: 16,
        lineHeight: 24, // Reduced from 28 to 24
        fontWeight: '600'
    },

    //
    // List
    //

    list: {
        ...Typography.default(),
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
        ...Typography.mono(),
        // color: 'rgb(122, 183, 255)',
        color: 'rgb(0, 0, 0)',
        fontSize: 12,
        marginTop: 8,
        paddingHorizontal: 16,
        marginBottom: 0,
    },
    codeText: {
        ...Typography.mono(),
        // color: 'rgb(236, 236, 236)',
        color: 'rgb(0, 0, 0)',
        fontSize: 14,
        lineHeight: 20,
    },
});