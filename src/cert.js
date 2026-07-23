'use strict';

// Generates a throwaway self-signed certificate at runtime so the benchmark
// exercises a real TLS + HTTP/2 handshake (that handshake is exactly the
// per-session setup cost we want to measure). Nothing sensitive is committed:
// the key/cert live under .certs/ which is gitignored, and are regenerated on
// demand.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CERT_DIR = path.join(__dirname, '..', '.certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');

function ensureCert() {
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    return read();
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });
  // openssl ships on macOS/Linux; single self-signed cert valid for localhost.
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', KEY_PATH,
      '-out', CERT_PATH,
      '-days', '365',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return read();
}

function read() {
  return {
    key: fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH),
  };
}

module.exports = { ensureCert, CERT_PATH };
