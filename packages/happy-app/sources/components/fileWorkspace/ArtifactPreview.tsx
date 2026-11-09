import * as React from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import type { ArtifactReadResult } from '@slopus/happy-wire';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { parseReadOnlyMarkdown } from '@/components/markdown/parseMarkdown';
import { resolvePreviewPath } from './previewResources';
import { HtmlFilePreview } from './HtmlFilePreview';
import type { VersionController } from './versionController';
import { documentBodyStyle, documentScrollStyle } from './documentPresentation';
/** Both entry and resources come from the same immutable read; no working-file fallback. */
export function ArtifactPreview({sessionId,versions,value,onReady}:{sessionId:string;versions:VersionController;value:ArtifactReadResult;onReady?:(ready:boolean)=>void}) {
 const reader=React.useMemo(()=>versions.reader(value),[versions,value]);
 const [images,setImages]=React.useState<Record<string,string|null>|null>(null);
 const path=versions.root+'/'+value.manifest.entryPath;
 React.useEffect(()=>{
  let cancelled=false;const blobs:string[]=[];setImages(null);onReady?.(false);
  if(value.artifact.kind!=='markdown')return;
  const urls=[...new Set(parseReadOnlyMarkdown(value.entryContent, {allowImages:true}).filter(b=>b.type==='image').map(b=>(b as {url:string}).url))];
  void Promise.all(urls.map(async url=>{
   if(/^data:image\/(png|jpeg|gif|webp);base64,/i.test(url))return [url,url] as const;
   try {
    const resolved=resolvePreviewPath(url,path,versions.root);
    const bytes=await reader(resolved.path);const mime=value.manifest.files.find(f=>versions.root+'/'+f.path===resolved.path)?.mime;
    if(!mime?.startsWith('image/'))throw new Error('NOT_IMAGE');
    const object=URL.createObjectURL(new Blob([bytes as BlobPart],{type:mime}));blobs.push(object);return [url,object] as const;
   }catch{return [url,null] as const;}
  })).then(entries=>{if(cancelled)blobs.forEach(u=>URL.revokeObjectURL(u));else {setImages(Object.fromEntries(entries));onReady?.(entries.every(([,value])=>value!==null));}});
  return()=>{cancelled=true;blobs.forEach(u=>URL.revokeObjectURL(u));};
 },[value,path,reader,versions.root,onReady]);
 if(value.artifact.kind==='html')return <HtmlFilePreview sessionId={sessionId} path={path} root={versions.root} content={value.entryContent} readBytes={reader} onReady={onReady}/>;
 if(!images)return <ActivityIndicator/>;
 return <ScrollView style={{flex:1}} contentContainerStyle={documentScrollStyle}><View testID="workspace-document-body" style={documentBodyStyle}><MarkdownView markdown={value.entryContent} typography="document" readOnly sessionId={sessionId} imageUrls={images}/></View></ScrollView>;
}
