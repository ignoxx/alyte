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

module.exports = ({ config }) => {
  const requestedVariant = process.env.APP_VARIANT ?? 'development';
  const variant = variants[requestedVariant] ? requestedVariant : 'development';
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
      supportsTablet: false,
      infoPlist: {
        ...config.ios?.infoPlist,
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    extra: {
      ...config.extra,
      variant,
      apiEnvironment: variant === 'production' ? 'production' : 'none',
      showcaseAllowed: variant !== 'production',
    },
    plugins: ['expo-dev-client'],
  };
};
