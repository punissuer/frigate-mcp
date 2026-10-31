import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FrigateClient } from '../src/frigate.js';
import { startFixture } from './helpers/fixture.js';

const PASSWORD = 'sup3r-secret-password';

/**
 * A self-signed certificate shaped like Frigate's default one: a wildcard
 * common name and no subject alternative name. Such a certificate can never
 * match a host name, so it can only be used by trusting the exact certificate.
 */
function selfSignedCertificate(): { dir: string; key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'frigate-mcp-tls-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    '-days', '1', '-subj', '/CN=*',
  ], { stdio: 'ignore' });
  return { dir, key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}

test('a self-signed certificate is trusted only when it is pinned', async t => {
  let material: ReturnType<typeof selfSignedCertificate>;
  try { material = selfSignedCertificate(); }
  catch { t.skip('openssl is unavailable in this environment'); return; }
  const fixture = await startFixture({
    requireAuth: true,
    credentials: { user: 'viewer', password: PASSWORD },
    tls: { key: material.key, cert: material.cert },
  });
  const base = { apiRoot: fixture.apiRoot, allowInsecureHttp: true, username: 'viewer', password: PASSWORD };
  try {
    const untrusted = await new FrigateClient(base).status();
    assert.equal(untrusted.ok, false);
    assert.equal(untrusted.error?.code, 'untrusted_certificate');
    assert.match(untrusted.error?.message ?? '', /FRIGATE_CA_CERT_FILE/);

    const trustedButWrongHost = await new FrigateClient({ ...base, caCertFile: join(material.dir, 'cert.pem') }).status();
    assert.equal(trustedButWrongHost.ok, false);
    assert.equal(trustedButWrongHost.error?.code, 'certificate_mismatch');
    assert.match(trustedButWrongHost.error?.message ?? '', /FRIGATE_TLS_PIN_CERT_FILE/);

    const pinned = await new FrigateClient({ ...base, tlsPinCertFile: join(material.dir, 'cert.pem') }).status();
    assert.equal(pinned.ok, true);
    assert.equal(pinned.data.authorizedApiAccess, 'confirmed');
  } finally {
    await fixture.close();
  }
});

test('a login is followed by an authenticated read, and the credential never leaks', async () => {
  const fixture = await startFixture({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } });
  try {
    const client = new FrigateClient({ apiRoot: fixture.apiRoot, allowInsecureHttp: true, username: 'viewer', password: PASSWORD });
    const status = await client.status();
    assert.equal(status.ok, true);
    assert.equal(status.data.authorizedApiAccess, 'confirmed');

    // The session is established once and reused: the login request carries the
    // password in its body, and every later read carries the session cookie.
    const logins = fixture.requests.filter(request => request.path === '/nvr/api/login');
    assert.equal(logins.length, 1);
    assert.equal(logins[0]?.method, 'POST');
    assert.equal(logins[0]?.authorization, undefined, 'the password must not travel in a header');
    const version = fixture.requests.find(request => request.path === '/nvr/api/version');
    assert.match(version?.cookie ?? '', /frigate_token=/, 'the protected read must carry the session cookie');
    const serialized = JSON.stringify(status);
    assert.doesNotMatch(serialized, new RegExp(PASSWORD));
    assert.doesNotMatch(serialized, /frigate_token/);
  } finally {
    await fixture.close();
  }
});

test('an invalid password fails with an actionable error and no retry loop', async () => {
  const fixture = await startFixture({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } });
  try {
    const client = new FrigateClient({ apiRoot: fixture.apiRoot, allowInsecureHttp: true, username: 'viewer', password: 'not-the-password' });
    const status = await client.status();
    assert.equal(status.ok, false);
    assert.equal(status.error?.code, 'authentication');
    assert.doesNotMatch(status.error?.message ?? '', /not-the-password/);
    assert.equal(fixture.requests.filter(request => request.path === '/nvr/api/login').length, 1);
  } finally {
    await fixture.close();
  }
});
