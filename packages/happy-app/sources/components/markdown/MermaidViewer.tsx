/**
 * Fullscreen, zoomable Mermaid diagram viewer (native: iOS / Android).
 *
 * Opened via `Modal.show({ component: MermaidViewer, props: { content } })` from
 * the expand button on an inline diagram. Re-renders the diagram in a fullscreen
 * WebView and zooms the SVG *inside* the WebView. Pinch / pan / double-tap are
 * handled by injected JS, so there's no `svg-pan-zoom` dependency.
 *
 * Zooming is two-phase, and that is the whole point of this file. A CSS
 * `transform: scale()` does not re-render an SVG — Chromium rasterizes the layer
 * once and the compositor stretches that bitmap, and `will-change: transform`
 * pins the raster scale so it never catches up. Measured in Chrome at
 * devicePixelRatio 3 by capturing compositor frames (an ordinary screenshot
 * re-rasterizes on capture and hides the problem entirely): at 8x zoom a glyph
 * edge spanned 12.1 px with `will-change` present versus 2.0 px once the SVG is
 * genuinely re-rendered. The blur grew in proportion to the zoom factor, which
 * is the signature of a 1x bitmap being upscaled.
 *
 * So: while fingers are down we keep the cheap composited transform (smooth),
 * and the moment they lift we *commit* — the SVG's own width/height are set to
 * the zoomed size, the transform scale returns to 1, and `will-change` is
 * released. At rest the diagram is then laid out at its true size and painted at
 * the device's full pixel density at any zoom level, instead of depending on
 * Chromium deciding to re-rasterize a scaled layer.
 *
 * Web has a separate implementation in `MermaidViewer.web.tsx`; it never sets
 * `will-change`, and was measured crisp under the same test.
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
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.12.2/dist/mermaid.min.js"></script>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden;}
  #wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;touch-action:none;}
  /* No resting will-change: it would pin the layer's raster scale and every
     zoom level would then be an upscaled 1x bitmap. It is switched on only for
     the duration of a gesture (see beginGesture/commit below). */
  #stage{transform-origin:center center;}
  /* display:block removes the inline-baseline strut under the svg. Left inline,
     that few-px gap belongs to the stage box and scales with the gesture, so the
     diagram jumped vertically the moment the zoom was committed. */
  #stage svg{display:block;max-width:100vw;max-height:100vh;height:auto;}
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
  // committed = the zoom factor already baked into the SVG's own width/height.
  // The CSS transform only ever carries the part not yet baked in.
  var committed=1, base=null, baseStyle='', commitTimer=null;

  function svgEl(){ return stage.querySelector('svg'); }

  function measureBase(){
    var s=svgEl(); if(!s) return;
    var r=s.getBoundingClientRect();
    // The fitted 1x size, measured with mermaid's own inline max-width and the
    // stylesheet's 100vw/100vh still in force. Every zoom level multiplies this.
    if(r.width>0&&r.height>0){ base={w:r.width,h:r.height}; }
  }

  function apply(){
    stage.style.transform='translate('+tx+'px,'+ty+'px) scale('+(scale/committed)+')';
  }

  function beginGesture(){
    if(commitTimer){ clearTimeout(commitTimer); commitTimer=null; }
    // Retake the reference while the transform is still identity: getBoundingClientRect
    // reports the *transformed* box, so this is the only safe moment, and it closes the
    // window where a pinch within the first 200ms would bake a multiple of a
    // pre-font-settle size.
    if(committed===1&&scale===1){ measureBase(); }
    // Promote for the duration of the gesture so per-frame scaling stays cheap.
    stage.style.willChange='transform';
  }

  function commit(){
    commitTimer=null;
    var s=svgEl();
    if(!s||!base) return;
    committed=scale;
    if(committed===1){
      // Back to the fitted state: restore mermaid's original inline style rather
      // than clearing it, or the svg's width="100%" would stretch a small
      // diagram to the full viewport.
      s.setAttribute('style', baseStyle);
    } else {
      // Inline wins over both the stylesheet rule and mermaid's own max-width.
      s.style.maxWidth='none';
      s.style.maxHeight='none';
      s.style.width=(base.w*committed)+'px';
      s.style.height=(base.h*committed)+'px';
    }
    // The stage is centred in the wrapper, so growing its box is geometrically
    // identical to scaling about its centre — the pan offset carries over as is.
    stage.style.transform='translate('+tx+'px,'+ty+'px) scale(1)';
    // Releasing the hint is what lets the compositor rasterize at the new size.
    stage.style.willChange='auto';
  }

  function endGesture(){
    if(commitTimer) clearTimeout(commitTimer);
    commitTimer=setTimeout(commit,90);
  }

  function dist(t){ return Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY); }

  wrap.addEventListener('touchstart',function(e){
    beginGesture();
    if(e.touches.length===2){ sd=dist(e.touches); ss=scale; pan=false; }
    else if(e.touches.length===1){
      var now=Date.now();
      if(now-last<300){ if(scale>1){scale=1;tx=0;ty=0;}else{scale=2.5;} apply(); pan=false; endGesture(); }
      else { pan=true; sx=e.touches[0].clientX-tx; sy=e.touches[0].clientY-ty; }
      last=now;
    }
  },{passive:false});
  wrap.addEventListener('touchmove',function(e){
    e.preventDefault();
    if(e.touches.length===2){ scale=Math.min(8,Math.max(1, ss*dist(e.touches)/sd)); apply(); }
    else if(e.touches.length===1 && pan){ tx=e.touches[0].clientX-sx; ty=e.touches[0].clientY-sy; apply(); }
  },{passive:false});
  function settle(e){
    // touchcancel (notification shade, incoming call, edge-swipe) never reports the
    // remaining touches, and it is the one path that would otherwise skip commit() and
    // leave will-change pinned — i.e. blurry at that zoom until the viewer is reopened.
    if(e.type==='touchend'&&e.touches.length>0) return;
    pan=false;
    if(scale<=1){scale=1;tx=0;ty=0;apply();}
    endGesture();
  }
  wrap.addEventListener('touchend',settle);
  wrap.addEventListener('touchcancel',settle);

  // Mermaid settles its layout asynchronously (web fonts, foreignObject labels),
  // so take the reference size again shortly after the first frame.
  requestAnimationFrame(function(){
    var s=svgEl(); if(s){ baseStyle=s.getAttribute('style')||''; }
    measureBase();
    setTimeout(function(){ if(committed===1&&scale===1){ measureBase(); } },200);
  });

  // A rotation changes the fitted reference, so drop back to 1x and re-measure
  // instead of scaling a stale one.
  window.addEventListener('resize',function(){
    var s=svgEl(); if(!s) return;
    scale=1; committed=1; tx=0; ty=0;
    s.setAttribute('style', baseStyle);
    stage.style.transform='';
    stage.style.willChange='auto';
    measureBase();
  });
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
