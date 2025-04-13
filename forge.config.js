const { version } = require("./package.json");

module.exports = {
    name: "Audio Mixer",
    version: `${version}`,
    description: "Little audio mixer I made for fun, for my love.",
    author: "Luna",
    main: "main.js",
    productName: "Lunas Audio Mixer",
    executableName: "AudioMixer",
    scripts: {
      make: "electron-forge make",
      start: "electron ."
    },
    packagerConfig: {
      name: "AudioMixer",
      executableName: "AudioMixer",
      appBundleId: "dev.imluna.audio-mixer",
      icon: "./assets/icon",
      asar: {
        unpack: "**/*.json"
      },
      ignore: [
        "config.json"
      ]
    },
    rebuildConfig: {},
    makers: [
        {
            name: "@electron-forge/maker-squirrel",
            platforms: ["win32"],
            config: {
                name: "AudioMixer",
                setupExe: `Lunas Audio Mixer Installer ${version}.exe`,
                setupIcon: "./assets/icon.ico",
                iconUrl: "file://C:/Users/luna/Documents/Git/Audio-Mixer/assets/icon.ico",
                Icon: "./assets/icon.ico",
                authors: "Luna",
                exe: "AudioMixer.exe",
                noMsi: true, 
                shortcutFolderName: "Audio Mixer",
                setupShortcut: true,
                shortcutName: "Audio Mixer",
                loadingGif: "./assets/installer-loading.gif",
                createDesktopShortcut: true,
                createStartMenuShortcut: true,
                keepUserData: true,
                noFirstRun: true
            }
        },
        {
            name: "@electron-forge/maker-zip",
            platforms: ["win32"]
        }
    ],
    build: {
      appId: "dev.imluna.audio-mixer",
      productName: "Audio Mixer",
      asar: {
        unpack: "**/*.json"
      },
      files: [
        "**/*",
        "!config.json"
      ],
      directories: {
        output: "dist"
      },
      ignore: [
        "node_modules/.cache",
        "node_modules/electron",
        "node_modules/electron-rebuild",
        "node_modules/@electron-forge/*"
      ]
    },
    plugins: [
        {
            name: "@electron-forge/plugin-auto-unpack-natives",
            config: {}
        }
    ]
};
