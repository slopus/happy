import * as React from 'react';
import { View, ScrollView, TextInput, ActivityIndicator } from 'react-native';
import { Text } from '@/components/StyledText';
import { useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useFileWorkspace } from './context';
import { WorkspaceButton as Button } from './WorkspaceButton';
import { ArtifactPreview } from './ArtifactPreview';
import { documentDirty } from './controller';
export function VersionHistoryPanel({path,sessionId,onClose}:{path:string;sessionId:string;onClose:()=>void}) {
 const w=useFileWorkspace()!;const {theme}=useUnistyles();const {versions}=w;const s=versions.state(path);
 const [previewReady,setPreviewReady]=React.useState(false);
 React.useEffect(()=>setPreviewReady(false),[s.selectedId]);
 const [paths,setPaths]=React.useState(path.slice(w.root.length+1));
 const panel=React.useRef<any>(null);
 React.useEffect(()=>{void versions.load(path);panel.current?.focus?.();},[versions,path]);
 const doc=w.snapshot.documents[path];const dirty=doc && documentDirty(doc);
 const message = s.pending?.request && s.pending.canRetry ? t('fileWorkspace.operationNotFound') : s.pending?.kind==='register' && s.pending.canRetry ? t('fileWorkspace.registrationNotFound') : s.pending ? t('fileWorkspace.historyPending') : s.error === 'CONFLICT' ? t('fileWorkspace.historyConflict') : s.error === 'WRITER_ACTIVE' || s.current?.workingState==='writing' ? t('fileWorkspace.historyWriting') : s.error === 'INCOMPLETE_VERSION' ? t('fileWorkspace.historyIncomplete') : s.error === 'UNAVAILABLE' ? t('fileWorkspace.historyUnavailable') : s.error ? t('fileWorkspace.historyFailed') : null;
 const restore=async()=>{
  if(!previewReady || !versions.canRestore(path) || dirty || doc?.saving)return;
  const selection=versions.prepareRestore(path);if(!selection)return;
  if(!await Modal.confirm(t('fileWorkspace.restoreVersion'),t('fileWorkspace.restoreConfirm')))return;
  await w.restoreVersion(path,undefined,selection);
 };
 return <View ref={panel} testID="workspace-history-panel" {...({tabIndex:-1,role:'dialog','aria-modal':true,'aria-label':t('fileWorkspace.history'),onKeyDown:(e:any)=>{if(e.key==='Tab'){const nodes=Array.from(panel.current?.querySelectorAll?.('button:not([disabled]),[role=button]:not([aria-disabled=true]),input,textarea') ?? []) as HTMLElement[];const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey && globalThis.document?.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey && globalThis.document?.activeElement===last){e.preventDefault();first?.focus();}}if(e.key==='Escape'){e.stopPropagation();onClose();}}} as any)} style={{position:'absolute',top:w.maximized?52:0,bottom:0,left:0,right:0,backgroundColor:theme.colors.surface,zIndex:2}}>
  <View style={{flexDirection:'row',alignItems:'center',padding:10,gap:6,borderBottomWidth:1,borderColor:theme.colors.divider}}>
   <Text style={{flex:1,fontSize:14,color:theme.colors.text}}>{t('fileWorkspace.history')}</Text>
   <Button label={t('fileWorkspace.refresh')} icon="refresh-outline" disabled={s.busy || s.loading} onPress={()=>{void versions.load(path);}}/>
   <Button label={t('fileWorkspace.closeHistory')} icon="close-outline" testID="workspace-history-close" compact onPress={onClose}/>
  </View>
  {message && <View style={{padding:10,gap:6,backgroundColor:theme.colors.surfaceSelected}}><Text accessibilityRole="alert" style={{fontSize:12,color:theme.colors.textDestructive}}>{message}</Text>
   {s.pending && <><Text selectable style={{fontSize:11,color:theme.colors.textSecondary}}>{t('fileWorkspace.operationId')}: {s.pending.operationId}</Text><Button label={t('fileWorkspace.inspectOperation')} disabled={s.busy} onPress={()=>{void w.restoreVersion(path,'inspect');}}/>
    {s.pending.kind==='register' && s.pending.canRetry && <Button label={t('fileWorkspace.retryRegistration')} disabled={s.busy} testID="workspace-history-retry-register" onPress={()=>{void Modal.confirm(t('fileWorkspace.retryRegistration'),t('fileWorkspace.registrationRetryConfirm')).then(ok=>{if(ok)void versions.retryRegistration(path).then(done=>{if(done)void w.controller.refresh(path);});});}}/>}
    {s.pending.request && s.pending.canRetry && <Button label={t('fileWorkspace.retryOperation')} disabled={s.busy} testID="workspace-history-retry-operation" onPress={()=>{void Modal.confirm(t('fileWorkspace.retryOperation'),t('fileWorkspace.operationRetryConfirm')).then(ok=>{if(ok)void w.restoreVersion(path,'retry');});}}/>}
    {s.operation?.actions.map(action=><Button key={action} label={t(action==='resume'?'fileWorkspace.resumeOperation':'fileWorkspace.rollbackOperation')} disabled={s.busy} onPress={()=>{void Modal.confirm(t(action==='resume'?'fileWorkspace.resumeOperation':'fileWorkspace.rollbackOperation'),t('fileWorkspace.resolveConfirm')).then(ok=>{if(ok)void w.restoreVersion(path,action);});}}/>)}</>}
  </View>}
  {s.current?.workingState==='dirty' && <Text style={{padding:10,fontSize:12,color:theme.colors.textSecondary}}>{t('fileWorkspace.historyWorkingChanges')}</Text>}
  {!s.artifact ? <ScrollView contentContainerStyle={{padding:20,gap:14}}>
   <Text style={{color:theme.colors.text}}>{t('fileWorkspace.enableHistory')}</Text>
   <Text style={{fontSize:13,color:theme.colors.textSecondary}}>{t('fileWorkspace.registrationHint')}</Text>
   <TextInput testID="workspace-history-paths" accessibilityLabel={t('fileWorkspace.registrationPaths')} multiline value={s.pending?.kind==='register' && s.pending.managedPaths ? s.pending.managedPaths.join('\n') : paths} onChangeText={setPaths} editable={!s.busy && !s.pending} style={{minHeight:130,borderWidth:1,borderColor:theme.colors.divider,color:theme.colors.text,backgroundColor:theme.colors.surface,padding:12,borderRadius:8}}/>
   <Button label={t('fileWorkspace.confirmRegistration')} testID="workspace-history-register" disabled={s.loading || s.busy || !!s.pending || !!dirty || !!doc?.saving} onPress={()=>{void versions.register(path,[...new Set(paths.split('\n').map(p=>p.trim()).filter(Boolean))]).then(ok=>{if(ok)void w.controller.refresh(path);});}}/>
   {dirty && <Text style={{fontSize:12,color:theme.colors.textSecondary}}>{t('fileWorkspace.draftKept')}</Text>}
  </ScrollView> : <View style={{flex:1,minHeight:0,flexDirection:'row'}}>
   <View style={{flex:1,minWidth:0}}>
    <Text style={{padding:10,fontSize:12,color:theme.colors.textSecondary}}>{t('fileWorkspace.historicalPreview')}</Text>
    {s.selecting ? <ActivityIndicator style={{padding:24}}/> : s.preview ? <ArtifactPreview key={s.selectedId} sessionId={sessionId} versions={versions} value={s.preview} onReady={setPreviewReady}/> : <Text style={{padding:20,color:theme.colors.textSecondary}}>{t('fileWorkspace.chooseVersion')}</Text>}
    <View style={{padding:10,borderTopWidth:1,borderColor:theme.colors.divider,gap:6}}>
     {dirty && <Text style={{fontSize:12,color:theme.colors.textSecondary}}>{t('fileWorkspace.draftKept')}</Text>}
     <Button label={s.busy?t('common.loading'):t('fileWorkspace.restoreVersion')} testID="workspace-history-restore" disabled={!previewReady || !versions.canRestore(path) || !!dirty || !!doc?.saving} icon="refresh-outline" onPress={()=>{void restore();}}/>
    </View>
   </View>
   <ScrollView testID="workspace-history-timeline" style={{width:210,flexGrow:0,borderLeftWidth:1,borderColor:theme.colors.divider}} contentContainerStyle={{padding:8,gap:6}}>
    {s.loading && <ActivityIndicator/>}
    {!s.loading && !s.versions.length && <Text style={{color:theme.colors.textSecondary}}>{t('fileWorkspace.noVersions')}</Text>}
    {s.versions.map(v=><View key={v.id} testID={'workspace-version-'+v.sequence} style={{padding:9,gap:5,borderRadius:8,borderLeftWidth:2,borderColor:theme.colors.divider,backgroundColor:s.selectedId===v.id?theme.colors.surfaceSelected:theme.colors.surface}}>
     <Button label={'V'+v.sequence+(s.current?.artifact.currentVersionId===v.id?' · '+t('fileWorkspace.currentVersion'):'')} selected={s.selectedId===v.id} disabled={s.busy || !!s.pending} onPress={()=>{void versions.select(path,v.id);}}/>
     <Text style={{fontSize:11,color:theme.colors.textSecondary}}>{new Date(v.createdAt).toLocaleString()}</Text>
     <Text style={{fontSize:11,color:theme.colors.textSecondary}}>{t(({baseline:'fileWorkspace.sourceBaseline',ai:'fileWorkspace.sourceAi',manual:'fileWorkspace.sourceManual',external:'fileWorkspace.sourceExternal',restore:'fileWorkspace.sourceRestore'} as const)[v.source])}</Text>
     <Text selectable style={{fontSize:12,color:theme.colors.text}}>{v.prompt || v.summary}</Text>
    </View>)}
    {s.cursor && <Button label={t('fileWorkspace.moreVersions')} disabled={s.loading} onPress={()=>{void versions.load(path,true);}}/>}
    <Text style={{paddingTop:8,fontSize:11,color:theme.colors.textSecondary}}>{t('fileWorkspace.managedFiles')}</Text>
    {s.artifact.managedPaths.map(p=><Text selectable key={p} style={{fontSize:11,color:theme.colors.textSecondary}}>{p}</Text>)}
   </ScrollView>
  </View>}
 </View>;
}
