plugins {
    id("com.android.application")
}

android {
    namespace = "ai.sunnypilot.webhud"
    compileSdk = 36

    defaultConfig {
        applicationId = "ai.sunnypilot.webhud"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            // sideloaded onto the car's own screen, never published: the debug key keeps installs simple
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true   // android.util.Log in code under test
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")   // the real org.json; android.jar only has stubs
}
