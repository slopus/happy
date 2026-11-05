These 160-pixel-wide composites are downsampled from the approved final exports,
for visual regression checks. They include the native app inside the marketing
composition, and are not standalone device artwork.

- iPhone: approved neutral-avatar set, gallery4.
- Android phone: final five-card gallery with the complete Pixel 9 frame.
- Android 7-inch tablet: gallery-7, frameless 60cqw screen.
- Android 10-inch tablet: gallery-10-large, frameless 66cqw screen.
- iPad and Duo: out4, including the complete responsive chart on Duo inner 05.

`verify.mjs` compares every rendered card against these pixels at 160 pixels wide,
with a minimum PSNR of 30 dB. The tolerance permits small mask, shader grain and
browser raster differences while detecting a wrong layout or background. Exact
native source hashes and full-size geometry are checked separately. Refresh a
reference deliberately when a newly approved design changes the composition.