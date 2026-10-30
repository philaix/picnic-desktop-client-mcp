import PicnicClient from "picnic-api";
import { loadSession, saveSession, type CountryCode } from "./session.js";

export class NotLoggedInError extends Error {
  constructor() {
    super("Nicht bei Picnic angemeldet. Bitte den Picnic Desktop Client öffnen und dort anmelden.");
  }
}

let cached: { key: string; client: PicnicClient } | null = null;

/** Returns a client for the stored session. The session file is read on every call, so a new login is used right away. */
export function getClient(): PicnicClient {
  const session = loadSession();
  if (!session.authKey) throw new NotLoggedInError();
  const key = `${session.countryCode}:${session.deviceId}:${session.authKey}`;
  if (cached?.key !== key) {
    cached = {
      key,
      client: new PicnicClient({
        countryCode: session.countryCode,
        authKey: session.authKey,
        deviceId: session.deviceId,
      }),
    };
  }
  return cached.client;
}

/** A login waiting for its SMS code. Lives only in the desktop app's process. */
let pendingLogin: { client: PicnicClient; countryCode: CountryCode } | null = null;

export type LoginOutcome = { status: "loggedIn"; userName: string | null } | { status: "codeSent" };

export async function login(email: string, password: string, countryCode: CountryCode): Promise<LoginOutcome> {
  const client = new PicnicClient({ countryCode, deviceId: loadSession().deviceId });
  const result = await client.auth.login(email.trim(), password);
  if (result.secondFactorAuthenticationRequired) {
    pendingLogin = { client, countryCode };
    await client.auth.generate2FACode("SMS");
    return { status: "codeSent" };
  }
  return { status: "loggedIn", userName: await finishLogin(client, countryCode) };
}

export async function resendCode(): Promise<void> {
  if (!pendingLogin) throw new Error("Es läuft keine Anmeldung. Bitte erneut mit E-Mail und Passwort anmelden.");
  await pendingLogin.client.auth.generate2FACode("SMS");
}

export async function verifyCode(code: string): Promise<LoginOutcome> {
  if (!pendingLogin) throw new Error("Es läuft keine Anmeldung. Bitte erneut mit E-Mail und Passwort anmelden.");
  const { client, countryCode } = pendingLogin;
  await client.auth.verify2FACode(code.trim());
  pendingLogin = null;
  return { status: "loggedIn", userName: await finishLogin(client, countryCode) };
}

async function finishLogin(client: PicnicClient, countryCode: CountryCode): Promise<string | null> {
  let userName: string | null = null;
  try {
    const user = await client.user.getUser();
    userName = [user.firstname, user.lastname].filter(Boolean).join(" ") || null;
  } catch {
    // The name is only for display.
  }
  saveSession({
    ...loadSession(),
    countryCode,
    authKey: client.authKey,
    userName,
    loggedInAt: new Date().toISOString(),
  });
  return userName;
}

export async function logout(): Promise<void> {
  try {
    await getClient().auth.logout();
  } catch {
    // Forget the key locally even if Picnic can't be reached.
  }
  saveSession({ ...loadSession(), authKey: null, userName: null, loggedInAt: null });
}

/** Turns an error into a German message for the app and for Claude. */
export function describeError(error: unknown): string {
  if (error instanceof NotLoggedInError) return error.message;
  if (PicnicClient.isPicnicApiError(error)) {
    if (error.code === "AUTH_INVALID_CRED") return "E-Mail-Adresse oder Passwort ist falsch.";
    if (error.code === "OTP_NOT_VALID") return "Der SMS-Code ist ungültig oder abgelaufen.";
    if (error.code === "CART_CONFIRM_SLOT") return "Picnic möchte, dass du das Lieferfenster bestätigst. Bitte ein Lieferfenster auswählen und erneut bestellen.";
    if (error.status === 401)
      return "Die Picnic-Anmeldung ist abgelaufen. Bitte im Picnic Desktop Client neu anmelden.";
    if (error.status === 403 && !error.code)
      return "Picnic blockiert gerade zu viele Anfragen. Bitte kurz warten und es dann erneut versuchen.";
    const picnicText = error.message && !error.message.startsWith(String(error.status)) ? `: ${error.message}` : ".";
    return `Picnic hat mit Fehler ${error.status}${error.code ? ` (${error.code})` : ""} geantwortet${picnicText}`;
  }
  if (PicnicClient.isProductNotFoundError(error)) return "Dieses Produkt gibt es nicht oder es ist an deiner Adresse nicht verfügbar.";
  return error instanceof Error ? error.message : String(error);
}

export function isSessionExpired(error: unknown): boolean {
  return PicnicClient.isPicnicApiError(error) && error.status === 401;
}
