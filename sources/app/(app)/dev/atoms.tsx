import React from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';
import { Text } from '@/components/StyledText';
import { StatusBadge } from '@/components/atoms/StatusBadge';
import { FileIcon } from '@/components/atoms/FileIcon';
import { TerminalBlock } from '@/components/atoms/TerminalBlock';
import { DividerLine } from '@/components/atoms/DividerLine';
import { EmptyState } from '@/components/atoms/EmptyState';
import { ToolHeader } from '@/components/atoms/ToolHeader';
import { InfoBox } from '@/components/atoms/InfoBox';
import { Badge } from '@/components/atoms/Badge';
import { SearchResultBlock } from '@/components/atoms/SearchResultBlock';
import { JsonCopyBlock } from '@/components/atoms/JsonCopyBlock';

export default function AtomsShowcase() {
    return (
        <ScrollView style={styles.container}>
            <View style={styles.content}>
                <Text style={styles.title}>Atomic Components Showcase</Text>

                {/* StatusBadge */}
                <Section title="StatusBadge">
                    <View style={styles.flexRow}>
                        <StatusBadge state="running" />
                        <StatusBadge state="completed" />
                        <StatusBadge state="error" />
                        <StatusBadge state="pending" />
                    </View>
                </Section>

                {/* FileIcon */}
                <Section title="FileIcon">
                    <View style={styles.iconGrid}>
                        <View style={styles.iconItem}>
                            <FileIcon fileName="app.tsx" size={24} />
                            <Text style={styles.iconLabel}>app.tsx</Text>
                        </View>
                        <View style={styles.iconItem}>
                            <FileIcon fileName="styles.css" size={24} />
                            <Text style={styles.iconLabel}>styles.css</Text>
                        </View>
                        <View style={styles.iconItem}>
                            <FileIcon fileName="script.py" size={24} />
                            <Text style={styles.iconLabel}>script.py</Text>
                        </View>
                        <View style={styles.iconItem}>
                            <FileIcon fileName="data.json" size={24} />
                            <Text style={styles.iconLabel}>data.json</Text>
                        </View>
                        <View style={styles.iconItem}>
                            <FileIcon isDirectory size={24} />
                            <Text style={styles.iconLabel}>folder</Text>
                        </View>
                        <View style={styles.iconItem}>
                            <FileIcon fileName="image.png" size={24} />
                            <Text style={styles.iconLabel}>image.png</Text>
                        </View>
                    </View>
                </Section>

                {/* TerminalBlock */}
                <Section title="TerminalBlock">
                    <TerminalBlock
                        command="npm run dev"
                        output={`> happy@1.0.0 dev
> expo start

Starting project at /Users/steve/Develop/slopus/happy
Starting Metro Bundler
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
█ ▄▄▄▄▄ █▀█ █▄█▄█▀█ ▄▄▄▄▄ █
█ █   █ █▀▀▀█ ▀▀█▄█ █   █ █
█ █▄▄▄█ █▀ █▀▀█▄▀█ █▄▄▄█ █
█▄▄▄▄▄▄▄█▄▀ ▀▄█ █▄█▄▄▄▄▄▄▄█
Metro waiting on exp://192.168.1.100:8081`}
                    />
                    <View style={styles.spacingTop}>
                        <TerminalBlock
                            command="git status"
                            error="fatal: not a git repository"
                        />
                    </View>
                </Section>

                {/* DividerLine */}
                <Section title="DividerLine">
                    <DividerLine />
                    <Text style={styles.dividerLabel}>With indent:</Text>
                    <DividerLine indent={40} />
                    <Text style={styles.dividerLabel}>Custom color:</Text>
                    <DividerLine color="border-blue-400" />
                </Section>

                {/* EmptyState */}
                <Section title="EmptyState">
                    <EmptyState
                        icon="search"
                        title="No results found"
                        description="Try adjusting your search criteria or broaden your search terms"
                    />
                </Section>

                {/* ToolHeader */}
                <Section title="ToolHeader">
                    <ToolHeader
                        icon="🔍"
                        title="Search Files"
                        state="completed"
                    />
                </Section>

                {/* InfoBox */}
                <Section title="InfoBox">
                    <InfoBox title="Search Parameters" variant="info">
                        <Text style={styles.infoText}>Pattern: "useState"</Text>
                        <Text style={styles.infoText}>Files: *.tsx</Text>
                    </InfoBox>
                    <View style={styles.spacingTop}>
                        <InfoBox variant="warning">
                            <Text style={styles.infoText}>This operation may take a while</Text>
                        </InfoBox>
                    </View>
                    <View style={styles.spacingTop}>
                        <InfoBox variant="error">
                            <Text style={styles.infoText}>Permission denied</Text>
                        </InfoBox>
                    </View>
                    <View style={styles.spacingTop}>
                        <InfoBox variant="success">
                            <Text style={styles.infoText}>Operation completed successfully</Text>
                        </InfoBox>
                    </View>
                </Section>

                {/* Badge */}
                <Section title="Badge">
                    <View style={styles.badgeGroup}>
                        <Text style={styles.badgeLabel}>Variants:</Text>
                        <View style={styles.flexRow}>
                            <Badge variant="default">DEFAULT</Badge>
                            <Badge variant="primary">PRIMARY</Badge>
                            <Badge variant="secondary">SECONDARY</Badge>
                            <Badge variant="success">SUCCESS</Badge>
                            <Badge variant="warning">WARNING</Badge>
                            <Badge variant="danger">DANGER</Badge>
                            <Badge variant="info">INFO</Badge>
                        </View>
                    </View>
                    <View style={styles.badgeGroupLarge}>
                        <Text style={styles.badgeLabel}>Sizes:</Text>
                        <View style={styles.flexRowCentered}>
                            <Badge size="sm">SMALL</Badge>
                            <Badge size="md">MEDIUM</Badge>
                            <Badge size="lg">LARGE</Badge>
                        </View>
                    </View>
                </Section>

                {/* SearchResultBlock */}
                <Section title="SearchResultBlock">
                    <SearchResultBlock
                        content={`sources/app/index.tsx
   42:  const [count, setCount] = useState(0);
   87:  const [isVisible, setIsVisible] = useState(true);
  
sources/components/Header.tsx
   15:  const [menuOpen, setMenuOpen] = useState(false);
   
sources/hooks/useAuth.ts
   8:   const [user, setUser] = useState(null);
   23:  const [loading, setLoading] = useState(true);`}
                        maxHeight={200}
                    />
                </Section>
                <Section title="JsonCopyBlock">
                    <JsonCopyBlock data={{
                        name: 'John Doe',
                        age: 30,
                        email: 'john.doe@example.com'
                    }} />
                </Section>
            </View>
        </ScrollView>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <View style={styles.section}>
            <Text style={styles.sectionTitle}>{title}</Text>
            {children}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'white',
    },
    content: {
        padding: 16,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 24,
    },
    section: {
        marginBottom: 32,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 12,
        color: '#374151',
    },
    flexRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    flexRowCentered: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    iconGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 16,
    },
    iconItem: {
        alignItems: 'center',
    },
    iconLabel: {
        fontSize: 12,
        marginTop: 4,
    },
    spacingTop: {
        marginTop: 8,
    },
    dividerLabel: {
        fontSize: 14,
        color: 'rgba(0,0,0,0.5)',
        marginVertical: 8,
    },
    infoText: {
        fontSize: 14,
    },
    badgeGroup: {
        marginBottom: 8,
    },
    badgeGroupLarge: {
        marginTop: 16,
    },
    badgeLabel: {
        fontSize: 14,
        color: '#4b5563',
        marginBottom: 4,
    },
});