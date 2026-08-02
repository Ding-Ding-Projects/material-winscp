// forge.config.js — Electron Forge packaging and installer configuration.
//
// `npm run make` produces, under out/make/:
//   squirrel.windows/x64/WinSCP Material-<version> Setup.exe   the real installer
//   squirrel.windows/x64/winscp_material-<version>-full.nupkg  the update package
//   squirrel.windows/x64/RELEASES                              the update manifest
//   zip/win32/x64/WinSCP Material-win32-x64-<version>.zip      a portable archive
//
// The Setup.exe is a genuine Squirrel.Windows installer: running it installs
// into %LOCALAPPDATA%\WinSCPMaterial, creates the shortcuts that
// design/main/squirrel.js asks Update.exe for, and registers the app for
// Add/Remove Programs.
'use strict';

const path = require('path');
const fs = require('fs');

const pkg = require('./package.json');

/** Windows icon, produced by `node build/make-icon.js` from the tracked vector
 *  application logo. Missing icon is a warning, never a build failure. */
const ICON_ICO = path.join(__dirname, 'build', 'icon.ico');
const hasIcon = fs.existsSync(ICON_ICO);
if (!hasIcon) {
  console.warn('[forge] build/icon.ico is missing — run `node build/make-icon.js`. Building without a custom icon.');
}

/** Squirrel needs a package id without spaces; humans get the pretty title. */
const APP_ID = 'winscp_material';
const EXE_NAME = 'WinSCPMaterial';
const REPO = 'https://github.com/Ding-Ding-Projects/material-winscp';

module.exports = {
  packagerConfig: {
    name: pkg.productName,
    executableName: EXE_NAME,
    appBundleId: 'com.dingdingprojects.winscp-material',
    appCategoryType: 'public.app-category.utilities',
    appCopyright: `Copyright (c) ${new Date().getUTCFullYear()} ${pkg.author}. Licensed under ${pkg.license}.`,
    ...(hasIcon ? { icon: path.join(__dirname, 'build', 'icon') } : {}),

    // Ship the app and its runtime dependencies; leave development-only trees,
    // the porting reference and the documentation site out of the installer.
    ignore: [
      /^\/\.git($|\/)/,
      /^\/\.github($|\/)/,
      /^\/vendor($|\/)/,
      /^\/test($|\/)/,
      /^\/docs($|\/)/,
      /^\/site($|\/)/,
      /^\/out($|\/)/,
      /^\/build\/make-icon\.js$/,
      /^\/design\/uploads($|\/)/,
      /^\/design\/screenshots($|\/)/,
      /^\/\.gitignore$/,
      /^\/\.gitmodules$/,
      /^\/\.gitattributes$/,
      /^\/forge\.config\.js$/,
      /^\/(README|AGENTS|ROADMAP|HANDOFF|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT)\.md$/,
    ],

    // The renderer is plain ES modules and the main process is CommonJS, so
    // there is nothing to prune beyond npm's own production resolution.
    prune: true,
    derefSymlinks: true,
    asar: {
      // design/assets holds the bundled dim sum photographs. They stay inside
      // the asar: they are read through the app's own module, never by an
      // external process.
      unpack: '**/node_modules/{ssh2,cpu-features}/**/*.node',
    },
  },

  rebuildConfig: {},

  makers: [
    {
      // The real Windows installer.
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: APP_ID,
        title: pkg.productName,
        exe: `${EXE_NAME}.exe`,
        setupExe: `${pkg.productName} ${pkg.version} Setup.exe`,
        authors: pkg.author,
        owners: pkg.author,
        description: pkg.description,
        copyright: `Copyright (c) ${new Date().getUTCFullYear()} ${pkg.author}`,
        // No MSI: Squirrel's own Setup.exe is what users run.
        noMsi: true,
        // Add/Remove Programs reads the icon from this URL; the local .ico is
        // what gets stamped into the executables.
        iconUrl: `${REPO}/raw/main/build/icon.ico`,
        ...(hasIcon ? { setupIcon: ICON_ICO } : {}),
        // No loadingGif is bundled. Squirrel then shows its default install
        // animation, which is correct behaviour rather than a missing asset.
      },
    },
    {
      // A portable archive for users who cannot or will not run an installer.
      name: '@electron-forge/maker-zip',
      platforms: ['win32', 'darwin', 'linux'],
    },
  ],

  plugins: [],

  // Publishing is done by .github/workflows/ci.yml with the `gh` CLI so the
  // release notes can carry the dim sum code name and photo. No Forge publisher
  // is configured, deliberately.
  publishers: [],
};
