const gl = document.createElement("canvas").getContext("webgl", { antialias: false });
if (gl) {
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = n => gl.getUniformLocation(prog, n);
  const uRes = U("uRes"), uTime = U("uTime"), uSeed = U("uSeed"), uc = ["c0", "c1", "c2", "c3"].map(U);

  const scale = Math.min(window.devicePixelRatio || 1, 1.5);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const io = new IntersectionObserver(entries => {
    for (const e of entries) { const it = items.find(i => i.el === e.target); it.visible = e.isIntersecting; }
  });
  items.forEach(it => io.observe(it.el));

  function draw(it, time) {
    const w = Math.round(it.el.clientWidth * scale), h = Math.round(it.el.clientHeight * scale);
    if (!w || !h) return;
    if (it.canvas.width !== w || it.canvas.height !== h) { it.canvas.width = w; it.canvas.height = h; it.ctx = null; }
    if (gl.canvas.width < w || gl.canvas.height < h) {
      gl.canvas.width = Math.max(gl.canvas.width, w);
      gl.canvas.height = Math.max(gl.canvas.height, h);
    }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uRes, w, h);
    gl.uniform1f(uTime, time);
    gl.uniform1f(U("uGrain"), window.shaderGrain ?? 1);
    gl.uniform1f(uSeed, it.card.seed);
    it.card.pal.forEach((c, i) => gl.uniform3fv(uc[i], hex(c)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    it.ctx = it.ctx || it.canvas.getContext("2d");
    it.ctx.drawImage(gl.canvas, 0, gl.canvas.height - h, w, h, 0, 0, w, h);
  }

  window.paint = (time = 20) => {
    for (const it of items) {
      const slot = it.el.closest('.slot');
      if ((slot || it.el).classList.contains('away')) continue;
      if (!it.el.closest('.row').classList.contains('on')) continue;
      draw(it, time);
    }
  };
} else { throw new Error('WebGL unavailable'); }
