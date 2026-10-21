# kotlinx.serialization: keep generated serializers for @Serializable classes.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers @kotlinx.serialization.Serializable class com.slopus.happy.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class com.slopus.happy.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# BouncyCastle is used through its low-level classes only; R8 strips the rest.
-dontwarn org.bouncycastle.**
