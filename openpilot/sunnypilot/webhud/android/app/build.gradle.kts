import javax.inject.Inject

plugins {
    id("com.android.application")
}

// The page and its files ship in the APK: copied here from the repo at build time, so the app and the
// comma's bridge come from one checkout. webhud/ is one level up from android/; the third-party assets
// and the radar DBC (opendbc) sit in the repo above it.
abstract class SyncWebAssets @Inject constructor(private val fs: FileSystemOperations) : DefaultTask() {
    @get:InputDirectory abstract val staticDir: DirectoryProperty
    @get:InputDirectory abstract val threeDir: DirectoryProperty
    @get:InputDirectory abstract val modelsDir: DirectoryProperty
    @get:InputDirectory abstract val dbcDir: DirectoryProperty
    @get:InputFile abstract val radarDbc: RegularFileProperty
    @get:OutputDirectory abstract val outDir: DirectoryProperty

    @TaskAction
    fun run() {
        fs.sync {
            into(outDir.dir("www"))
            from(staticDir) { exclude("**/package.json") }
            from(threeDir) { into("vendor") }
            from(modelsDir) { into("models") }
            from(dbcDir) { into("dbc") }
            from(radarDbc) { into("dbc") }
        }
    }
}

val webhudDir = rootProject.projectDir.resolve("..")
val repoRoot = rootProject.projectDir.resolve("../../../..")
val syncWebAssets = tasks.register<SyncWebAssets>("syncWebAssets") {
    description = "Copies the HUD page, three.js, the car model and the DBCs into the APK's assets"
    staticDir.set(webhudDir.resolve("static"))
    threeDir.set(repoRoot.resolve("openpilot/third_party/webhud/three"))
    modelsDir.set(repoRoot.resolve("openpilot/third_party/webhud/models"))
    dbcDir.set(repoRoot.resolve("openpilot/third_party/webhud/dbc"))
    radarDbc.set(repoRoot.resolve("opendbc_repo/opendbc/dbc/fisker_ocean_mrr.dbc"))
    outDir.set(layout.buildDirectory.dir("generated/webhud_assets"))
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

    packaging {
        // the CAN helper ships as a .so so it installs into nativeLibraryDir, the one place an app may
        // exec from; useLegacyPackaging keeps it a real file on disk rather than mapped from the APK
        jniLibs.useLegacyPackaging = true
    }

    androidResources {
        // stored as they are, so LocalServer can stream them from a file descriptor (the model is ~25 MB)
        noCompress += listOf("glb", "js", "css", "html", "dbc", "json", "svg", "ico")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = true   // android.util.Log in code under test
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(syncWebAssets) { it.outDir }
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")   // the real org.json; android.jar only has stubs
}
