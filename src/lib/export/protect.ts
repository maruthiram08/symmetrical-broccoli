// "Share as protected file": one self-contained HTML file whose content is encrypted with
// AES-256-GCM, the key derived from a password with PBKDF2-SHA256. WebCrypto only, in the browser
// that makes it and in the browser that opens it. No server is involved and the password is never
// stored or sent anywhere; the file holds only salt, IV and ciphertext.

export const PBKDF2_ITERATIONS = 310_000;
/** Shortest password the share dialog accepts. */
export const MIN_PASSWORD = 8;

export interface Sealed {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iter: number;
  /** base64 */
  salt: string;
  iv: string;
  ct: string;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("This browser can't encrypt (WebCrypto is missing).");
  return s;
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function keyFrom(password: string, salt: Uint8Array<ArrayBuffer>, iter: number, use: KeyUsage): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, [use]);
}

/** Encrypt text with a password. A fresh random salt and IV every time. */
export async function seal(plaintext: string, password: string, iterations = PBKDF2_ITERATIONS): Promise<Sealed> {
  if (!password) throw new Error("A password is needed.");
  if (iterations < 200_000) throw new Error("Too few PBKDF2 iterations.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt, iterations, "encrypt");
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  return { v: 1, kdf: "PBKDF2-SHA256", iter: iterations, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

/** Decrypt; throws when the password is wrong or the file was changed (GCM checks both). */
export async function unseal(s: Sealed, password: string): Promise<string> {
  const key = await keyFrom(password, fromB64(s.salt), s.iter, "decrypt");
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: fromB64(s.iv) }, key, fromB64(s.ct));
  return new TextDecoder().decode(pt);
}

/**
 * The script inside the protected file, as plain browser JavaScript (no build step touches it).
 * `dbOpen(payload, password)` resolves to the page's HTML or rejects; the rest wires the form.
 */
export const OPEN_SCRIPT = String.raw`
function dbB64(s){var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}
async function dbOpen(p,pw){
  var c=crypto.subtle;
  if(!p||p.v!==1||p.kdf!=="PBKDF2-SHA256")throw new Error("format");
  var base=await c.importKey("raw",new TextEncoder().encode(pw),"PBKDF2",false,["deriveKey"]);
  var key=await c.deriveKey({name:"PBKDF2",hash:"SHA-256",salt:dbB64(p.salt),iterations:p.iter},base,{name:"AES-GCM",length:256},false,["decrypt"]);
  var pt=await c.decrypt({name:"AES-GCM",iv:dbB64(p.iv)},key,dbB64(p.ct));
  return new TextDecoder().decode(pt);
}
if(typeof document!=="undefined"){
  var f=document.getElementById("f"),e=document.getElementById("e"),i=document.getElementById("pw"),b=document.getElementById("go");
  if(!window.crypto||!crypto.subtle){e.textContent="Open this file in a web browser (Safari, Chrome, Firefox or Edge) to read it.";b.disabled=true;}
  f.addEventListener("submit",function(ev){
    ev.preventDefault();e.textContent="";b.disabled=true;b.textContent="Opening…";
    var p=JSON.parse(document.getElementById("p").textContent);
    dbOpen(p,i.value).then(function(html){i.value="";document.open();document.write(html);document.close();},
      function(){b.disabled=false;b.textContent="Open";e.textContent="That password doesn't open this file.";i.select();});
  });
}
`;

const WRAP_CSS = `:root{--bg:#fff;--ink:#0a0a0a;--muted:#525252;--border:#8a8a8a;--late:#c4320a;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--ink:#f4f4f5;--muted:#a1a1aa;--border:#6b6b73;--late:#ff6b4a;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font:15px/22px "Instrument Sans",-apple-system,"Segoe UI",system-ui,sans-serif}
form{width:100%;max-width:360px;display:flex;flex-direction:column;gap:12px}
h1{margin:0;font-size:24px;line-height:30px;letter-spacing:-.02em;font-weight:600}
p{margin:0;color:var(--muted);font-size:14px;line-height:20px}
input{height:40px;padding:0 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--ink);font:inherit}
button{height:40px;border-radius:999px;border:1px solid var(--ink);background:var(--ink);color:var(--bg);font-family:inherit;font-size:14px;font-weight:500;cursor:pointer}
button[disabled]{opacity:.5}
#e{color:var(--late);min-height:20px}`;

/** The protected file: a password form, the sealed payload, and the script that opens it. Contains no plaintext. */
export function protectedHtml(s: Sealed): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Protected file</title>
<style>${WRAP_CSS}</style>
</head>
<body>
<form id="f" autocomplete="off">
<h1>Protected file</h1>
<p>Enter the password you were given. It is checked here, in this browser; nothing is sent anywhere.</p>
<input id="pw" type="password" aria-label="Password" placeholder="Password" required autofocus>
<button id="go" type="submit">Open</button>
<p id="e" role="alert"></p>
</form>
<script type="application/json" id="p">${JSON.stringify(s)}</script>
<script>${OPEN_SCRIPT}</script>
</body>
</html>
`;
}

/** Encrypt a whole HTML page into a protected file. */
export async function protectHtml(html: string, password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  return protectedHtml(await seal(html, password, iterations));
}

/** Why a password can't be used, or null. */
export function passwordProblem(pw: string, confirm: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw !== confirm) return "The two passwords don't match.";
  return null;
}
