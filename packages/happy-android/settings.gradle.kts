pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    // Provisions the JDK named by the Java toolchain below when the machine has
    // only a JRE (AGP needs javac and jlink).
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // tailcat-kotlin has no published artifact; tools/tailcat/build.sh builds its pinned commit here.
        maven(file("vendor/maven")) {
            content { includeGroup("io.tailcat") }
        }
        // LiveKit's audio routing dependency is published through JitPack.
        maven("https://jitpack.io") {
            content { includeModule("com.github.davidliu", "audioswitch") }
        }
    }
}

rootProject.name = "happy-android"

include(":app")
include(":crypto")
include(":elevenlabs")
project(":elevenlabs").projectDir = file("vendor/elevenlabs")
