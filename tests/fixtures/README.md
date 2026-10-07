# Test TLS fixtures

`tls-cert.pem` / `tls-key.pem` are a test-only self-signed certificate
(CA:TRUE, SAN `IP:127.0.0.1,DNS:localhost`, 100-year validity) used by
`tests/jwks.test.js` as a local TLS trust anchor so the remote-JWKS
transport and SPKI pinning can be exercised over a real socket.

**Not a secret.** Regenerate with:

```
openssl req -x509 -newkey rsa:2048 -days 36500 -nodes \
  -keyout tls-key.pem -out tls-cert.pem \
  -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"
```
