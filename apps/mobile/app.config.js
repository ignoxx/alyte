const { withEntitlementsPlist } = require('@expo/config-plugins');

const variants = {
  development: {
    name: 'Alyte Development',
    bundleIdentifier: 'com.alyte.app.dev',
  },
  preview: {
    name: 'Alyte Preview',
    bundleIdentifier: 'com.alyte.app.preview',
  },
  production: {
    name: 'Alyte',
    bundleIdentifier: 'com.alyte.app',
  },
};
const localization = require('./src/localization/en.json');
const faceIDPermission = localization.settings.appLock.faceIDPermission;

function withoutAppleSignInEntitlement(config) {
  return withEntitlementsPlist(config, (entitlementsConfig) => {
    delete entitlementsConfig.modResults['com.apple.developer.applesignin'];
    return entitlementsConfig;
  });
}

module.exports = ({ config }) => {
  const requestedVariant = process.env.APP_VARIANT;
  const variant = requestedVariant ?? 'development';
  if (!variants[variant]) {
    throw new Error(`Unknown APP_VARIANT: ${variant}`);
  }
  const selected = variants[variant];

  return {
    ...config,
    name: selected.name,
    slug: 'alyte',
    version: '0.1.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    scheme: `alyte-${variant}`,
    ios: {
      ...config.ios,
      bundleIdentifier: selected.bundleIdentifier,
      deploymentTarget: '26.0',
      supportsTablet: false,
      // Personal-team development builds cannot provision Sign in with Apple. Cloud/account
      // surfaces are not part of the local development journey, so retain the entitlement only
      // for distribution variants that can exercise those flows.
      usesAppleSignIn: variant !== 'development',
      entitlements: {
        ...config.ios?.entitlements,
      },
      infoPlist: {
        ...config.ios?.infoPlist,
        NSCameraUsageDescription:
          'Alyte uses the camera to save an Intake Image on this iPhone when you tap Snap.',
        NSPhotoLibraryUsageDescription:
          'Alyte uses Photos only when you choose an existing image for an Intake Event.',
        NSFaceIDUsageDescription: faceIDPermission,
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    extra: {
      ...config.extra,
      variant,
      apiEnvironment: variant === 'production' ? 'production' : 'none',
      showcaseAllowed: variant !== 'production',
    },
    plugins: [
      'expo-image',
      [
        'expo-local-authentication',
        {
          faceIDPermission,
        },
      ],
      ...(variant === 'development' ? ['expo-dev-client'] : []),
      ...(variant === 'development' ? [withoutAppleSignInEntitlement] : []),
    ],
  };
};
