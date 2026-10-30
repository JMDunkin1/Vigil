export function validatePushEnvironment(value: string): "off" | "development" | "production";
export function verifyPushSigning(options: { requested: string; signed?: string; provisioned?: string; bundleIdentifier: string; applicationIdentifier?: string }): string;
export function writePushEntitlements(options: { destination: string; base: string; environment: string }): Promise<void>;
