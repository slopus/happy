package com.slopus.happy.ui.start

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The stills before Android 13 are the AGSL shaders word for word, in GLSL ES 1.00; ShaderStills draws them on a device. */
class ShaderStillsTest {
    @Test
    fun theSkyIsTheShaderInGlsl() = assertGlsl(glsl(GRAIN_GRADIENT_AGSL))

    @Test
    fun theCloudIsTheShaderInGlsl() {
        val cloud = glsl(LIQUID_METAL_AGSL)
        assertGlsl(cloud)
        assertTrue(cloud.contains("uniform sampler2D u_image;"))
        assertTrue(cloud.contains("evalImage(clamp(uv, 0., 1.) * FIELD)"))
    }

    private fun assertGlsl(source: String) {
        for (agsl in listOf("float2", "float3", "float4", "half", "layout(", ".eval(", "uniform shader")) {
            assertFalse("$agsl left in", Regex("\\b${Regex.escape(agsl)}").containsMatchIn(source))
        }
        assertTrue(source.contains("vec4 shade(vec2 fragCoord)"))
        assertTrue(source.contains("gl_FragColor = shade(gl_FragCoord.xy)"))
    }
}
