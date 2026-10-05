const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function newIdentity() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const publicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privateKey = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    publicKey: bytesToBase64Url(new Uint8Array(publicKey)),
    privateKey,
  };
}

export function getSavedIdentity(userId) {
  try {
    const raw = localStorage.getItem(`tm:identity:${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveIdentity(userId, identity) {
  localStorage.setItem(`tm:identity:${userId}`, JSON.stringify(identity));
}

export function avatarLetter(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}
