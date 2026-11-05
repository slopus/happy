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

# Navigation's typed enum arguments load the class by the serializer's original
# name (including nested enums), then inspect its constants. Keeping serializer()
# alone doesn't preserve that name, and breaks graph construction after R8.
-keep @kotlinx.serialization.Serializable enum com.slopus.happy.** {
    *;
}

# BouncyCastle is used through its low-level classes only; R8 strips the rest.
-dontwarn org.bouncycastle.**
