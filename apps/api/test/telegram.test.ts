import { expect, it } from "vitest";
import { telegramConfig, verifyIdToken, verifyInitData } from "../src/telegram.ts";
import { idToken, initData, telegram, telegramJwk, testUserId } from "./telegram-fixtures.ts";

it("validates Mini App data and uses a Telegram ID beyond 32 bits", () => {
  const now = 1_800_000_000;
  const data = initData(testUserId, now - 600);
  // Verification must be independent of the order received from the WebView.
  expect(verifyInitData(data.split("&").reverse().join("&"), telegram.botToken, now)).toBe(
    testUserId,
  );
  expect(() =>
    verifyInitData(
      data.replace(String(testUserId), String(testUserId + 1)),
      telegram.botToken,
      now,
    ),
  ).toThrow("telegram_invalid");
  expect(() => verifyInitData(data, "123:another-bot", now)).toThrow("telegram_invalid");
  expect(() => verifyInitData(`${data}&auth_date=${now}`, telegram.botToken, now)).toThrow(
    "telegram_invalid",
  );
  expect(() => verifyInitData(initData(testUserId, now - 601), telegram.botToken, now)).toThrow(
    "telegram_init_expired",
  );
  expect(() => verifyInitData(initData(testUserId, now + 31), telegram.botToken, now)).toThrow(
    "telegram_invalid",
  );
  expect(() => verifyInitData(initData(2 ** 52, now), telegram.botToken, now)).toThrow(
    "telegram_invalid",
  );
});

it("uses the signed OIDC profile id and validates signature, client, issuer, nonce and expiry", () => {
  const now = 1_800_000_000;
  const valid = { iat: now - 10, exp: now + 3600 };
  const verify = (token: string) =>
    verifyIdToken(token, [telegramJwk], telegram.clientId, "fixture-nonce", now);
  const token = idToken(valid);
  expect(verify(token)).toBe(testUserId);
  const [header, payload, signature] = token.split(".");
  expect(() =>
    verify(`${header}.${payload}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`),
  ).toThrow("telegram_invalid");
  for (const claims of [
    { aud: "different-client" },
    { iss: "https://example.com" },
    { nonce: "different-attempt" },
    { nonce: undefined },
    { exp: now },
    { iat: now + 31 },
    { id: undefined },
    { id: "4294967310" },
    { sub: undefined },
  ]) {
    expect(() => verify(idToken({ ...valid, ...claims }))).toThrow("telegram_invalid");
  }
  expect(() => verify(idToken(valid, { alg: "none", kid: "test-key" }))).toThrow(
    "telegram_invalid",
  );
  expect(() => verify(idToken(valid, { alg: "RS256", kid: "different-key" }))).toThrow(
    "telegram_invalid",
  );
});

it("requires HTTPS and credentials from the same bot when Telegram is enabled", () => {
  const env = {
    TELEGRAM_BOT_TOKEN: telegram.botToken,
    TELEGRAM_BOT_USERNAME: telegram.botUsername,
    TELEGRAM_OIDC_CLIENT_ID: telegram.clientId,
    TELEGRAM_OIDC_CLIENT_SECRET: telegram.clientSecret,
  };
  expect(telegramConfig("http://localhost:5173", {})).toBeUndefined();
  expect(telegramConfig("https://cineclue.example", env)).toEqual(telegram);
  expect(() => telegramConfig("http://localhost:5173", env)).toThrow("HTTPS PUBLIC_ORIGIN");
  expect(() =>
    telegramConfig("https://cineclue.example", { ...env, TELEGRAM_OIDC_CLIENT_ID: "987654321" }),
  ).toThrow("one bot");
});
