# System Monitor drawing

Reference: Telegram Android 3de37c8 (v13.1.1),
`org/telegram/ui/Charts/LinearChartView.java:44-100`.

Telegram keeps a path/line buffer per series, maps time positions to the
viewport and insets its vertical range by half the stroke. Transitions use
canvas transforms before drawing the retained series. Happy's monitor uses
the same separation between data geometry and drawing, with paths built on
Default whenever values or the measured size change. The canvas draws those
published paths without measuring text or rebuilding geometry.

Happy iOS eda4d179e `CardDrawing.drawChart` supplies the presentation: three
one-pixel guides, 1.5 dp round strokes, light fill alpha .14, dark alpha .22,
and gaps for missing samples. Runs with only one point draw nothing. Values
stay at their original time positions across gaps; out-of-range shares
clamp to the chart. Full charts are 72 dp high; process sparklines are 44×16.

This is an independent Compose implementation. No Telegram code was copied.
The shared emulator VM uses software GL and is overloaded, so its frame-time
measurements cannot establish rendering performance.