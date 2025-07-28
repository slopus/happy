import React from 'react';
import { ScrollView, View } from 'react-native';
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
        <ScrollView className="flex-1 bg-white">
            <View className="p-4">
                <Text className="text-2xl font-bold mb-6">Atomic Components Showcase</Text>

                {/* StatusBadge */}
                <Section title="StatusBadge">
                    <View className="flex-row flex-wrap gap-2">
                        <StatusBadge state="running" />
                        <StatusBadge state="completed" />
                        <StatusBadge state="error" />
                        <StatusBadge state="pending" />
                    </View>
                </Section>

                {/* FileIcon */}
                <Section title="FileIcon">
                    <View className="flex-row flex-wrap gap-4">
                        <View className="items-center">
                            <FileIcon fileName="app.tsx" size={24} />
                            <Text className="text-xs mt-1">app.tsx</Text>
                        </View>
                        <View className="items-center">
                            <FileIcon fileName="styles.css" size={24} />
                            <Text className="text-xs mt-1">styles.css</Text>
                        </View>
                        <View className="items-center">
                            <FileIcon fileName="script.py" size={24} />
                            <Text className="text-xs mt-1">script.py</Text>
                        </View>
                        <View className="items-center">
                            <FileIcon fileName="data.json" size={24} />
                            <Text className="text-xs mt-1">data.json</Text>
                        </View>
                        <View className="items-center">
                            <FileIcon isDirectory size={24} />
                            <Text className="text-xs mt-1">folder</Text>
                        </View>
                        <View className="items-center">
                            <FileIcon fileName="image.png" size={24} />
                            <Text className="text-xs mt-1">image.png</Text>
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
                    <View className="mt-2">
                        <TerminalBlock
                            command="git status"
                            error="fatal: not a git repository"
                        />
                    </View>
                </Section>

                {/* DividerLine */}
                <Section title="DividerLine">
                    <DividerLine />
                    <Text className="text-sm text-gray-500 my-2">With indent:</Text>
                    <DividerLine indent={40} />
                    <Text className="text-sm text-gray-500 my-2">Custom color:</Text>
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
                        <Text className="text-sm">Pattern: "useState"</Text>
                        <Text className="text-sm">Files: *.tsx</Text>
                    </InfoBox>
                    <View className="mt-2">
                        <InfoBox variant="warning">
                            <Text className="text-sm">This operation may take a while</Text>
                        </InfoBox>
                    </View>
                    <View className="mt-2">
                        <InfoBox variant="error">
                            <Text className="text-sm">Permission denied</Text>
                        </InfoBox>
                    </View>
                    <View className="mt-2">
                        <InfoBox variant="success">
                            <Text className="text-sm">Operation completed successfully</Text>
                        </InfoBox>
                    </View>
                </Section>

                {/* Badge */}
                <Section title="Badge">
                    <View className="mb-2">
                        <Text className="text-sm text-gray-600 mb-1">Variants:</Text>
                        <View className="flex-row flex-wrap gap-2">
                            <Badge variant="default">DEFAULT</Badge>
                            <Badge variant="primary">PRIMARY</Badge>
                            <Badge variant="secondary">SECONDARY</Badge>
                            <Badge variant="success">SUCCESS</Badge>
                            <Badge variant="warning">WARNING</Badge>
                            <Badge variant="danger">DANGER</Badge>
                            <Badge variant="info">INFO</Badge>
                        </View>
                    </View>
                    <View className="mt-4">
                        <Text className="text-sm text-gray-600 mb-1">Sizes:</Text>
                        <View className="flex-row items-center gap-2">
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
        <View className="mb-8">
            <Text className="text-lg font-semibold mb-3 text-gray-800">{title}</Text>
            {children}
        </View>
    );
}