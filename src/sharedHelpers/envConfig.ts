import Config from "react-native-config";
import { getEnvironmentOverride } from "sharedHelpers/installData";

// Add a new prefix here (and the matching <PREFIX>_* vars in .env) to make
// another baked-in environment selectable from the Developer screen.
export const ENVIRONMENTS = ["STAGING", "STAGING_LITE"];

const RUNTIME_ENV_KEYS = [
  "API_URL",
  "OAUTH_API_URL",
  "JWT_ANONYMOUS_API_SECRET",
  "IOS_OAUTH_CLIENT_ID",
  "IOS_OAUTH_CLIENT_SECRET",
  "ANDROID_OAUTH_CLIENT_ID",
  "ANDROID_OAUTH_CLIENT_SECRET",
] as const;

type RuntimeEnvKey = typeof RUNTIME_ENV_KEYS[number];

// Only offer environments in the Developer screen whose full set of
// prefixed vars is actually baked into this build
export function getAvailableEnvironments(): string[] {
  return ENVIRONMENTS.filter( prefix => RUNTIME_ENV_KEYS.every(
    key => !!Config[`${prefix}_${key}`],
  ) );
}

// .env files written before the per-platform OAuth split only define these
const LEGACY_ENV_KEYS: Partial<Record<RuntimeEnvKey, string>> = {
  IOS_OAUTH_CLIENT_ID: "OAUTH_CLIENT_ID",
  IOS_OAUTH_CLIENT_SECRET: "OAUTH_CLIENT_SECRET",
  ANDROID_OAUTH_CLIENT_ID: "OAUTH_CLIENT_ID",
  ANDROID_OAUTH_CLIENT_SECRET: "OAUTH_CLIENT_SECRET",
};

function resolveEnvValue( key: string ): string | undefined {
  const environmentOverridePrefix = getEnvironmentOverride();
  if ( !environmentOverridePrefix ) return Config[key];
  return Config[`${environmentOverridePrefix}_${key}`] || Config[key];
}

// Computed once when the JS bundle loads. Every environment switch ends in
// RNRestart.restart(), which re-evaluates this module, so it's safe to
// resolve these once here rather than read them dynamically everywhere.
export const EnvConfig = RUNTIME_ENV_KEYS.reduce( ( acc, key ) => {
  const legacyKey = LEGACY_ENV_KEYS[key];
  acc[key] = resolveEnvValue( key ) || ( legacyKey && resolveEnvValue( legacyKey ) );
  return acc;
}, {} as Record<RuntimeEnvKey, string | undefined> );
