/**
 * Fullscreen, zoomable Mermaid diagram viewer (native: iOS / Android).
 *
 * Opened via `Modal.show({ component: MermaidViewer, props: { content } })` from
 * the expand button on an inline diagram. Re-renders the diagram in a fullscreen
 * WebView and zooms by CSS-transforming the SVG *inside* the WebView — the SVG
 * is vector, so it stays crisp, unlike scaling the WebView itself from RN (which
 * upscales a raster snapshot and blurs). Pinch / pan / double-tap are handled by
 * injected JS, so there's no `svg-pan-zoom` dependency.
 *
 * Web has a separate implementation in `MermaidViewer.web.tsx`.
 */
import * as React from 'react';
import { View, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface MermaidViewerProps {
    content: string;
    onClose: () => void;
}

export function MermaidViewer({ content, onClose }: MermaidViewerProps) {
    const { width, height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const mermaidContent = JSON.stringify(content);

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden;}
  #wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;touch-action:none;}
  #stage{transform-origin:center center;will-change:transform;}
  #stage svg{max-width:100vw;max-height:100vh;height:auto;}
  .error{color:#ff6b6b;font-family:monospace;white-space:pre-wrap;padding:16px;}
</style>
</head>
<body>
<div id="wrap"><div id="stage"></div></div>
<script>
(async function(){
  var stage=document.getElementById('stage'), wrap=document.getElementById('wrap');
  try{
    mermaid.initialize({startOnLoad:false,theme:'dark'});
    var r=await mermaid.render('m',${mermaidContent});
    stage.innerHTML=r.svg;
  }catch(e){ stage.innerHTML='<div class="error">'+String((e&&e.message)||e).replace(/</g,'&lt;')+'</div>'; }

  var scale=1,tx=0,ty=0,sx=0,sy=0,sd=0,ss=1,pan=false,last=0;
  function apply(){ stage.style.transform='translate('+tx+'px,'+ty+'px) scale('+scale+')'; }
  function dist(t){ return Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY); }
  wrap.addEventListener('touchstart',function(e){
    if(e.touches.length===2){ sd=dist(e.touches); ss=scale; pan=false; }
    else if(e.touches.length===1){
      var now=Date.now();
      if(now-last<300){ if(scale>1){scale=1;tx=0;ty=0;}else{scale=2.5;} apply(); pan=false; }
      else { pan=true; sx=e.touches[0].clientX-tx; sy=e.touches[0].clientY-ty; }
      last=now;
    }
  },{passive:false});
  wrap.addEventListener('touchmove',function(e){
    e.preventDefault();
    if(e.touches.length===2){ scale=Math.min(8,Math.max(1, ss*dist(e.touches)/sd)); apply(); }
    else if(e.touches.length===1 && pan){ tx=e.touches[0].clientX-sx; ty=e.touches[0].clientY-sy; apply(); }
  },{passive:false});
  wrap.addEventListener('touchend',function(e){ if(e.touches.length===0){ pan=false; if(scale<=1){tx=0;ty=0;apply();} } });
})();
</script>
</body>
</html>`;

    return (
        <View style={[styles.root, { width, height }]}>
            <WebView
                source={{ html }}
                style={styles.webview}
                scrollEnabled={false}
                originWhitelist={['*']}
            />
            <Pressable
                onPress={onClose}
                hitSlop={16}
                style={[styles.close, { top: Math.max(insets.top, 12) + 4 }]}
                accessibilityRole="button"
                accessibilityLabel="Close diagram"
            >
                <Ionicons name="close" size={26} color="#fff" />
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { backgroundColor: '#000' },
    webview: { flex: 1, backgroundColor: '#000' },
    close: {
        position: 'absolute',
        right: 12,
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
});
