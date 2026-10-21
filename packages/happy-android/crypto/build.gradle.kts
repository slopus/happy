import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Plain JVM module: the crypto layer has no Android dependencies, so its
// tests run on the host JVM without Robolectric.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    jvmToolchain(libs.versions.java.toolchain.get().toInt())
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    api(libs.kotlinx.serialization.json)
    implementation(libs.bouncycastle.prov)

    testImplementation(libs.junit)
}
