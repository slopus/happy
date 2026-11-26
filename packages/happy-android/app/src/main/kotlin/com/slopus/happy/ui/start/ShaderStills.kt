package com.slopus.happy.ui.start

import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.opengl.GLUtils
import android.util.Log
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.IntSize
import com.slopus.happy.R
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Future

/**
 * Paper's frame 0 of the sky and of the Happy Cloud mark, drawn once by
 * OpenGL ES 2 from the same AGSL sources ([glsl]) into a bitmap, for where
 * there is no runtime shader: before Android 13, or a compiler that refuses
 * AGSL. Grain and metal are the shaders' own, never a flat stand-in.
 *
 * Everything is drawn on one thread of its own, with an offscreen context
 * made the first time. [sky] and [cloud] wait for theirs: a screen's first
 * frame is late rather than drawn without it. [warmSky] starts one ahead of
 * the first screen. The last two of each are kept.
 */
internal object ShaderStills {
    private data class Sky(val size: IntSize, val palette: GrainPalette)

    private val thread = Executors.newSingleThreadExecutor { Thread(it, "happy-shader-stills") }
    private val skies = Stills<Sky>()
    private val clouds = Stills<IntSize>()
    /** Made on [thread], and only touched there. */
    private var gl: OffscreenGl? = null
    private var glFailed = false

    fun warmSky(size: IntSize, palette: GrainPalette) {
        skies.start(Sky(size, palette)) { drawSky(size, palette) }
    }

    fun sky(size: IntSize, palette: GrainPalette): Bitmap? = skies.get(Sky(size, palette)) { drawSky(size, palette) }

    fun cloud(size: IntSize, resources: Resources): Bitmap? = clouds.get(size) { drawCloud(size, resources) }

    private fun drawSky(size: IntSize, palette: GrainPalette): Bitmap? = withGl { gl ->
        gl.draw(SKY_GLSL, size, field = null) { program ->
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "u_time"), 0f)
            color(program, "u_colorBack", palette.back.toArgb())
            palette.colors.forEachIndexed { i, c -> color(program, "u_color$i", c.toArgb()) }
        }
    }

    private fun drawCloud(size: IntSize, resources: Resources): Bitmap? = withGl { gl ->
        val options = BitmapFactory.Options().apply {
            inScaled = false
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val field = BitmapFactory.decodeResource(resources, R.drawable.cloud_liquid_metal, options) ?: return@withGl null
        try {
            gl.draw(CLOUD_GLSL, size, field) { program -> GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "u_time"), 0f) }
        } finally {
            field.recycle()
        }
    }

    private fun color(program: Int, name: String, argb: Int) {
        GLES20.glUniform4f(
            GLES20.glGetUniformLocation(program, name),
            (argb shr 16 and 0xFF) / 255f, (argb shr 8 and 0xFF) / 255f, (argb and 0xFF) / 255f, (argb ushr 24) / 255f,
        )
    }

    private fun withGl(draw: (OffscreenGl) -> Bitmap?): Bitmap? {
        if (glFailed) return null
        return try {
            val made = gl ?: OffscreenGl().also { gl = it }
            draw(made)
        } catch (e: RuntimeException) {
            Log.w("ShaderStills", "Still unavailable", e)
            null
        } catch (e: LinkageError) {
            // Robolectric without native graphics.
            glFailed = true
            null
        }
    }

    /** The last two stills asked for, each drawn once on [thread]. */
    private class Stills<K> {
        private val kept = LinkedHashMap<K, Future<Bitmap?>>()

        @Synchronized
        fun start(key: K, draw: () -> Bitmap?): Future<Bitmap?> {
            kept.remove(key)?.let { kept[key] = it; return it }
            val drawn = thread.submit<Bitmap?> { draw() }
            kept[key] = drawn
            while (kept.size > 2) kept.remove(kept.keys.first())
            return drawn
        }

        fun get(key: K, draw: () -> Bitmap?): Bitmap? = try {
            start(key, draw).get()
        } catch (e: ExecutionException) {
            null
        } catch (e: InterruptedException) {
            null
        }
    }
}

/** An EGL context with no window, its 1×1 surface only there to be current; each still is drawn into a texture of its size. */
private class OffscreenGl {
    private val display: EGLDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    private val context: EGLContext
    private val surface: EGLSurface
    private val programs = HashMap<String, Int>()

    init {
        val version = IntArray(2)
        check(EGL14.eglInitialize(display, version, 0, version, 1)) { "eglInitialize" }
        val attributes = intArrayOf(
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
            EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_NONE,
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val count = IntArray(1)
        check(EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) && count[0] > 0) { "eglChooseConfig" }
        context = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
        check(context != EGL14.EGL_NO_CONTEXT) { "eglCreateContext" }
        surface = EGL14.eglCreatePbufferSurface(display, configs[0], intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
        check(surface != EGL14.EGL_NO_SURFACE) { "eglCreatePbufferSurface" }
        check(EGL14.eglMakeCurrent(display, surface, surface, context)) { "eglMakeCurrent" }
    }

    /** [fragment] over every pixel of [size], [field] bound to `u_image`; null where it can't be. */
    fun draw(fragment: String, size: IntSize, field: Bitmap?, uniforms: (Int) -> Unit): Bitmap? {
        val most = IntArray(1).also { GLES20.glGetIntegerv(GLES20.GL_MAX_TEXTURE_SIZE, it, 0) }[0]
        if (size.width <= 0 || size.height <= 0 || size.width > most || size.height > most) return null
        val program = programs.getOrPut(fragment) { link(fragment) }
        if (program == 0) return null
        val textures = IntArray(2)
        val framebuffer = IntArray(1)
        GLES20.glGenTextures(2, textures, 0)
        GLES20.glGenFramebuffers(1, framebuffer, 0)
        try {
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textures[0])
            GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, size.width, size.height, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null)
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, framebuffer[0])
            GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, textures[0], 0)
            if (GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER) != GLES20.GL_FRAMEBUFFER_COMPLETE) return null
            GLES20.glUseProgram(program)
            if (field != null) {
                GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
                GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textures[1])
                GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
                GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
                GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
                GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
                GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, field, 0)
                GLES20.glUniform1i(GLES20.glGetUniformLocation(program, "u_image"), 0)
            }
            GLES20.glUniform2f(GLES20.glGetUniformLocation(program, "u_resolution"), size.width.toFloat(), size.height.toFloat())
            uniforms(program)
            GLES20.glViewport(0, 0, size.width, size.height)
            val corners = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().put(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f))
            corners.position(0)
            val position = GLES20.glGetAttribLocation(program, "a_position")
            GLES20.glEnableVertexAttribArray(position)
            GLES20.glVertexAttribPointer(position, 2, GLES20.GL_FLOAT, false, 0, corners)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            // Rows come bottom first, which is fragCoord's top row: gl_FragCoord is the shader's fragCoord as it is.
            val pixels = ByteBuffer.allocateDirect(size.width * size.height * 4).order(ByteOrder.nativeOrder())
            GLES20.glReadPixels(0, 0, size.width, size.height, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, pixels)
            if (GLES20.glGetError() != GLES20.GL_NO_ERROR) return null
            return Bitmap.createBitmap(size.width, size.height, Bitmap.Config.ARGB_8888).also { it.copyPixelsFromBuffer(pixels) }
        } finally {
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
            GLES20.glDeleteFramebuffers(1, framebuffer, 0)
            GLES20.glDeleteTextures(2, textures, 0)
        }
    }

    private fun link(fragment: String): Int {
        val vertex = compile(GLES20.GL_VERTEX_SHADER, "attribute vec2 a_position;\nvoid main() { gl_Position = vec4(a_position, 0., 1.); }")
        val shaded = compile(GLES20.GL_FRAGMENT_SHADER, fragment)
        if (vertex == 0 || shaded == 0) return 0
        val program = GLES20.glCreateProgram()
        GLES20.glAttachShader(program, vertex)
        GLES20.glAttachShader(program, shaded)
        GLES20.glLinkProgram(program)
        val linked = IntArray(1).also { GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, it, 0) }[0]
        if (linked == 0) {
            Log.w("ShaderStills", "link: ${GLES20.glGetProgramInfoLog(program)}")
            return 0
        }
        return program
    }

    private fun compile(type: Int, source: String): Int {
        val shader = GLES20.glCreateShader(type)
        GLES20.glShaderSource(shader, source)
        GLES20.glCompileShader(shader)
        val compiled = IntArray(1).also { GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, it, 0) }[0]
        if (compiled == 0) {
            Log.w("ShaderStills", "compile: ${GLES20.glGetShaderInfoLog(shader)}")
            return 0
        }
        return shader
    }
}

/**
 * An AGSL source as GLSL ES 1.00, word for word: AGSL's vector, matrix and
 * half types to GLSL's, `layout(color)` dropped (the colours are sent as
 * they are), the mark's field read with texture2D (it is 512 a side), and
 * `main(fragCoord)` called with gl_FragCoord.
 */
internal fun glsl(agsl: String): String {
    var source = agsl.replace("layout(color) ", "")
        .replace("uniform shader u_image;", "uniform sampler2D u_image;\nvec4 evalImage(vec2 p) { return texture2D(u_image, p / 512.); }")
        .replace("u_image.eval(", "evalImage(")
    for ((from, to) in listOf("half4" to "vec4", "half3" to "vec3", "half" to "float", "float2x2" to "mat2", "float2" to "vec2", "float3" to "vec3", "float4" to "vec4")) {
        source = source.replace(Regex("\\b$from\\b"), to)
    }
    source = source.replace("vec4 main(vec2 fragCoord)", "vec4 shade(vec2 fragCoord)")
    return """
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
$source
void main() { gl_FragColor = shade(gl_FragCoord.xy); }
"""
}

private val SKY_GLSL = glsl(GRAIN_GRADIENT_AGSL)
private val CLOUD_GLSL = glsl(LIQUID_METAL_AGSL)
