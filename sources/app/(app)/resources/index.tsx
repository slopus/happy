import React from 'react';
import { View, ScrollView, Text, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { listCommands, listSkills, listMCPServers, type Command, type Skill, type MCPServer } from '@/sync/apiResources';

export default function ResourcesScreen() {
  const params = useLocalSearchParams<{ machineId?: string }>();
  const machineId = params.machineId || '';

  const [commands, setCommands] = React.useState<Command[]>([]);
  const [skills, setSkills] = React.useState<Skill[]>([]);
  const [mcpServers, setMCPServers] = React.useState<MCPServer[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!machineId) return;

    const loadResources = async () => {
      setLoading(true);
      try {
        const [cmds, skls, mcps] = await Promise.all([
          listCommands(machineId),
          listSkills(machineId),
          listMCPServers(machineId)
        ]);
        setCommands(cmds);
        setSkills(skls);
        setMCPServers(mcps);
      } catch (error) {
        console.error('Failed to load resources:', error);
      } finally {
        setLoading(false);
      }
    };

    loadResources();
  }, [machineId]);

  if (!machineId) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
        <Text style={{ fontSize: 16, color: '#666' }}>No machine selected</Text>
        <Text style={{ fontSize: 14, color: '#999', marginTop: 8 }}>
          Select a machine to browse its resources
        </Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Host Resources' }} />
      <ScrollView style={{ flex: 1, backgroundColor: '#f9fafb' }}>
        {loading ? (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <ActivityIndicator size="large" />
            <Text style={{ marginTop: 16, color: '#666' }}>Loading resources...</Text>
          </View>
        ) : (
          <>
            {/* Commands Section */}
            <View style={{ padding: 16 }}>
              <Text style={{ fontSize: 20, fontWeight: '600', marginBottom: 12 }}>
                CLI Commands ({commands.length})
              </Text>
              {commands.map((cmd, idx) => (
                <Pressable
                  key={idx}
                  style={({ pressed }) => ({
                    backgroundColor: pressed ? '#e5e7eb' : '#fff',
                    padding: 12,
                    borderRadius: 8,
                    marginBottom: 8,
                    borderWidth: 1,
                    borderColor: '#e5e7eb'
                  })}
                >
                  <Text style={{ fontSize: 16, fontWeight: '500' }}>{cmd.name}</Text>
                  <Text style={{ fontSize: 14, color: '#666', marginTop: 4 }}>
                    {cmd.description}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Skills Section */}
            <View style={{ padding: 16 }}>
              <Text style={{ fontSize: 20, fontWeight: '600', marginBottom: 12 }}>
                Claude Skills ({skills.length})
              </Text>
              {skills.map((skill, idx) => (
                <Pressable
                  key={idx}
                  style={({ pressed }) => ({
                    backgroundColor: pressed ? '#dbeafe' : '#fff',
                    padding: 12,
                    borderRadius: 8,
                    marginBottom: 8,
                    borderWidth: 1,
                    borderColor: '#3b82f6'
                  })}
                >
                  <Text style={{ fontSize: 16, fontWeight: '500', color: '#1e40af' }}>
                    {skill.name}
                  </Text>
                  <Text style={{ fontSize: 14, color: '#666', marginTop: 4 }}>
                    {skill.description}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* MCP Servers Section */}
            <View style={{ padding: 16 }}>
              <Text style={{ fontSize: 20, fontWeight: '600', marginBottom: 12 }}>
                MCP Servers ({mcpServers.length})
              </Text>
              {mcpServers.map((server, idx) => (
                <View
                  key={idx}
                  style={{
                    backgroundColor: '#fff',
                    padding: 12,
                    borderRadius: 8,
                    marginBottom: 8,
                    borderWidth: 1,
                    borderColor: '#e5e7eb'
                  }}
                >
                  <Text style={{ fontSize: 16, fontWeight: '500', color: '#7c3aed' }}>
                    {server.name}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                    {server.status}
                  </Text>
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </>
  );
}
