import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import type { TelegramConfig } from "../src/telegram.ts";

export const telegram = {
  botToken: "123456789:fixture-token",
  botUsername: "CineClueFixtureBot",
  clientId: "123456789",
  clientSecret: "fixture-client-secret",
  redirectUri: "https://cineclue.example/api/auth/telegram/callback",
} satisfies TelegramConfig;

export const testUserId = 4_294_967_310;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const telegramJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test-key",
  alg: "RS256",
};

export function initData(id: number, authDate = Math.floor(Date.now() / 1000)) {
  const fields = {
    auth_date: String(authDate),
    query_id: "fake-query",
    signature: "telegram-also-sends-a-signature-for-third-party-validation",
    user: JSON.stringify({ id, first_name: "ゆき + Alex", username: "same_display_name" }),
  };
  const key = createHmac("sha256", "WebAppData").update(telegram.botToken).digest();
  const check = Object.entries(fields)
    .map(([field, value]) => `${field}=${value}`)
    .join("\n");
  const hash = createHmac("sha256", key).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

export function idToken(
  overrides: Record<string, unknown>,
  header = { alg: "RS256", kid: "test-key" },
) {
  const now = Math.floor(Date.now() / 1000);
  const json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = json({
    iss: "https://oauth.telegram.org",
    aud: telegram.clientId,
    sub: "9079387777332",
    nonce: "fixture-nonce",
    id: testUserId,
    iat: now,
    exp: now + 3600,
    ...overrides,
  });
  const message = `${json(header)}.${body}`;
  return `${message}.${sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url")}`;
}
