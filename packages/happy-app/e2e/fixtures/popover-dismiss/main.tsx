import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { View, Pressable, Text } from 'react-native';
import { SessionInfoDropdown } from '@/components/SessionInfoDropdown';
function App() {
    const [open, setOpen] = React.useState(false);
    const [focusClicks, setClicks] = React.useState(0);
    return <div style={{display:'flex',height:'100vh',background:'#23262b',color:'#fff'}}>
        <aside style={{width:220,padding:24}}><button id="outside-sidebar" onClick={()=>setClicks(v=>v+1)}>侧栏空白区域</button><p id="clicks">{focusClicks}</p></aside>
        <View style={{flex:1,position:'relative'}}>
            <View style={{height:64,zIndex:1000,alignItems:'flex-end',justifyContent:'center'}}>
                <Pressable testID="session-header-more-button" onPress={()=>setOpen(v=>!v)}><Text style={{color:'white',padding:18}}>更多 ···</Text></Pressable>
            </View>
            <div id="chat-blank" style={{padding:32,flex:1}}>真实 SessionInfoDropdown / RN Web 隔离验收 <input id="outside-input" placeholder="外部输入框" /></div>
            {open && <SessionInfoDropdown session={{id:'fixture',metadata:{flavor:'codex',host:'test-machine',path:'/workspace',homeDir:'/'}} as any} machineName="Test machine" online top={64} onClose={()=>setOpen(false)} onViewDetails={()=>setOpen(false)} />}
        </View>
    </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
