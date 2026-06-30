'use strict';

// Ad-hoc code-sign the macOS app after packing.
//
// We don't have an Apple Developer certificate in CI, but Apple Silicon
// refuses to launch an arm64 app with no signature at all — Finder reports it
// as "damaged and can't be opened". An ad-hoc signature (`codesign --sign -`)
// satisfies that requirement so the app launches (users still clear Gatekeeper
// quarantine once, since it isn't notarized). Runs before the .dmg/.zip are
// built, so the packaged artifacts contain the signed app.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  });
};
